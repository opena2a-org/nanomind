/**
 * @nanomind/router — Intent classification + command mapping
 *
 * Classifies natural language input into one of 16 intent types,
 * then maps to the appropriate CLI command or handler.
 */

// Complete intent taxonomy (10 original + 6 ATC + 6 SCAN intents)
export type IntentType =
  // Original intents
  | 'SCAN'           // "scan this project", "check for vulnerabilities"
  | 'FIX'            // "fix the credential issue", "auto-fix all"
  | 'EXPLAIN'        // "what does CRED-001 mean", "explain this finding"
  | 'GENERATE'       // "create a github action", "generate docker config"
  | 'COMPARE'        // "compare with last scan", "what changed"
  | 'STATUS'         // "show scan status", "how secure am I"
  | 'CONFIG'         // "configure auto-fix", "set output format"
  | 'HELP'           // "what can you do", "show commands"
  | 'SECRETS_EXPOSE' // "check for exposed secrets", "find credentials"
  | 'NAVIGATE'       // "open the dashboard", "show the report"
  // ATC intents (v2)
  | 'TRUST_QUERY'    // "what's the trust level of X", "is this agent trusted"
  | 'ATC_STATUS'     // "why is my agent level 2", "explain my trust score"
  | 'RISK_SCORE'     // "what's the risk score", "show ARS breakdown"
  | 'REVOCATION'     // "why was this agent revoked", "check revocation status"
  | 'EXPOSURE'       // "what's the exposure ceiling", "show blast radius"
  | 'ATTEST'         // "add trust to my CI", "generate build attestation"
  // SCAN intents (v3 Intelligence Fabric) -- NanoMind-enhanced HMA scanning
  | 'SCAN_SKILL_INTENT'       // Skill malicious intent classification
  | 'SCAN_SOUL_COMPLETENESS'  // SOUL.md governance completeness analysis
  | 'SCAN_MCP_SCOPE'          // MCP tool description scope analysis
  | 'SCAN_PROMPT_INTENT'      // System prompt behavioral envelope analysis
  | 'SCAN_VERSION_DELTA'      // Semantic diff between skill versions
  | 'SCAN_EXPLAIN'            // Human-readable explanation of any finding
  | 'UNKNOWN';                // Unclassifiable input

export interface IntentClassification {
  intent: IntentType;
  confidence: number;
  entities: Record<string, string>; // extracted entities (agentId, checkId, etc.)
  rawInput: string;
}

export interface CommandMapping {
  command: string;
  args: string[];
  description: string;
}

// Pattern-based fast classification (no LLM needed for obvious intents)
// Order matters: more specific patterns first, general patterns last.
const INTENT_PATTERNS: Array<{ pattern: RegExp; intent: IntentType }> = [
  // SCAN intents (programmatic, invoked by HMA --semantic flag)
  { pattern: /\bscan.*(skill|intent).*malicious\b/i, intent: 'SCAN_SKILL_INTENT' },
  { pattern: /\b(soul|governance).*(complet|coverage|gap)/i, intent: 'SCAN_SOUL_COMPLETENESS' },
  { pattern: /\bmcp.*(scope|permission|tool\s*desc)\b/i, intent: 'SCAN_MCP_SCOPE' },
  { pattern: /\b(system\s*prompt|prompt\s*intent|behavioral\s*envelope)\b/i, intent: 'SCAN_PROMPT_INTENT' },
  { pattern: /\b(version\s*delta|semantic\s*diff|skill\s*update)\b/i, intent: 'SCAN_VERSION_DELTA' },
  { pattern: /\bexplain\s*(finding|scan\s*result|detection)\b/i, intent: 'SCAN_EXPLAIN' },
  // ATC intents (specific — must be before general EXPLAIN/STATUS)
  { pattern: /\b(trust\s*level|trust\s*score|trusted)\b/i, intent: 'TRUST_QUERY' },
  { pattern: /\b(why.*(level|trust|score)|explain.*(trust|level|atc))\b/i, intent: 'ATC_STATUS' },
  { pattern: /\b(risk\s*score|ars|blast\s*radius)\b/i, intent: 'RISK_SCORE' },
  { pattern: /\b(revok(ed|e|ation)|why.*blocked)\b/i, intent: 'REVOCATION' },
  { pattern: /\b(exposure|ceiling|exposure\s*ceiling)\b/i, intent: 'EXPOSURE' },
  { pattern: /\b(attest|attestation|build.*(trust|atc)|add.*ci.*trust)\b/i, intent: 'ATTEST' },
  // Secrets (before SCAN, which also matches "check"); the noun may come before or after the verb
  { pattern: /\b(secrets?|credentials?|keys?|tokens?|passwords?|env)\b.*\b(exposed?|leak(s|ed|ing)?|find|check)\b/i, intent: 'SECRETS_EXPOSE' },
  { pattern: /\b(exposed?|leak(s|ed|ing)?|find|check)\b.*\b(secrets?|credentials?|keys?|tokens?|passwords?|env)\b/i, intent: 'SECRETS_EXPOSE' },
  // Scan
  { pattern: /\b(scan|check|audit|inspect|analyze|secure|detect)\b/i, intent: 'SCAN' },
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
];

// Entity extraction patterns
const ENTITY_PATTERNS: Array<{ pattern: RegExp; entity: string }> = [
  { pattern: /\b([A-Z]+-\d{3})\b/, entity: 'checkId' },
  { pattern: /\bagent[:\s]+(\S+)/i, entity: 'agentId' },
  { pattern: /\bpackage[:\s]+(\S+)/i, entity: 'packageName' },
  { pattern: /\b(did:[a-z]+:[a-z_]+:[^\s]+)/, entity: 'did' },
];

/**
 * Classify user input into an intent.
 * Uses pattern matching first (fast), falls back to LLM if ambiguous.
 */
export function classifyIntent(input: string): IntentClassification {
  const trimmed = input.trim();

  // Extract entities
  const entities: Record<string, string> = {};
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
 * One command an intent can run. `command` is what follows the CLI name.
 */
export interface CommandRoute {
  command: string;
  /** The CLI that owns the command, when it is not the CLI being routed. */
  cli?: string;
  args?: string[];
  description: string;
  /** The route applies only when the raw input matches. */
  match?: RegExp;
  /** Entities the route needs; their values are appended to args in this order. */
  entities?: string[];
  /** Entities appended to args when present. */
  optionalEntities?: string[];
}

/**
 * Per-CLI intent-to-command table. The routes for an intent are tried in
 * order and the first that applies wins. An intent with no route maps to null.
 */
export type CommandTable = Partial<Record<IntentType, CommandRoute[]>>;

// ATC intents are answered by the opena2a CLI whichever CLI the user is in.
const ATC_ROUTES: CommandTable = {
  TRUST_QUERY: [{ cli: 'opena2a', command: 'trust', optionalEntities: ['agentId'], description: 'Query trust level' }],
  ATC_STATUS: [{ cli: 'opena2a', command: 'trust explain', optionalEntities: ['agentId'], description: 'Explain trust level' }],
  ATTEST: [{ cli: 'opena2a', command: 'attest', description: 'Generate build attestation config' }],
};

const HELP_ROUTE: CommandTable = {
  HELP: [{ command: '--help', description: 'Show help' }],
};

const SECURE_SCAN: CommandRoute = { command: 'secure', args: ['.'], description: 'Run security scan' };

// Routes for a CLI with no table of its own.
const DEFAULT_COMMAND_TABLE: CommandTable = {
  SCAN: [SECURE_SCAN],
  SECRETS_EXPOSE: [{ ...SECURE_SCAN, description: 'Scan for exposed credentials' }],
  FIX: [{ command: 'secure', args: ['--fix'], description: 'Auto-fix findings' }],
  STATUS: [{ command: 'secure', args: ['--summary'], description: 'Show scan summary' }],
  ...ATC_ROUTES,
  ...HELP_ROUTE,
};

const DETECT_WORD = /\bdetect\b/i;

/**
 * Tables for the CLIs that ship an adapter in this repository, keyed by the
 * adapter's cliName. Each route names a command that the getCommandManifest()
 * of the owning CLI's adapter lists.
 */
export const COMMAND_TABLES: Record<string, CommandTable> = {
  hma: {
    ...DEFAULT_COMMAND_TABLE,
    SCAN: [
      { command: 'check', entities: ['packageName'], description: 'Check a package' },
      { command: 'detect', args: ['.'], match: DETECT_WORD, description: 'Detect AI agents in project' },
      SECURE_SCAN,
    ],
  },
  'secretless-ai': {
    SCAN: [{ command: 'scan', description: 'Scan for exposed secrets' }],
    SECRETS_EXPOSE: [{ command: 'diagnose', description: 'Diagnose credential exposure' }],
    STATUS: [{ command: 'verify', description: 'Verify secretless configuration' }],
    ...ATC_ROUTES,
    ...HELP_ROUTE,
  },
  opena2a: {
    SCAN: [
      { command: 'detect', args: ['.'], match: DETECT_WORD, description: 'Detect AI agents in project' },
      { command: 'scan', args: ['.'], description: 'Run HMA security scan' },
    ],
    SECRETS_EXPOSE: [{ command: 'secretless', description: 'Check credential exposure' }],
    STATUS: [{ command: 'review', description: 'Review project security' }],
    ...ATC_ROUTES,
    ...HELP_ROUTE,
  },
};

/**
 * The command table for a CLI: its own table, or the default routes.
 */
export function commandTableFor(cliName: string): CommandTable {
  return Object.hasOwn(COMMAND_TABLES, cliName) ? COMMAND_TABLES[cliName] : DEFAULT_COMMAND_TABLE;
}

// An entity value that can be passed to a command as one argument: a package
// name, agent id or similar identifier. Entity values come from the request
// text and adapters run the mapped command through a shell, so anything a
// shell interprets is refused, and so is a leading hyphen, which a CLI would
// read as an option.
const PLAIN_ARGUMENT = /^[A-Za-z0-9@][\w@.:\/+-]*$/;

/**
 * Whether an entity value can be appended to a command's arguments as is.
 */
export function isPlainArgument(value: string): boolean {
  return PLAIN_ARGUMENT.test(value);
}

/**
 * Map an intent to a CLI command, using `table` when the caller supplies one
 * and the CLI's built-in table otherwise. A route whose entity value is not a
 * plain argument (see `isPlainArgument`) is skipped, so a request like
 * "check package: x;echo" falls through to the next route instead of
 * putting that text into a command.
 */
export function mapToCommand(
  classification: IntentClassification,
  cliName: string,
  table: CommandTable = commandTableFor(cliName),
): CommandMapping | null {
  const entities = classification.entities ?? {};
  const rawInput = classification.rawInput ?? '';
  const routes = Object.hasOwn(table, classification.intent) ? table[classification.intent] : undefined;

  for (const route of routes ?? []) {
    if (route.match && !route.match.test(rawInput)) continue;
    const required = route.entities ?? [];
    if (required.some((name) => !entities[name])) continue;

    const optional = (route.optionalEntities ?? []).filter((name) => entities[name]);
    const values = [...required, ...optional].map((name) => entities[name]);
    if (!values.every(isPlainArgument)) continue;

    return {
      command: `${route.cli ?? cliName} ${route.command}`,
      args: [...(route.args ?? []), ...values],
      description: route.description,
    };
  }
  return null;
}

/**
 * Check if an intent is an ATC-related intent.
 */
export function isATCIntent(intent: IntentType): boolean {
  return ['TRUST_QUERY', 'ATC_STATUS', 'RISK_SCORE', 'REVOCATION', 'EXPOSURE', 'ATTEST'].includes(intent);
}

/**
 * Check if an intent is a SCAN-related intent (NanoMind-enhanced HMA scanning).
 * These intents are invoked programmatically by HMA during scanning,
 * not by interactive CLI users.
 */
export function isScanIntent(intent: IntentType): boolean {
  return [
    'SCAN_SKILL_INTENT',
    'SCAN_SOUL_COMPLETENESS',
    'SCAN_MCP_SCOPE',
    'SCAN_PROMPT_INTENT',
    'SCAN_VERSION_DELTA',
    'SCAN_EXPLAIN',
  ].includes(intent);
}

/**
 * SCAN intent response types for structured output.
 */
export interface ScanSkillResult {
  intent: 'malicious' | 'benign' | 'edge_case';
  confidence: number;
  attackClass?: string;
  evidence: string[];
  remediation?: string;
}

export interface ScanSoulResult {
  gaps: Array<{ domain: string; description: string; severity: string }>;
  contradictions: Array<{ section1: string; section2: string; description: string }>;
  enforceabilityScores: Record<string, number>;
  hardeningSuggestions: string[];
  overallCoverage: number; // 0.0-1.0
}

export interface ScanMCPResult {
  scopeMismatch: boolean;
  impliedPermissions: string[];
  socialEngineeringRisk: number; // 0.0-1.0
  toolInteractionFlags: string[];
}

export interface ScanPromptResult {
  intentClassification: 'safe' | 'risky' | 'dangerous';
  jailbreakSeedRisk: number; // 0.0-1.0
  capabilityCreepPatterns: string[];
  overrideRisk: number; // 0.0-1.0
}

export interface ScanVersionDeltaResult {
  intentChanged: boolean;
  behavioralDelta: string;
  rugPullConfidence: number; // 0.0-1.0
}

export interface ScanExplainResult {
  explanation: string;
  attackDescription: string;
  remediationSteps: string[];
}
