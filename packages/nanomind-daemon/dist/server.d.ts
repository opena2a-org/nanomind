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
    /**
     * Release the loaded model; the next `ensureReady()` loads it again.
     * An engine without `unload` is never idle-unloaded, because the daemon
     * would otherwise report a resident model as unloaded.
     */
    unload?(): Promise<void> | void;
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
/**
 * Classification status — the explicit abstain signal added in 0.4.0 (FGA Step 5
 * Stage 1, issue #131). It tells the consumer whether `attackClass` is a usable
 * verdict or a deterministic fallback:
 *   - "classified": the model produced a usable verdict (benign OR an attack
 *     class) at or above ABSTAIN_CONFIDENCE_FLOOR. `attackClass` is authoritative
 *     ("" means a confident benign).
 *   - "abstain": the model could not produce a usable verdict — inference threw,
 *     or the predicted-class confidence was below the floor. `attackClass` is
 *     forced to "" and MUST NOT be read as "benign". Any raw low-confidence guess
 *     is preserved in `evidence` for audit.
 *
 * The daemon never emits a transport-level "fail_open" — that is the consumer's
 * status for "couldn't reach / couldn't decode the daemon" (see AIM
 * `fga_engine.go::checkIntentSync`). `classification` is what distinguishes a
 * confident benign ("classified", attackClass "") from "model couldn't answer"
 * ("abstain", attackClass "") — the exact conflation issue #131 is about.
 */
export type ClassificationStatus = 'classified' | 'abstain';
export interface InferResponse {
    intent: string;
    result: string;
    confidence: number;
    attackClass: AttackClass;
    /**
     * Explicit classified/abstain signal (0.4.0+). Older consumers that do not
     * read this field still get a deterministic `attackClass` ("" on abstain), so
     * the addition is backward compatible.
     */
    classification: ClassificationStatus;
    evidence?: string;
    remediation?: string;
    latencyMs: number;
    modelVersion: string;
}
/**
 * Stage-1 abstain floor (issue #131). When the predicted class's
 * softmax probability is below this, `/v1/infer` emits classification:"abstain"
 * + attackClass:"" instead of a verdict, so a low-confidence guess can never
 * masquerade as a confident benign downstream.
 *
 * 0.5 is a deliberately conservative Stage-1 heuristic, NOT a calibrated value:
 * below even odds the top-of-10 class is not trustworthy. The v0.5.0 classifier
 * saturates confidence near 1.0 on most inputs (see README "Known model-quality
 * limitations"), so this rarely trips today — the dominant Stage-1 fix is the
 * explicit `classification` field, not this threshold. Stage 2 (selective-risk
 * calibration) replaces this constant with a tuned floor.
 */
export declare const ABSTAIN_CONFIDENCE_FLOOR = 0.5;
/**
 * Largest request body `/v1/infer` reads: 1 MB (1,048,576 bytes). A body that
 * declares a larger Content-Length, or that streams more bytes than this, is
 * answered 413 before any of it is parsed; the bytes past the cap are
 * discarded, never buffered.
 */
export declare const MAX_REQUEST_BODY_BYTES = 1048576;
/**
 * Why `infer()` refused a request before the model ran. `/v1/infer` answers
 * `queue_full` with 429 and `invalid_request` with 400.
 */
export type InferRequestErrorCode = 'queue_full' | 'invalid_request';
/**
 * Thrown by `NanoMindDaemon.infer()` when a request is refused before the
 * model runs. An inference failure is not wrapped in this class: `infer()`
 * rejects with the engine's own error.
 */
export declare class InferRequestError extends Error {
    readonly code: InferRequestErrorCode;
    constructor(code: InferRequestErrorCode, message: string);
}
export declare const DEFAULT_CONFIG: DaemonConfig;
export declare class NanoMindDaemon extends EventEmitter {
    private config;
    private engine;
    private httpServer;
    private ipcServer;
    private activeTasks;
    private idleTimer;
    private modelLoaded;
    private idleUnloaded;
    private startedAt;
    constructor(config?: Partial<DaemonConfig> & {
        engine?: DaemonEngine;
    });
    start(): Promise<void>;
    /**
     * Serves the HTTP request handler on a Unix socket (a named pipe on
     * Windows) at `ipcPath`, so a local client gets the same routes and
     * `/v1/infer` contract without a TCP port. The socket is created with
     * mode 0600: only the user running the daemon can connect. A socket file
     * left by a daemon that exited without cleanup is replaced; a socket with
     * a live listener, or a path that is not a socket, is never removed and
     * start() rejects instead.
     */
    private listenIPC;
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
    /**
     * Run one inference in-process, without the HTTP server. `/v1/infer` calls
     * this method, so both paths share the request validation, the
     * `maxConcurrent` cap and the classified/abstain contract. A daemon that was
     * never started loads the model on the first call.
     *
     * Rejects with `InferRequestError` when the request is refused before the
     * model runs (`queue_full`, `invalid_request`) and with the engine's own
     * error when inference fails. A rejection means classification did not run:
     * treat it as an abstain, never as a benign verdict.
     */
    infer(request: InferRequest): Promise<InferResponse>;
    private queueFullError;
    private respondRefused;
    private handleInfer;
    private resetIdleTimer;
}
