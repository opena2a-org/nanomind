# @nanomind/router

Intent classification and command mapping for CLI security tools. Classifies natural language into 17 intent types including 6 security scanning intents.

## Install

```bash
npm install @nanomind/router
```

## Usage

```typescript
import { classifyIntent, mapToCommand, isScanIntent } from '@nanomind/router';

const result = classifyIntent('scan this project for vulnerabilities');
// { intent: 'SCAN', confidence: 0.85, entities: {} }

const cmd = mapToCommand(result, 'hma');
// { command: 'hma secure', args: ['.'], description: 'Run security scan' }

// Check if an intent is a security scan (needs full model inference)
isScanIntent('SCAN_SKILL'); // true
isScanIntent('EXPLAIN');     // false
```

## Intent Types

### General Intents and Routes

`mapToCommand(classification, cliName, table?)` looks the intent up in a per-CLI table: the one passed in, else `COMMAND_TABLES[cliName]`, else the default routes. Each route in `COMMAND_TABLES` names a command that the owning CLI's adapter in `integrations/` lists in `getCommandManifest()`. An intent the table has no route for maps to `null`.

| Intent | Example | `hma` | `secretless-ai` | `opena2a` |
|--------|---------|-------|-----------------|-----------|
| SCAN | "scan this project" | `hma secure .` | `secretless-ai scan` | `opena2a scan .` |
| SCAN, input says "detect" | "detect agents in this project" | `hma detect .` | `secretless-ai scan` | `opena2a detect .` |
| SCAN, input names a package | "check package: express" | `hma check express` | `secretless-ai scan` | `opena2a scan .` |
| SECRETS_EXPOSE | "check for exposed secrets" | `hma secure .` | `secretless-ai diagnose` | `opena2a secretless` |
| FIX | "fix the credential issue" | `hma secure --fix` | no route | no route |
| STATUS | "show status" | `hma secure --summary` | `secretless-ai verify` | `opena2a review` |
| TRUST_QUERY | "trust level of agent: my-agent" | `opena2a trust my-agent` | `opena2a trust my-agent` | `opena2a trust my-agent` |
| ATC_STATUS | "why is my score low" | `opena2a trust explain` | `opena2a trust explain` | `opena2a trust explain` |
| ATTEST | "add trust attestation to my CI" | `opena2a attest` | `opena2a attest` | `opena2a attest` |
| HELP | "help" | `hma --help` | `secretless-ai --help` | `opena2a --help` |

A package name or agent id taken from the input is appended to the command only when it is a plain argument (`isPlainArgument`: ASCII letters, digits and `@ . : / + - _`, starting with a letter, digit or `@`). Otherwise that route is skipped and the next route for the intent applies, or the intent maps to `null` when there is none, so "check package: x;echo" runs `hma secure .` in `hma`.

EXPLAIN, GENERATE, COMPARE, CONFIG, NAVIGATE, RISK_SCORE, REVOCATION and EXPOSURE are classified but have no route in these tables, and UNKNOWN never has one. A CLI without a table gets `<cli> secure .` for SCAN and SECRETS_EXPOSE, `<cli> secure --fix` for FIX, `<cli> secure --summary` for STATUS, and the ATC and HELP routes above.

### Security Scanning Intents (SCAN_*)

These intents require full NanoMind model inference via the daemon. Used by HackMyAgent's Semantic Compiler.

| Intent | Purpose | Used By |
|--------|---------|---------|
| SCAN_SKILL | Classify skill artifacts for attack patterns | SemanticCompiler |
| SCAN_MCP | Analyze MCP server configurations | SemanticCompiler |
| SCAN_SOUL | Evaluate governance document completeness | SemanticCompiler |
| SCAN_CREDENTIAL | Detect credential exposure in context | SemanticCompiler |
| SCAN_CODE | Identify code injection patterns | SemanticCompiler |
| COMPILE_AST | Full AST compilation (all analyzers) | SemanticCompiler |

## Confidence Scoring

The classifier returns a confidence score between 0 and 1:

| Range | Meaning |
|-------|---------|
| 0.8-1.0 | High confidence, route directly |
| 0.5-0.8 | Medium confidence, may prompt for clarification |
| 0.0-0.5 | Low confidence, show suggestions |

## License

Apache-2.0
