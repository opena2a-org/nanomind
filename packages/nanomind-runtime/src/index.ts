/**
 * @nanomind/runtime — NanoMind Runtime: ARP Behavioral Twin
 *
 * Processes behavioral event sequences and produces anomaly scores.
 * NOT a language model — uses a lightweight statistical model (LSTM autoencoder
 * or simple sequence statistics) for sub-2ms inference.
 *
 * Three-tier ARP model:
 *   L0: Rule-based capability enforcement (microseconds) — existing ARP
 *   L1: NanoMind-Runtime behavioral anomaly detection (milliseconds) — THIS
 *   L2: Fleet intelligence (continuous improvement) — federated learning
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// === Event Types ===

export type EventType =
  | 'TOOL_CALL'
  | 'CAPABILITY_CHECK'
  | 'MCP_CALL'
  | 'MEMORY_READ'
  | 'MEMORY_WRITE'
  | 'EXTERNAL_CALL';

export interface BehavioralEvent {
  agentId: string;
  sessionId: string;
  sequenceNum: number;
  eventType: EventType;
  capability: string;
  toolName: string | null;
  argHash: string;
  timestampDelta: number; // ms since previous event
  wallClock: number;      // unix ms
  responseSize: number;
  responseCode: number;   // 0 = success
  l0Decision: 'allow' | 'block' | 'alert';
}

// === Anomaly Response ===

export type ARPAction = 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill';

export interface AnomalyResult {
  score: number;      // 0.0 (normal) to 1.0 (anomalous)
  action: ARPAction;
  reason: string;
  eventCount: number;
  latencyMs: number;
}

// Response thresholds
const RESPONSE_TABLE: Array<{ threshold: number; action: ARPAction; label: string }> = [
  { threshold: 0.2, action: 'allow',    label: 'Normal behavior' },
  { threshold: 0.4, action: 'alert',    label: 'Unusual pattern detected' },
  { threshold: 0.6, action: 'throttle', label: 'Suspicious behavior — rate limited' },
  { threshold: 0.8, action: 'suspend',  label: 'High anomaly — agent suspended' },
  { threshold: 1.0, action: 'kill',     label: 'Critical anomaly — agent terminated' },
];

// === Behavioral Baseline (Statistical Model) ===

interface BaselineStats {
  eventTypeCounts: Record<string, number>;
  avgTimingDelta: number;
  stdTimingDelta: number;
  capabilitySet: Set<string>;
  avgResponseSize: number;
  totalEvents: number;
  errorRate: number;
}

// === Runtime Engine ===

export class NanoMindRuntime {
  private agentId: string;
  private baseline: BaselineStats | null = null;
  private eventBuffer: BehavioralEvent[] = [];
  private anomalyHandlers: Array<(score: number, action: ARPAction) => void> = [];
  private eventLog: string;
  private offline: boolean;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.eventLog = path.join(os.homedir(), '.opena2a', 'arp', 'events.jsonl');
    this.offline = process.env.NANOMIND_OFFLINE === '1';
  }

  /**
   * Initialize runtime — load baseline, verify binary integrity.
   */
  async initialize(atcContentHash?: string): Promise<void> {
    // Binary integrity check
    if (atcContentHash) {
      const binaryHash = await this.computeBinaryHash();
      if (binaryHash && binaryHash !== atcContentHash) {
        throw new Error(
          `RUNTIME_INTEGRITY_VIOLATION: binary hash ${binaryHash.substring(0, 12)} does not match ATC contentHash ${atcContentHash.substring(0, 12)}`
        );
      }
    }

    // Load or create baseline
    this.baseline = await this.loadBaseline();
  }

  /**
   * Process a behavioral event and return anomaly score.
   */
  processEvent(event: BehavioralEvent): AnomalyResult {
    const start = Date.now();

    this.eventBuffer.push(event);
    this.appendToLog(event);

    // Keep buffer bounded
    if (this.eventBuffer.length > 1000) {
      this.eventBuffer = this.eventBuffer.slice(-500);
    }

    // Compute anomaly score
    const score = this.computeAnomalyScore(event);
    const { action, label } = this.getResponse(score);

    const result: AnomalyResult = {
      score,
      action,
      reason: label,
      eventCount: this.eventBuffer.length,
      latencyMs: Date.now() - start,
    };

    // Notify handlers
    if (score > 0.2) {
      for (const handler of this.anomalyHandlers) {
        handler(score, action);
      }
    }

    return result;
  }

  /**
   * Register an anomaly detection handler.
   */
  onAnomalyDetected(handler: (score: number, action: ARPAction) => void): () => void {
    this.anomalyHandlers.push(handler);
    return () => {
      this.anomalyHandlers = this.anomalyHandlers.filter(h => h !== handler);
    };
  }

  /**
   * Compute anomaly score for a single event against the baseline.
   */
  private computeAnomalyScore(event: BehavioralEvent): number {
    if (!this.baseline || this.baseline.totalEvents < 100) {
      // Not enough data for baseline — learn only, don't score
      this.updateBaseline(event);
      return 0.0;
    }

    let score = 0.0;

    // Factor 1: Unknown capability (never seen before)
    if (!this.baseline.capabilitySet.has(event.capability)) {
      score += 0.3;
    }

    // Factor 2: Timing anomaly (too fast or too slow)
    if (this.baseline.stdTimingDelta > 0) {
      const zScore = Math.abs(event.timestampDelta - this.baseline.avgTimingDelta) / this.baseline.stdTimingDelta;
      if (zScore > 3) score += 0.2;
      if (zScore > 5) score += 0.2;
    }

    // Factor 3: Unusual event type distribution
    const typeRatio = (this.baseline.eventTypeCounts[event.eventType] || 0) / this.baseline.totalEvents;
    if (typeRatio < 0.01) {
      score += 0.15; // rare event type
    }

    // Factor 4: L0 already flagged
    if (event.l0Decision === 'block') score += 0.3;
    if (event.l0Decision === 'alert') score += 0.15;

    // Factor 5: Burst detection (many events in rapid succession)
    const recentEvents = this.eventBuffer.slice(-10);
    const avgDelta = recentEvents.reduce((sum, e) => sum + e.timestampDelta, 0) / recentEvents.length;
    if (avgDelta < 10 && recentEvents.length >= 10) {
      score += 0.2; // burst: 10+ events in < 100ms total
    }

    // Factor 6: Error spike
    const recentErrors = recentEvents.filter(e => e.responseCode > 0).length;
    if (recentErrors > 5) score += 0.15;

    // Clamp to [0, 1]
    return Math.min(score, 1.0);
  }

  /**
   * Update the baseline with a new event (online learning).
   */
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

    // Running average for timing
    const n = b.totalEvents;
    const oldAvg = b.avgTimingDelta;
    b.avgTimingDelta = oldAvg + (event.timestampDelta - oldAvg) / n;
    // Running variance (Welford's algorithm)
    const diff = event.timestampDelta - b.avgTimingDelta;
    b.stdTimingDelta = Math.sqrt(
      (b.stdTimingDelta ** 2 * (n - 1) + (event.timestampDelta - oldAvg) * diff) / n
    );

    b.avgResponseSize = b.avgResponseSize + (event.responseSize - b.avgResponseSize) / n;
    if (event.responseCode > 0) {
      b.errorRate = b.errorRate + (1 - b.errorRate) / n;
    } else {
      b.errorRate = b.errorRate + (0 - b.errorRate) / n;
    }
  }

  /**
   * Get the response action for an anomaly score.
   */
  private getResponse(score: number): { action: ARPAction; label: string } {
    for (const entry of RESPONSE_TABLE) {
      if (score <= entry.threshold) {
        return { action: entry.action, label: entry.label };
      }
    }
    return { action: 'kill', label: 'Critical anomaly' };
  }

  /**
   * Append event to local log file.
   */
  private appendToLog(event: BehavioralEvent): void {
    try {
      const dir = path.dirname(this.eventLog);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.eventLog, JSON.stringify(event) + '\n');

      // Rotate at 50MB
      const stats = fs.statSync(this.eventLog);
      if (stats.size > 50 * 1024 * 1024) {
        fs.renameSync(this.eventLog, this.eventLog + '.old');
      }
    } catch {
      // Non-critical — don't fail on log errors
    }
  }

  /**
   * Load baseline from saved state.
   */
  private async loadBaseline(): Promise<BaselineStats | null> {
    const baselinePath = path.join(os.homedir(), '.opena2a', 'arp', `baseline-${this.agentId}.json`);
    try {
      if (fs.existsSync(baselinePath)) {
        const data = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
        data.capabilitySet = new Set(data.capabilitySet || []);
        return data as BaselineStats;
      }
    } catch {}
    return null;
  }

  /**
   * Save current baseline to disk.
   */
  async saveBaseline(): Promise<void> {
    if (!this.baseline) return;
    const baselinePath = path.join(os.homedir(), '.opena2a', 'arp', `baseline-${this.agentId}.json`);
    const dir = path.dirname(baselinePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const serializable = {
      ...this.baseline,
      capabilitySet: Array.from(this.baseline.capabilitySet),
    };
    fs.writeFileSync(baselinePath, JSON.stringify(serializable, null, 2));
  }

  /**
   * Compute SHA-256 of the running binary for integrity verification.
   */
  private async computeBinaryHash(): Promise<string | null> {
    try {
      const binaryPath = process.argv[0]; // node binary
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(binaryPath);
      return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', () => resolve(null));
      });
    } catch {
      return null;
    }
  }

  /**
   * Get computed gradient for federated learning submission.
   */
  getGradient(): { eventCount: number; baseline: object } | null {
    if (!this.baseline || this.baseline.totalEvents < 100) return null;
    if (this.offline) return null;

    return {
      eventCount: this.baseline.totalEvents,
      baseline: {
        eventTypeCounts: this.baseline.eventTypeCounts,
        avgTimingDelta: this.baseline.avgTimingDelta,
        stdTimingDelta: this.baseline.stdTimingDelta,
        capabilities: Array.from(this.baseline.capabilitySet),
        avgResponseSize: this.baseline.avgResponseSize,
        errorRate: this.baseline.errorRate,
      },
    };
  }

  /**
   * Check if running in offline mode.
   */
  isOffline(): boolean {
    return this.offline;
  }
}
