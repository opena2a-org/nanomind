/**
 * @nanomind/atc — ATC Intent Handler
 *
 * Thin wrapper around the Registry ATC API. Handles authentication,
 * caching, and plain-English formatting of ATC data.
 *
 * Does NOT use language model inference — uses structured data formatting.
 */

const DEFAULT_REGISTRY_URL = 'https://api.oa2a.org';

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
}

export class ATCIntentHandler {
  private registryUrl: string;
  private apiKey: string | undefined;
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private cacheTTL: number;

  constructor(config: ATCConfig = {}) {
    this.registryUrl = config.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.apiKey = config.apiKey;
    this.cacheTTL = config.cacheTTLMs ?? 5 * 60 * 1000; // 5 min default
  }

  /**
   * TRUST_QUERY intent — get trust level of an agent.
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
   * with specific remediation steps.
   */
  async explainTrustLevel(agentId: string): Promise<ATCExplanation> {
    const atc = await this.fetchATC(agentId);

    const factors: ATCFactor[] = [];
    let projectedScore = 0;

    // Factor 1: HMA scan
    if (atc?.scanSummary?.hma === 'passed') {
      factors.push({
        name: 'HMA scan',
        status: 'present',
        impact: '+160 pts vulnerability surface',
        fix: '',
      });
      projectedScore += 160;
    } else {
      factors.push({
        name: 'HMA scan',
        status: atc?.scanSummary?.hma ? 'partial' : 'missing',
        impact: '+160 pts vulnerability surface',
        fix: 'Run: hackmyagent secure . (fix all findings, then re-scan)',
      });
    }

    // Factor 2: Build attestation
    if (atc?.buildAttestation) {
      factors.push({
        name: 'Build attestation',
        status: 'present',
        impact: '+80 pts supply chain',
        fix: '',
      });
      projectedScore += 80;
    } else {
      factors.push({
        name: 'Build attestation',
        status: 'missing',
        impact: '+80 pts supply chain',
        fix: 'Add opena2a/build-action to your CI pipeline.\n         Run: opena2a > "add OpenA2A to my pipeline"',
      });
    }

    // Factor 3: Publisher verified
    if (atc?.publisherDid) {
      factors.push({
        name: 'Publisher verified',
        status: 'present',
        impact: '+40 pts identity governance',
        fix: '',
      });
      projectedScore += 40;
    } else {
      factors.push({
        name: 'Publisher verified',
        status: 'missing',
        impact: '+40 pts identity governance',
        fix: 'Verify your publisher identity at registry.opena2a.org/auth/github',
      });
    }

    // Factor 4: Behavioral data
    if (atc?.behavioralProfile) {
      factors.push({
        name: 'Runtime behavioral data',
        status: 'present',
        impact: '+150 pts runtime behavior',
        fix: '',
      });
      projectedScore += 150;
    } else {
      factors.push({
        name: 'Runtime behavioral data',
        status: 'missing',
        impact: '+150 pts runtime behavior',
        fix: 'Install ARP alongside your agent.\n         Run: npm install @opena2a/arp',
      });
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
      projectedScore += 70;
    } else {
      factors.push({
        name: 'Threshold signatures',
        status: sigCount > 0 ? 'partial' : 'missing',
        impact: '+70 pts cryptographic proof',
        fix: 'Automatic — the registry signs with threshold keys on ATC issuance',
      });
    }

    const currentLevel = atc?.trustLevel ?? 0;
    const currentScore = atc?.trustScore ?? 0;
    const projectedLevel = projectedScore >= 500 ? 4 : projectedScore >= 300 ? 3 : projectedScore >= 100 ? 2 : 1;

    const missingFactors = factors.filter(f => f.status !== 'present');
    const summary = atc
      ? `Your agent ${agentId} is trust level ${currentLevel} because:\n` +
        factors.map(f => {
          if (f.status === 'present') return `  Present: ${f.name} (${f.impact})`;
          return `  Missing: ${f.name} (${f.impact})\n    Fix: ${f.fix}`;
        }).join('\n') +
        `\n  Projected level ${projectedLevel} after fixes: ${projectedScore} pts`
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
   * Fetch ATC from Registry (with caching).
   */
  private async fetchATC(agentId: string): Promise<any | null> {
    const cacheKey = `atc:${agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
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

      const response = await fetch(url, { headers });
      if (!response.ok) return null;

      const data = await response.json();
      this.cache.set(cacheKey, { data, expiresAt: Date.now() + this.cacheTTL });
      return data;
    } catch {
      return null;
    }
  }
}

export default ATCIntentHandler;
