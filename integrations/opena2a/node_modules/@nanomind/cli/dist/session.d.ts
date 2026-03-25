/**
 * @nanomind/session — Multi-turn Terminal Session Context
 *
 * Maintains context across multiple user inputs within a single
 * terminal session. Enables follow-up questions like:
 *   "scan this" → results
 *   "fix the first one" → knows which "first one" from previous scan
 *   "explain that check" → knows which check from previous output
 */
export interface SessionContext {
    lastCommand: string | null;
    lastOutput: string | null;
    lastFindings: Finding[];
    lastAgentId: string | null;
    scanResults: ScanResult | null;
    turnCount: number;
    startedAt: number;
}
interface Finding {
    id: string;
    title: string;
    severity: string;
}
interface ScanResult {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    passed: boolean;
}
export declare class SessionManager {
    private context;
    constructor();
    /**
     * Update context after a command execution.
     */
    update(command: string, output: string): void;
    /**
     * Resolve references like "the first one", "that check", etc.
     */
    resolveReference(input: string): string;
    /**
     * Get current session context.
     */
    getContext(): SessionContext;
    /**
     * Get session duration in seconds.
     */
    getDuration(): number;
}
export {};
