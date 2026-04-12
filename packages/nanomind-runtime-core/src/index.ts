/**
 * @nanomind/runtime-core - RuntimeTwin behavioral anomaly scorer.
 *
 * RuntimeTwin is the L1 behavioral anomaly layer in the three-tier ARP
 * intelligence stack. Each ARP event flows through the twin on a
 * non-blocking path: L0 rule-based classification answers immediately,
 * the twin computes an anomaly score in parallel over the agent's
 * baseline, and L2 LLM-assisted assessment runs for a small fraction of
 * flagged events.
 *
 * Three-tier ARP model:
 *   L0: Rule-based (EventEngine)            microseconds, every event
 *   L1: RuntimeTwin behavioral twin         milliseconds, this module
 *   L2: Claude or local LLM intelligence    seconds, budget-controlled
 *
 * This package defines:
 *   - RuntimeTwin class: constructor, attach hook, processEvent,
 *     scoreARPEvent (readonly path for the coordinator IPC),
 *     gradient accumulation and fleet submission.
 *   - The minimal ARPEvent shape the twin requires. Mirrors the ARPEvent
 *     type in hackmyagent/src/arp/types.ts. The twin intentionally does
 *     not import that type so the package stays free of hackmyagent
 *     coupling (per audit Section 2.3 "circular imports: none after the
 *     move").
 *
 * The twin never blocks L0. The attach hook wraps every scoring pass in
 * setImmediate so a throwing baseline cannot cascade into enforcement.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// === Minimal ARPEvent shape ===
//
// This is a structural subset of the ARPEvent interface defined in
// hackmyagent/src/arp/types.ts. The twin consumes only these fields, so
// any object that satisfies this shape can be scored. Keeping the shape
// local eliminates the cross-repo type dependency the audit flagged.

export type ARPEventCategory = 'normal' | 'anomaly' | 'violation' | 'threat';
export type ARPEventSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ARPEventInput {
  id: string;
  timestamp: string;
  source: string;
  category: ARPEventCategory;
  severity: ARPEventSeverity;
  description: string;
  data: Record<string, unknown>;
}

// === Minimal EventEngine contract ===
//
// The twin attaches to anything that provides an onEvent hook accepting
// a callback that receives an ARPEventInput. This lets hackmyagent's
// EventEngine plug in without exporting its full type surface into this
// package. Any test double satisfying this shape works for unit tests.

export interface EventEngineLike {
  onEvent(cb: (event: ARPEventInput) => void): void;
}

// === Internal types ===

type EventType =
  | 'TOOL_CALL'
  | 'CAPABILITY_CHECK'
  | 'MCP_CALL'
  | 'MEMORY_READ'
  | 'MEMORY_WRITE'
  | 'EXTERNAL_CALL';

export type RuntimeTwinAction = 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill';

interface BehavioralEvent {
  agentId: string;
  sessionId: string;
  sequenceNum: number;
  eventType: EventType;
  capability: string;
  toolName: string | null;
  argHash: string;
  timestampDelta: number;
  wallClock: number;
  responseSize: number;
  responseCode: number;
  l0Decision: 'allow' | 'block' | 'alert';
}

interface BaselineStats {
  eventTypeCounts: Record<string, number>;
  avgTimingDelta: number;
  stdTimingDelta: number;
  capabilitySet: Set<string>;
  avgResponseSize: number;
  totalEvents: number;
  errorRate: number;
}

export interface AnomalyResult {
  score: number;
  action: RuntimeTwinAction;
  reason: string;
}

export interface RuntimeTwinConfig {
  /** When false, the twin is inert: attach becomes a no-op, scoring returns null. */
  enabled?: boolean;
  /** Opt-in to federated learning gradient submission. Default false. */
  fleetEnabled?: boolean;
  /** Broad agent category used for fleet aggregation bucketing. Default 'general'. */
  agentCategory?: string;
}

// === Response table ===

const RESPONSE_TABLE: Array<{ threshold: number; action: RuntimeTwinAction; label: string }> = [
  { threshold: 0.2, action: 'allow', label: 'Normal behavior' },
  { threshold: 0.4, action: 'alert', label: 'Unusual pattern detected' },
  { threshold: 0.6, action: 'throttle', label: 'Suspicious behavior - rate limited' },
  { threshold: 0.8, action: 'suspend', label: 'High anomaly - agent suspended' },
  { threshold: 1.0, action: 'kill', label: 'Critical anomaly - agent terminated' },
];

// === Gradient dimensions ===
// One dim per event type (6) + timing z-score + error rate + capability novelty.
const GRADIENT_DIMS = 9;
const GRADIENT_FLUSH_INTERVAL = 300;
const EVENT_TYPE_INDEX: Record<string, number> = {
  TOOL_CALL: 0,
  CAPABILITY_CHECK: 1,
  MCP_CALL: 2,
  MEMORY_READ: 3,
  MEMORY_WRITE: 4,
  EXTERNAL_CALL: 5,
};

// === RuntimeTwin ===

export class RuntimeTwin {
  private agentId: string;
  private sessionId: string;
  private baseline: BaselineStats | null = null;
  private eventBuffer: BehavioralEvent[] = [];
  private sequenceNum = 0;
  private lastEventTime = Date.now();
  private eventLogPath: string;
  private enabled: boolean;
  private gradientAccumulator: number[] = new Array(GRADIENT_DIMS).fill(0);
  private gradientEventCount = 0;
  private gradientLossSum = 0;
  private fleetEnabled: boolean;
  private agentCategory: string;

  constructor(agentId: string, config?: RuntimeTwinConfig) {
    this.agentId = agentId;
    this.sessionId = crypto.randomUUID();
    this.enabled = config?.enabled ?? true;
    this.fleetEnabled = config?.fleetEnabled ?? false;
    this.agentCategory = config?.agentCategory ?? 'general';
    this.eventLogPath = path.join(os.homedir(), '.opena2a', 'arp', 'events.jsonl');

    this.loadBaseline();
  }

  /**
   * Attach to an ARP EventEngine. Every event goes through the scoring
   * pass in parallel with L0. The attach hook never blocks L0: scoring
   * is scheduled via setImmediate, and escalation logging is best-effort.
   */
  attach(engine: EventEngineLike): void {
    if (!this.enabled) return;

    engine.onEvent((event: ARPEventInput) => {
      const behavioral = this.convertEvent(event);
      if (!behavioral) return;

      setImmediate(() => {
        const result = this.processEvent(behavioral);
        if (result.score > 0.4) {
          this.logEscalation(event, result);
        }
      });
    });
  }

  /**
   * Score an ARP event without mutating twin state.
   *
   * Used by the behavioral-risk IPC server (in hackmyagent) to answer
   * on-demand scoring requests from a coordinator running in another
   * process, or by InProcessBehavioralRiskSource for single-process
   * wiring. Unlike processEvent, this does not advance the sequence
   * number, append to the event log, add to the buffer, or accumulate
   * the gradient. It is a pure read against the current baseline.
   *
   * Returns null when the twin is disabled or the baseline is not yet
   * trained (totalEvents < 100). Callers must surface this as a
   * NOT_READY signal rather than synthesizing a zero score, which would
   * misrepresent the twin's confidence.
   */
  scoreARPEvent(event: ARPEventInput): AnomalyResult | null {
    if (!this.enabled) return null;
    if (!this.baseline || this.baseline.totalEvents < 100) return null;
    const behavioral = this.convertEventReadonly(event);
    if (!behavioral) return null;
    const score = this.computeAnomalyScore(behavioral);
    const response = this.getResponse(score);
    return { score, action: response.action, reason: response.label };
  }

  /**
   * Readonly variant of convertEvent. Does not mutate lastEventTime or
   * sequenceNum. Used by scoreARPEvent for IPC scoring.
   */
  private convertEventReadonly(event: ARPEventInput): BehavioralEvent | null {
    const now = Date.now();
    const delta = this.lastEventTime > 0 ? now - this.lastEventTime : 0;
    const sequenceNum = this.sequenceNum + 1;

    let eventType: EventType = 'TOOL_CALL';
    const source = String(event.data?.source || event.data?.monitor || '');
    if (source.includes('network')) eventType = 'EXTERNAL_CALL';
    else if (source.includes('filesystem')) eventType = 'MEMORY_READ';
    else if (source.includes('mcp')) eventType = 'MCP_CALL';
    else if (source.includes('capability')) eventType = 'CAPABILITY_CHECK';

    let l0Decision: 'allow' | 'block' | 'alert' = 'allow';
    if (event.data?._initialAction === 'kill' || event.data?._initialAction === 'pause') l0Decision = 'block';
    else if (event.category === 'threat' || event.category === 'violation') l0Decision = 'alert';
    else if (event.severity === 'high' || event.severity === 'critical') l0Decision = 'alert';

    const capability = String(event.data?.capability || event.data?.type || 'unknown');
    const toolName = event.data?.toolName ? String(event.data.toolName) : null;
    const responseSize = typeof event.data?.responseSize === 'number' ? event.data.responseSize : 0;

    return {
      agentId: this.agentId,
      sessionId: this.sessionId,
      sequenceNum,
      eventType,
      capability,
      toolName,
      argHash: crypto.createHash('sha256').update(JSON.stringify(event.data || {})).digest('hex').substring(0, 16),
      timestampDelta: delta,
      wallClock: now,
      responseSize,
      responseCode: event.data?.error ? 1 : 0,
      l0Decision,
    };
  }

  /**
   * Test seam: force-install a baseline so unit tests can exercise
   * scoreARPEvent without first calling processEvent a hundred times.
   * The leading underscore marks this as non-production surface.
   */
  _setBaselineForTest(baseline: BaselineStats): void {
    this.baseline = baseline;
  }

  /**
   * Process a behavioral event: update the buffer, compute the anomaly
   * score, accumulate the gradient. Mutating path used by the attach
   * hook.
   */
  processEvent(event: BehavioralEvent): AnomalyResult {
    this.eventBuffer.push(event);
    this.appendToLog(event);

    if (this.eventBuffer.length > 1000) {
      this.eventBuffer = this.eventBuffer.slice(-500);
    }

    const score = this.computeAnomalyScore(event);
    const response = this.getResponse(score);

    this.accumulateGradient(event, score);

    return {
      score,
      action: response.action,
      reason: response.label,
    };
  }

  /**
   * Convert an ARP event to a behavioral event. Mutating: advances
   * lastEventTime and sequenceNum.
   */
  private convertEvent(event: ARPEventInput): BehavioralEvent | null {
    const now = Date.now();
    const delta = now - this.lastEventTime;
    this.lastEventTime = now;
    this.sequenceNum++;

    let eventType: EventType = 'TOOL_CALL';
    const source = String(event.data?.source || event.data?.monitor || '');
    if (source.includes('network')) eventType = 'EXTERNAL_CALL';
    else if (source.includes('filesystem')) eventType = 'MEMORY_READ';
    else if (source.includes('mcp')) eventType = 'MCP_CALL';
    else if (source.includes('capability')) eventType = 'CAPABILITY_CHECK';

    let l0Decision: 'allow' | 'block' | 'alert' = 'allow';
    if (event.data?._initialAction === 'kill' || event.data?._initialAction === 'pause') l0Decision = 'block';
    else if (event.category === 'threat' || event.category === 'violation') l0Decision = 'alert';
    else if (event.severity === 'high' || event.severity === 'critical') l0Decision = 'alert';

    const capability = String(event.data?.capability || event.data?.type || 'unknown');
    const toolName = event.data?.toolName ? String(event.data.toolName) : null;
    const responseSize = typeof event.data?.responseSize === 'number' ? event.data.responseSize : 0;

    return {
      agentId: this.agentId,
      sessionId: this.sessionId,
      sequenceNum: this.sequenceNum,
      eventType,
      capability,
      toolName,
      argHash: crypto.createHash('sha256').update(JSON.stringify(event.data || {})).digest('hex').substring(0, 16),
      timestampDelta: delta,
      wallClock: now,
      responseSize,
      responseCode: event.data?.error ? 1 : 0,
      l0Decision,
    };
  }

  /**
   * Anomaly score over the baseline. Zero until the baseline has 100
   * events recorded. The caller can learn the not-ready state via
   * scoreARPEvent returning null; this method always returns a number
   * because it is part of the mutating processEvent path and already
   * has the side effect of growing the baseline.
   */
  private computeAnomalyScore(event: BehavioralEvent): number {
    if (!this.baseline || this.baseline.totalEvents < 100) {
      this.updateBaseline(event);
      return 0.0;
    }

    let score = 0.0;

    if (!this.baseline.capabilitySet.has(event.capability)) score += 0.3;

    if (this.baseline.stdTimingDelta > 0) {
      const z = Math.abs(event.timestampDelta - this.baseline.avgTimingDelta) / this.baseline.stdTimingDelta;
      if (z > 3) score += 0.2;
      if (z > 5) score += 0.2;
    }

    const typeRatio = (this.baseline.eventTypeCounts[event.eventType] || 0) / this.baseline.totalEvents;
    if (typeRatio < 0.01) score += 0.15;

    if (event.l0Decision === 'block') score += 0.3;
    if (event.l0Decision === 'alert') score += 0.15;

    const recent = this.eventBuffer.slice(-10);
    const avgDelta = recent.reduce((s, e) => s + e.timestampDelta, 0) / recent.length;
    if (avgDelta < 10 && recent.length >= 10) score += 0.2;

    if (recent.filter(e => e.responseCode > 0).length > 5) score += 0.15;

    return Math.min(score, 1.0);
  }

  private updateBaseline(event: BehavioralEvent): void {
    if (!this.baseline) {
      this.baseline = {
        eventTypeCounts: {},
        avgTimingDelta: 0,
        stdTimingDelta: 0,
        capabilitySet: new Set(),
        avgResponseSize: 0,
        totalEvents: 0,
        errorRate: 0,
      };
    }
    const b = this.baseline;
    b.totalEvents++;
    b.eventTypeCounts[event.eventType] = (b.eventTypeCounts[event.eventType] || 0) + 1;
    b.capabilitySet.add(event.capability);

    const n = b.totalEvents;
    const oldAvg = b.avgTimingDelta;
    b.avgTimingDelta = oldAvg + (event.timestampDelta - oldAvg) / n;
    const diff = event.timestampDelta - b.avgTimingDelta;
    b.stdTimingDelta = Math.sqrt(
      (b.stdTimingDelta ** 2 * (n - 1) + (event.timestampDelta - oldAvg) * diff) / n
    );
  }

  private getResponse(score: number): { action: RuntimeTwinAction; label: string } {
    for (const entry of RESPONSE_TABLE) {
      if (score <= entry.threshold) return entry;
    }
    return { action: 'kill', label: 'Critical anomaly' };
  }

  private loadBaseline(): void {
    const bp = path.join(os.homedir(), '.opena2a', 'arp', `baseline-${this.agentId}.json`);
    try {
      if (fs.existsSync(bp)) {
        const data = JSON.parse(fs.readFileSync(bp, 'utf-8'));
        data.capabilitySet = new Set(data.capabilitySet || []);
        this.baseline = data;
      }
    } catch {}
  }

  private appendToLog(event: BehavioralEvent): void {
    try {
      const dir = path.dirname(this.eventLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.eventLogPath, JSON.stringify(event) + '\n');
    } catch {}
  }

  private logEscalation(original: ARPEventInput, result: AnomalyResult): void {
    try {
      const logDir = path.join(os.homedir(), '.opena2a', 'arp');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'l1-escalations.jsonl'),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          agentId: this.agentId,
          eventId: original.id,
          score: result.score,
          action: result.action,
          reason: result.reason,
          category: original.category,
        }) + '\n'
      );
    } catch {}
  }

  // === Federated learning gradient submission ===
  //
  // Still on the v1 wire format. NANOMIND_FL_DESIGN.md Section 3
  // defines the v2 format (signed, round-aware, client-identified) that
  // will supersede this path. The adoption is tracked separately; this
  // module is left on v1 intentionally to avoid bundling the FL rewrite
  // into the Q5 split PR.

  /**
   * Accumulate behavioral features into gradient vector. Each event
   * contributes to a running 9-dim gradient capturing event-type
   * distribution, timing anomalies, error rates, and capability novelty.
   */
  private accumulateGradient(event: BehavioralEvent, anomalyScore: number): void {
    if (!this.fleetEnabled) return;

    this.gradientEventCount++;
    this.gradientLossSum += anomalyScore;

    const typeIdx = EVENT_TYPE_INDEX[event.eventType] ?? 0;
    this.gradientAccumulator[typeIdx] += 1.0;

    if (this.baseline && this.baseline.stdTimingDelta > 0) {
      const z = (event.timestampDelta - this.baseline.avgTimingDelta) / this.baseline.stdTimingDelta;
      this.gradientAccumulator[6] += Math.min(Math.abs(z), 10.0);
    }

    if (event.responseCode > 0) {
      this.gradientAccumulator[7] += 1.0;
    }

    if (this.baseline && !this.baseline.capabilitySet.has(event.capability)) {
      this.gradientAccumulator[8] += 1.0;
    }

    if (this.gradientEventCount >= GRADIENT_FLUSH_INTERVAL) {
      this.flushGradient();
    }
  }

  /**
   * Submit accumulated gradient to Registry fleet endpoint (v1 wire).
   * Normalizes by event count and applies clipping plus Gaussian noise
   * inline so this module does not depend on @nanomind/runtime/fleet.ts
   * (retired alongside this PR).
   */
  private async flushGradient(): Promise<void> {
    if (this.gradientEventCount === 0) return;

    const normalized = this.gradientAccumulator.map(
      g => g / this.gradientEventCount,
    );
    const avgLoss = this.gradientLossSum / this.gradientEventCount;
    const count = this.gradientEventCount;

    this.gradientAccumulator = new Array(GRADIENT_DIMS).fill(0);
    this.gradientEventCount = 0;
    this.gradientLossSum = 0;

    try {
      const noisyGradient = this.addPrivacyNoise(normalized);
      await fetch('https://api.oa2a.org/api/v1/telemetry/behavioral-gradient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentCategory: this.agentCategory,
          gradientVector: noisyGradient,
          localLoss: avgLoss,
          eventCount: count,
          privacyEpsilon: 1.0,
          modelVersion: '1.0.0',
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-fatal: gradient submission failure must never affect ARP.
    }
  }

  /**
   * Differential privacy: clip to L2 norm 1.0, add Gaussian noise at
   * sigma consistent with epsilon=1.0, delta=1e-5. Matches the v1
   * guarantees in the retired @nanomind/runtime/fleet.ts.
   */
  private addPrivacyNoise(gradient: number[]): number[] {
    const norm = Math.sqrt(gradient.reduce((s, g) => s + g * g, 0));
    const clipped = norm <= 1.0 ? [...gradient] : gradient.map(g => g / norm);

    const sigma = 1.0 * Math.sqrt(2 * Math.log(1.25 / 1e-5)) / 1.0;
    return clipped.map(g => {
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return g + sigma * z;
    });
  }

  /**
   * Flush any remaining gradient. Callers invoke this at shutdown so a
   * partially-accumulated round is not lost.
   */
  async shutdown(): Promise<void> {
    if (this.fleetEnabled && this.gradientEventCount > 0) {
      await this.flushGradient();
    }
  }
}
