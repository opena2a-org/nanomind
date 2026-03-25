/**
 * @nanomind/adapt — Skill Level Inference
 *
 * Infers the user's skill level from their command history
 * and adjusts response verbosity accordingly.
 *
 * Beginner: full explanations, step-by-step guidance
 * Intermediate: concise explanations, key context only
 * Expert: terse output, no hand-holding
 */
export type SkillLevel = 'beginner' | 'intermediate' | 'expert';
export declare class SkillAdapter {
    private history;
    private inferredLevel;
    /**
     * Record a command execution.
     */
    record(command: string, success: boolean): void;
    /**
     * Get the current inferred skill level.
     */
    getLevel(): SkillLevel;
    /**
     * Infer skill level from command history.
     */
    private infer;
    /**
     * Format a response based on skill level.
     */
    formatResponse(full: string, concise: string, terse: string): string;
}
