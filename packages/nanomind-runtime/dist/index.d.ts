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
export type EventType = 'TOOL_CALL' | 'CAPABILITY_CHECK' | 'MCP_CALL' | 'MEMORY_READ' | 'MEMORY_WRITE' | 'EXTERNAL_CALL';
export interface BehavioralEvent {
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
export type ARPAction = 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill';
export interface AnomalyResult {
    score: number;
    action: ARPAction;
    reason: string;
    eventCount: number;
    latencyMs: number;
}
export declare class NanoMindRuntime {
    private agentId;
    private baseline;
    private eventBuffer;
    private anomalyHandlers;
    private eventLog;
    private offline;
    constructor(agentId: string);
    /**
     * Initialize runtime — load baseline, verify binary integrity.
     */
    initialize(atcContentHash?: string): Promise<void>;
    /**
     * Process a behavioral event and return anomaly score.
     */
    processEvent(event: BehavioralEvent): AnomalyResult;
    /**
     * Register an anomaly detection handler.
     */
    onAnomalyDetected(handler: (score: number, action: ARPAction) => void): () => void;
    /**
     * Compute anomaly score for a single event against the baseline.
     */
    private computeAnomalyScore;
    /**
     * Update the baseline with a new event (online learning).
     */
    private updateBaseline;
    /**
     * Get the response action for an anomaly score.
     */
    private getResponse;
    /**
     * Append event to local log file.
     */
    private appendToLog;
    /**
     * Load baseline from saved state.
     */
    private loadBaseline;
    /**
     * Save current baseline to disk.
     */
    saveBaseline(): Promise<void>;
    /**
     * Compute SHA-256 of the running binary for integrity verification.
     */
    private computeBinaryHash;
    /**
     * Get computed gradient for federated learning submission.
     */
    getGradient(): {
        eventCount: number;
        baseline: object;
    } | null;
    /**
     * Check if running in offline mode.
     */
    isOffline(): boolean;
}
