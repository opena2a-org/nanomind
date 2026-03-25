"use strict";
/**
 * @nanomind/router — Intent classification + command mapping
 *
 * Classifies natural language input into one of 16 intent types,
 * then maps to the appropriate CLI command or handler.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyIntent = classifyIntent;
exports.mapToCommand = mapToCommand;
exports.isATCIntent = isATCIntent;
// Pattern-based fast classification (no LLM needed for obvious intents)
// Order matters: more specific patterns first, general patterns last.
const INTENT_PATTERNS = [
    // ATC intents (specific — must be before general EXPLAIN/STATUS)
    { pattern: /\b(trust\s*level|trust\s*score|trusted)\b/i, intent: 'TRUST_QUERY' },
    { pattern: /\b(why.*(level|trust|score)|explain.*(trust|level|atc))\b/i, intent: 'ATC_STATUS' },
    { pattern: /\b(risk\s*score|ars|blast\s*radius)\b/i, intent: 'RISK_SCORE' },
    { pattern: /\b(revok(ed|e|ation)|why.*blocked)\b/i, intent: 'REVOCATION' },
    { pattern: /\b(exposure|ceiling|exposure\s*ceiling)\b/i, intent: 'EXPOSURE' },
    { pattern: /\b(attest|attestation|build.*(trust|atc)|add.*ci.*trust)\b/i, intent: 'ATTEST' },
    // Scan
    { pattern: /\b(scan|check|audit|inspect|analyze|secure)\b/i, intent: 'SCAN' },
    // Fix
    { pattern: /\b(fix|repair|patch|remediate|auto-?fix)\b/i, intent: 'FIX' },
    // Generate
    { pattern: /\b(generate|create|make|build|setup|configure)\b.*\b(action|docker|ci|yaml|config)\b/i, intent: 'GENERATE' },
    // Compare
    { pattern: /\b(compare|diff|changed|difference|delta)\b/i, intent: 'COMPARE' },
    // Status
    { pattern: /\b(status|how (secure|safe)|summary|overview)\b/i, intent: 'STATUS' },
    // Config
    { pattern: /\b(set|configure|config|setting|preference)\b/i, intent: 'CONFIG' },
    // Explain (general — after specific ATC intents)
    { pattern: /\b(explain|what (does|is|are)|describe|tell me about|meaning)\b/i, intent: 'EXPLAIN' },
    // Help
    { pattern: /\b(help|command|what can|how do|usage)\b/i, intent: 'HELP' },
    // Secrets
    { pattern: /\b(secret|credential|key|token|password|env)\b.*\b(exposed?|leak|find|check)\b/i, intent: 'SECRETS_EXPOSE' },
];
// Entity extraction patterns
const ENTITY_PATTERNS = [
    { pattern: /\b([A-Z]+-\d{3})\b/, entity: 'checkId' },
    { pattern: /\bagent[:\s]+(\S+)/i, entity: 'agentId' },
    { pattern: /\bpackage[:\s]+(\S+)/i, entity: 'packageName' },
    { pattern: /\b(did:[a-z]+:[a-z_]+:[^\s]+)/, entity: 'did' },
];
/**
 * Classify user input into an intent.
 * Uses pattern matching first (fast), falls back to LLM if ambiguous.
 */
function classifyIntent(input) {
    const trimmed = input.trim();
    // Extract entities
    const entities = {};
    for (const { pattern, entity } of ENTITY_PATTERNS) {
        const match = trimmed.match(pattern);
        if (match) {
            entities[entity] = match[1];
        }
    }
    // Pattern-based classification
    for (const { pattern, intent } of INTENT_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                intent,
                confidence: 0.85,
                entities,
                rawInput: trimmed,
            };
        }
    }
    return {
        intent: 'UNKNOWN',
        confidence: 0.0,
        entities,
        rawInput: trimmed,
    };
}
/**
 * Map an intent to a CLI command.
 */
function mapToCommand(classification, cliName) {
    const { intent, entities } = classification;
    switch (intent) {
        case 'SCAN':
            return { command: `${cliName} secure`, args: ['.'], description: 'Run security scan' };
        case 'FIX':
            return { command: `${cliName} secure`, args: ['--fix'], description: 'Auto-fix findings' };
        case 'STATUS':
            return { command: `${cliName} secure`, args: ['--summary'], description: 'Show scan summary' };
        case 'TRUST_QUERY':
            return {
                command: 'opena2a trust',
                args: entities.agentId ? [entities.agentId] : [],
                description: 'Query trust level',
            };
        case 'ATC_STATUS':
            return {
                command: 'opena2a trust explain',
                args: entities.agentId ? [entities.agentId] : [],
                description: 'Explain trust level',
            };
        case 'ATTEST':
            return {
                command: 'opena2a attest',
                args: [],
                description: 'Generate build attestation config',
            };
        case 'HELP':
            return { command: `${cliName} --help`, args: [], description: 'Show help' };
        default:
            return null;
    }
}
/**
 * Check if an intent is an ATC-related intent.
 */
function isATCIntent(intent) {
    return ['TRUST_QUERY', 'ATC_STATUS', 'RISK_SCORE', 'REVOCATION', 'EXPOSURE', 'ATTEST'].includes(intent);
}
