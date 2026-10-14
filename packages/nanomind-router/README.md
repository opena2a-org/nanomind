# @nanomind/router

Intent classification and command mapping for CLI security tools. `IntentType` names 22 intents plus `UNKNOWN`, 6 of them security scanning intents.

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

// Check if an intent is one of the 6 security scanning intents
isScanIntent('SCAN_SKILL_INTENT'); // true
isScanIntent('EXPLAIN');           // false
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

`isScanIntent(intent)` returns `true` for these 6 intents. None of them has a route in `COMMAND_TABLES` or in the default routes, so `mapToCommand` maps each of them to `null`.

| Intent | Purpose | Example input |
|--------|---------|---------------|
| SCAN_SKILL_INTENT | Skill malicious intent classification | "scan skill intent malicious" |
| SCAN_SOUL_COMPLETENESS | SOUL.md governance completeness analysis | "soul governance completeness gaps" |
| SCAN_MCP_SCOPE | MCP tool description scope analysis | "mcp tool description scope analysis" |
| SCAN_PROMPT_INTENT | System prompt behavioral envelope analysis | "system prompt behavioral envelope" |
| SCAN_VERSION_DELTA | Semantic diff between skill versions | "version delta semantic diff" |
| SCAN_EXPLAIN | Human-readable explanation of any finding | "explain finding SKILL-007" |

## Confidence Scoring

The classifier returns a confidence score between 0 and 1:

| Range | Meaning |
|-------|---------|
| 0.8-1.0 | High confidence, route directly |
| 0.5-0.8 | Medium confidence, may prompt for clarification |
| 0.0-0.5 | Low confidence, show suggestions |

## License

Apache-2.0
