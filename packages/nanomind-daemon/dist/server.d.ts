import { EventEmitter } from 'node:events';
/**
 * Minimal engine surface the daemon relies on. Both the production
 * `OnnxEngine` and stubs used in tests satisfy it. Optional fields are
 * passed through to InferResponse when produced; absent fields fall back
 * to the empty/0.85 defaults that preserve the Bug 1 wire contract.
 */
export interface DaemonEngine {
    ensureReady(): Promise<void>;
    infer(prompt: string, opts?: unknown): Promise<{
        text: string;
        attackClass?: AttackClass;
        rawLabel?: string;
        confidence?: number;
    }>;
    readonly modelVersion?: string;
}
export interface DaemonConfig {
    httpPort: number;
    ipcPath: string;
    maxConcurrent: number;
    idleUnloadSeconds: number;
}
export interface InferRequest {
    intent: string;
    input: string;
    context?: {
        agentId?: string;
        driftScore?: number;
        declaredPurpose?: string;
    };
    priority?: 'high' | 'medium' | 'low';
}
/**
 * Canonical attackClass enum. The empty string is the always-emitted default
 * when no malicious intent is detected. Non-empty values are produced by the
 * production NanoMind classifier; until that ships, the daemon always emits "".
 *
 * AIM FGA Step 5 (`fga_engine.go::checkIntentSync`) blocks when:
 *   attackClass != "" && confidence > 0.8
 *
 * Empty string therefore means "no block" — preserving fail-open for the
 * pre-classifier daemon while making the wire contract explicit.
 */
export type AttackClass = '' | 'exfiltration_pattern' | 'prompt_injection' | 'tool_misuse' | 'data_extraction';
export interface InferResponse {
    intent: string;
    result: string;
    confidence: number;
    attackClass: AttackClass;
    evidence?: string;
    remediation?: string;
    latencyMs: number;
    modelVersion: string;
}
export declare const DEFAULT_CONFIG: DaemonConfig;
export declare class NanoMindDaemon extends EventEmitter {
    private config;
    private engine;
    private httpServer;
    private activeTasks;
    private idleTimer;
    private modelLoaded;
    private startedAt;
    constructor(config?: Partial<DaemonConfig> & {
        engine?: DaemonEngine;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    getStatus(): {
        running: boolean;
        port: number;
        activeTasks: number;
        modelLoaded: boolean;
        startedAt: Date | null;
        uptime: number;
    };
    private handleHTTP;
    private handleInfer;
    private resetIdleTimer;
}
