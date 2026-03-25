# @nanomind/router

Intent classification and command mapping for CLI security tools. Classifies natural language into 16 intent types.

## Install

```bash
npm install @nanomind/router
```

## Usage

```typescript
import { classifyIntent, mapToCommand } from '@nanomind/router';

const result = classifyIntent('scan this project for vulnerabilities');
// { intent: 'SCAN', confidence: 0.85, entities: {} }

const cmd = mapToCommand(result, 'hma');
// { command: 'hma secure', args: ['.'], description: 'Run security scan' }
```

## Intent Types

| Intent | Example |
|--------|---------|
| SCAN | "scan this project" |
| FIX | "fix the credential issue" |
| EXPLAIN | "what does CRED-001 mean" |
| TRUST_QUERY | "what's the trust level" |
| ATC_STATUS | "why is my agent level 2" |
| ATTEST | "add trust to my CI" |
| + 10 more | See [spec](https://github.com/opena2a-org/nanomind/blob/main/spec/intent-schema.json) |

## License

MIT
