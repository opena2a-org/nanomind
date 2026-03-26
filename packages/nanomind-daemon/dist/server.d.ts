import { EventEmitter } from 'node:events';
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
export interface InferResponse {
    intent: string;
    result: string;
    confidence: number;
    attackClass?: string;
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
    constructor(config?: Partial<DaemonConfig>);
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
