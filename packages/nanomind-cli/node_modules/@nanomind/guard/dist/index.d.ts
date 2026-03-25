/**
 * @nanomind/guard — Prompt Injection Detection for CLI
 *
 * Protects the NanoMind routing layer from injection attacks via piped input,
 * environment variables, or scanned agent output that attempts to hijack
 * the CLI into executing unintended commands.
 *
 * Runs BEFORE the router on all non-direct input (piped, file, env).
 */
export type InputSource = 'direct' | 'piped' | 'file' | 'env' | 'agent-output';
export interface GuardResult {
    safe: boolean;
    patterns: DetectedPattern[];
    source: InputSource;
    recommendation: string;
}
export interface DetectedPattern {
    type: InjectionType;
    match: string;
    position: number;
    severity: 'critical' | 'high' | 'medium';
}
export type InjectionType = 'instruction_override' | 'role_switching' | 'permission_escalation' | 'indirect_injection' | 'chained_injection' | 'encoded_payload';
/**
 * Screen input for injection attempts.
 * Returns a GuardResult indicating whether the input is safe to process.
 */
export declare function screenInput(input: string, source?: InputSource): GuardResult;
/**
 * Determine the input source.
 */
export declare function detectInputSource(): InputSource;
