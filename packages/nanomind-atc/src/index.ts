/**
 * @nanomind/atc — ATC Intent Handler
 *
 * Thin wrapper around the Registry ATC API. Handles authentication,
 * caching, and plain-English formatting of ATC data.
 *
 * Does NOT use language model inference — uses structured data formatting.
 */

const DEFAULT_REGISTRY_URL = 'https://api.oa2a.org';
const DEFAULT_TIMEOUT_MS = 10 * 1000;

export interface ATCSummary {
  agentId: string;
  trustLevel: number;
  trustScore: number;
  version: string;
  expiresAt: string;
  issuerDid: string;
  signatureCount: number;
  scanSummary: {
    hma: string;
    criticalFindings: number;
    highFindings: number;
  } | null;
}

export interface ATCExplanation {
  agentId: string;
  currentLevel: number;
  currentScore: number;
  factors: ATCFactor[];
  projectedLevel: number;
  projectedScore: number;
  summary: string;
}

export interface ATCFactor {
  name: string;
  status: 'present' | 'missing' | 'partial';
  impact: string;
  fix: string;
}

export interface ATCConfig {
  registryUrl?: string;
  apiKey?: string;
  cacheTTLMs?: number;
  /**
   * How long a lookup waits for the registry's whole answer, body included,
   * in milliseconds. Defaults to 10 seconds.
   */
  timeoutMs?: number;
}

/**
 * A lookup the registry could not answer: it answered with an error status
 * other than 404, or with a body that could not be read as JSON, or it could
 * not be reached, or it did not finish its answer within the timeout. Such a
 * lookup says nothing about whether the registry has an ATC for the agent; a
 * 404 is the registry's answer that it has none. The message names the agent,
 * the registry address and the reason.
 */
export class ATCLookupError extends Error {
  readonly agentId: string;
  readonly registryUrl: string;
  /** The status the registry answered with; undefined when it was not reached. */
  readonly status: number | undefined;

  constructor(agentId: string, registryUrl: string, reason: string, status?: number, cause?: unknown) {
    super(
      `Could not look up agent "${agentId}": the registry at ${registryUrl} ${reason}.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ATCLookupError';
    this.agentId = agentId;
    this.registryUrl = registryUrl;
    this.status = status;
  }
}

// Why a request failed: the error's message, then the message of the error
// that caused it, or its code when that message is empty. For a request that
// does not reach the server, Node's fetch throws "fetch failed" and keeps the
// reason in the cause.
function failureReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  const detail = cause instanceof Error ? cause.message || (cause as NodeJS.ErrnoException).code : undefined;
  return detail ? `${err.message}: ${detail}` : err.message;
}

// A timeout in words: "10 seconds", "1 second", "0.1 seconds".
function inSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export class ATCIntentHandler {
  private registryUrl: string;
  private apiKey: string | undefined;
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private cacheTTL: number;
  private timeoutMs: number;

  constructor(config: ATCConfig = {}) {
    this.registryUrl = config.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.apiKey = config.apiKey;
    this.cacheTTL = config.cacheTTLMs ?? 5 * 60 * 1000; // 5 min default
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * TRUST_QUERY intent — get trust level of an agent. Returns null when the
   * registry answers 404, that it has no ATC for the agent, and throws an
   * ATCLookupError when the registry could not answer.
   */
  async getTrustLevel(agentId: string): Promise<ATCSummary | null> {
    const atc = await this.fetchATC(agentId);
    if (!atc) return null;

    return {
      agentId: atc.agentId,
      trustLevel: atc.trustLevel,
      trustScore: atc.trustScore,
      version: atc.version,
      expiresAt: atc.expiresAt,
      issuerDid: atc.issuerDid,
      signatureCount: atc.signatures?.length ?? 0,
      scanSummary: atc.scanSummary ?? null,
    };
  }

  /**
   * ATC_STATUS intent — explain WHY the trust level is what it is.
   * This is the most important method. Produces plain-English explanation
   * with specific remediation steps. An agent the registry has no ATC for
   * gets a summary of how to get started; a lookup the registry could not
   * answer throws an ATCLookupError instead.
   */
  async explainTrustLevel(agentId: string): Promise<ATCExplanation> {
    const atc = await this.fetchATC(agentId);

    const factors: ATCFactor[] = [];
    // Points of the factors the agent already has, and of the ones its fixes would add.
    let presentPoints = 0;
    let missingPoints = 0;

    // Factor 1: HMA scan
    if (atc?.scanSummary?.hma === 'passed') {
      factors.push({
        name: 'HMA scan',
        status: 'present',
        impact: '+160 pts vulnerability surface',
        fix: '',
      });
      presentPoints += 160;
    } else {
      factors.push({
        name: 'HMA scan',
        status: atc?.scanSummary?.hma ? 'partial' : 'missing',
        impact: '+160 pts vulnerability surface',
        fix: 'Run: hackmyagent secure . (fix all findings, then re-scan)',
      });
      missingPoints += 160;
    }

    // Factor 2: Build attestation
    if (atc?.buildAttestation) {
      factors.push({
        name: 'Build attestation',
        status: 'present',
        impact: '+80 pts supply chain',
        fix: '',
      });
      presentPoints += 80;
    } else {
      factors.push({
        name: 'Build attestation',
        status: 'missing',
        impact: '+80 pts supply chain',
        fix: 'Add opena2a/build-action to your CI pipeline.\n         Run: opena2a > "add OpenA2A to my pipeline"',
      });
      missingPoints += 80;
    }

    // Factor 3: Publisher verified
    if (atc?.publisherDid) {
      factors.push({
        name: 'Publisher verified',
        status: 'present',
        impact: '+40 pts identity governance',
        fix: '',
      });
      presentPoints += 40;
    } else {
      factors.push({
        name: 'Publisher verified',
        status: 'missing',
        impact: '+40 pts identity governance',
        fix: 'Verify your publisher identity at registry.opena2a.org/auth/github',
      });
      missingPoints += 40;
    }

    // Factor 4: Behavioral data
    if (atc?.behavioralProfile) {
      factors.push({
        name: 'Runtime behavioral data',
        status: 'present',
        impact: '+150 pts runtime behavior',
        fix: '',
      });
      presentPoints += 150;
    } else {
      factors.push({
        name: 'Runtime behavioral data',
        status: 'missing',
        impact: '+150 pts runtime behavior',
        fix: 'Install ARP alongside your agent.\n         Run: npm install @opena2a/arp',
      });
      missingPoints += 150;
    }

    // Factor 5: Signatures
    const sigCount = atc?.signatures?.length ?? 0;
    if (sigCount >= 2) {
      factors.push({
        name: 'Threshold signatures',
        status: 'present',
        impact: '+70 pts cryptographic proof',
        fix: '',
      });
      presentPoints += 70;
    } else {
      factors.push({
        name: 'Threshold signatures',
        status: sigCount > 0 ? 'partial' : 'missing',
        impact: '+70 pts cryptographic proof',
        fix: 'Automatic — the registry signs with threshold keys on ATC issuance',
      });
      missingPoints += 70;
    }

    const currentLevel = atc?.trustLevel ?? 0;
    const currentScore = atc?.trustScore ?? 0;
    const projectedScore = presentPoints + missingPoints;
    const projectedLevel = projectedScore >= 500 ? 4 : projectedScore >= 300 ? 3 : projectedScore >= 100 ? 2 : 1;

    const missingFactors = factors.filter(f => f.status !== 'present');
    const summary = atc
      ? `Your agent ${agentId} is trust level ${currentLevel} because:\n` +
        factors.map(f => {
          if (f.status === 'present') return `  Present: ${f.name} (${f.impact})`;
          return `  Missing: ${f.name} (${f.impact})\n    Fix: ${f.fix}`;
        }).join('\n') +
        `\n  Projected level ${projectedLevel} after fixes: ${projectedScore} pts` +
        ` (${presentPoints} present + ${missingPoints} from fixes)`
      : `No ATC found for agent ${agentId}. To get started:\n` +
        '  1. Register your package at registry.opena2a.org\n' +
        '  2. Run: hackmyagent secure .\n' +
        '  3. Add opena2a/build-action to your CI pipeline';

    return {
      agentId,
      currentLevel,
      currentScore,
      factors,
      projectedLevel,
      projectedScore,
      summary,
    };
  }

  /**
   * Fetch ATC from Registry (with caching). Returns null when the registry
   * answers 404, and throws an ATCLookupError when it could not answer,
   * including when its answer is not complete within the timeout. Only an
   * ATC is cached, so the next call asks the registry again after either.
   */
  private async fetchATC(agentId: string): Promise<any | null> {
    const cacheKey = `atc:${agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // Phase 2 of the ATC to ATX rename: the registry publishes the
    // verifier surface under /api/v1/atx/* as the primary path with
    // /api/v1/atc/* as a deprecated alias that returns RFC 8594
    // Sunset headers. Switching here drops this client off the
    // legacy-path metric well before Phase 3 removal.
    const url = `${this.registryUrl}/api/v1/atx/${encodeURIComponent(agentId)}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // The signal also ends the read of the body, so a registry that takes the
    // request and sends nothing, or stops partway through the body, cannot
    // leave the lookup pending.
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (err) {
      if (signal.aborted) {
        throw new ATCLookupError(agentId, this.registryUrl, `did not answer within ${inSeconds(this.timeoutMs)}`, undefined, err);
      }
      throw new ATCLookupError(agentId, this.registryUrl, `could not be reached (${failureReason(err)})`, undefined, err);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ATCLookupError(agentId, this.registryUrl, `answered with status ${response.status}`, response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      if (signal.aborted) {
        throw new ATCLookupError(
          agentId,
          this.registryUrl,
          `answered with status ${response.status} but did not finish its answer within ${inSeconds(this.timeoutMs)}`,
          response.status,
          err,
        );
      }
      throw new ATCLookupError(
        agentId,
        this.registryUrl,
        `answered with status ${response.status} and a body that could not be read as JSON`,
        response.status,
        err,
      );
    }
    this.cache.set(cacheKey, { data, expiresAt: Date.now() + this.cacheTTL });
    return data;
  }
}

export default ATCIntentHandler;
