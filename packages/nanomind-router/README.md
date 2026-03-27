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

### General Intents

| Intent | Example | Maps To |
|--------|---------|---------|
| SCAN | "scan this project" | `hma secure` |
| FIX | "fix the credential issue" | `hma secure --fix` |
| EXPLAIN | "what does CRED-001 mean" | `hma explain CRED-001` |
| TRUST_QUERY | "what's the trust level" | `hma trust` |
| ATC_STATUS | "why is my agent level 2" | `opena2a identity status` |
| ATTEST | "add trust to my CI" | `opena2a identity attest` |
| PROTECT | "protect my credentials" | `secretless-ai init` |
| REVIEW | "review my project security" | `opena2a review` |
| HELP | "how do I use this" | `--help` |
| CONFIG | "set my API key" | `opena2a config` |
| UNKNOWN | (low confidence) | Show suggestions |

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

MIT
