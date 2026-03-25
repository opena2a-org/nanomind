/**
 * @nanomind/router — Intent classification + command mapping
 *
 * Classifies natural language input into one of 16 intent types,
 * then maps to the appropriate CLI command or handler.
 */
export type IntentType = 'SCAN' | 'FIX' | 'EXPLAIN' | 'GENERATE' | 'COMPARE' | 'STATUS' | 'CONFIG' | 'HELP' | 'SECRETS_EXPOSE' | 'NAVIGATE' | 'TRUST_QUERY' | 'ATC_STATUS' | 'RISK_SCORE' | 'REVOCATION' | 'EXPOSURE' | 'ATTEST' | 'UNKNOWN';
export interface IntentClassification {
    intent: IntentType;
    confidence: number;
    entities: Record<string, string>;
    rawInput: string;
}
export interface CommandMapping {
    command: string;
    args: string[];
    description: string;
}
/**
 * Classify user input into an intent.
 * Uses pattern matching first (fast), falls back to LLM if ambiguous.
 */
export declare function classifyIntent(input: string): IntentClassification;
/**
 * Map an intent to a CLI command.
 */
export declare function mapToCommand(classification: IntentClassification, cliName: string): CommandMapping | null;
/**
 * Check if an intent is an ATC-related intent.
 */
export declare function isATCIntent(intent: IntentType): boolean;
