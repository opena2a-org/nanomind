# NanoMind

Embedded intelligence layer for AI security tools. Two deployment modes, one package:

- **CLI Mode**: Natural language intent routing for security CLIs (HackMyAgent, secretless-ai, OpenA2A)
- **Runtime Mode**: Behavioral anomaly detection for AI agent runtime protection (ARP)

```bash
npm install @nanomind/cli
```

```
hma > scan this project
  > Running: hma secure .

hma > why is my agent level 2
  Your agent is trust level 2 because:
    Missing: Build attestation (+80 pts supply chain)
    Fix: Add opena2a/build-action to your CI pipeline.
    Present: HMA scan passed (+160 pts vulnerability surface)
    Projected level 3 after fixes: 743 pts
```

**Spec:** [nanomind.dev](https://nanomind.dev) | **npm:** [@nanomind](https://www.npmjs.com/org/nanomind)

---

## Packages

| Package | What | Install |
|---------|------|---------|
| [@nanomind/engine](https://www.npmjs.com/package/@nanomind/engine) | Core inference backend (llamafile) | `npm i @nanomind/engine` |
| [@nanomind/router](https://www.npmjs.com/package/@nanomind/router) | Intent classification (16 types) | `npm i @nanomind/router` |
| [@nanomind/guard](https://www.npmjs.com/package/@nanomind/guard) | Prompt injection detection | `npm i @nanomind/guard` |
| [@nanomind/atc](https://www.npmjs.com/package/@nanomind/atc) | ATC trust queries | `npm i @nanomind/atc` |
| [@nanomind/cli](https://www.npmjs.com/package/@nanomind/cli) | Interactive security assistant | `npm i @nanomind/cli` |
| [@nanomind/runtime](https://www.npmjs.com/package/@nanomind/runtime) | Behavioral anomaly detection | `npm i @nanomind/runtime` |

---

## CLI Mode

NanoMind replaces the help screen when a CLI tool is run with no arguments. It classifies natural language into one of 16 intent types and routes to the appropriate command.

### Intent Classification

```typescript
import { classifyIntent, mapToCommand } from '@nanomind/router';

const result = classifyIntent('scan this project for vulnerabilities');
// { intent: 'SCAN', confidence: 0.85, entities: {} }

const cmd = mapToCommand(result, 'hma');
// { command: 'hma secure', args: ['.'], description: 'Run security scan' }
```

### 16 Intent Types

| Category | Intents |
|----------|---------|
| Security | SCAN, FIX, EXPLAIN, COMPARE, STATUS, SECRETS_EXPOSE |
| Generation | GENERATE (9 CI/CD artifact types) |
| Trust (ATC) | TRUST_QUERY, ATC_STATUS, RISK_SCORE, REVOCATION, EXPOSURE, ATTEST |
| General | HELP, CONFIG, NAVIGATE |

### Prompt Injection Guard

All non-direct input (piped, file, agent output) is screened before routing:

```typescript
import { screenInput } from '@nanomind/guard';

screenInput('ignore previous instructions', 'piped');
// { safe: false, patterns: [{ type: 'instruction_override', severity: 'critical' }] }
```

Detects: instruction override, role switching, permission escalation, zero-width character injection, encoded payloads.

### Teach Mode

7-step guided onboarding for new users:

1. Detect project type
2. Run HMA scan, explain findings
3. Offer auto-fix with rollback
4. Generate CI/CD artifact
5. Show current trust level (if registered)
6. Explain ATC and trust levels
7. Generate build attestation config

### CI/CD Artifact Generation

9 artifact types: GitHub Actions, GitLab CI, Azure Pipelines, CircleCI, Docker Compose, Dockerfile, pre-commit, Makefile, ATC build-action.

---

## Runtime Mode

NanoMind-Runtime is the L1 behavioral anomaly detection layer for ARP. It does not use a language model — it uses a lightweight statistical model for sub-2ms inference.

### Three-Tier ARP Model

| Tier | Layer | Latency | What |
|------|-------|---------|------|
| L0 | Rule-based | microseconds | Capability enforcement |
| **L1** | **NanoMind-Runtime** | **milliseconds** | **Behavioral anomaly detection** |
| L2 | Fleet intelligence | continuous | Federated model improvement |

### Anomaly Detection

```typescript
import { NanoMindRuntime } from '@nanomind/runtime';

const runtime = new NanoMindRuntime('my-agent');
await runtime.initialize();

const result = runtime.processEvent({
  agentId: 'my-agent',
  eventType: 'TOOL_CALL',
  capability: 'db:read',
  timestampDelta: 50,
  l0Decision: 'allow',
  // ...
});

// result.score: 0.0 (normal) → 1.0 (anomalous)
// result.action: 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill'
```

### How It Works

1. **Baseline learning**: First 100 events build a behavioral baseline using Welford's online algorithm
2. **6-factor anomaly scoring**: unknown capability, timing anomaly, burst detection, L0 escalation, rare event type, error spike
3. **5-tier response**: allow → alert → throttle → suspend → kill
4. **Sub-2ms latency**: Statistical model, no LLM

### Federated Learning

Gradients submitted with differential privacy to the OpenA2A Registry for fleet-wide model improvement:

```typescript
import { addDifferentialPrivacy, submitGradient } from '@nanomind/runtime/fleet';

const noisy = addDifferentialPrivacy(gradient, { epsilon: 1.0 });
await submitGradient(noisy, eventCount, loss);
```

- Raw behavioral events never leave the endpoint
- Gaussian noise (ε=1.0, δ=1e-5)
- Gradient clipping (L2 norm ≤ 1.0)

---

## Integration Adapters

| Tool | Adapter | What Happens |
|------|---------|-------------|
| HackMyAgent | `integrations/hma/` | `hma` with no args → NanoMind interactive |
| secretless-ai | `integrations/secretless-ai/` | `secretless-ai` with no args → NanoMind |
| OpenA2A CLI | `integrations/opena2a/` | Cross-product router |
| ARP | `integrations/arp/` | NanoMindL1 attaches to EventEngine |

`--no-smart` always restores raw CLI behavior. `--help` is never intercepted.

---

## Open Protocol

NanoMind is an open protocol (MIT). Any CLI tool can implement the adapter interface:

```typescript
interface NanoMindCLIAdapter {
  cliName: string;
  cliVersion: string;
  getCommandManifest(): CommandManifest;
  executeCommand(cmd: string): Promise<ExecutionResult>;
  getScanHistory(): ScanHistoryEntry[];
  getATCData?(): ATCData;
}
```

See [NANOMIND-SPEC.md](spec/NANOMIND-SPEC.md) for the full specification.

---

## Testing

```bash
# All tests (56 total)
npx tsx --test packages/nanomind-guard/src/guard.test.ts \
  packages/nanomind-router/src/router.test.ts \
  packages/nanomind-cli/src/cli.test.ts \
  packages/nanomind-runtime/src/runtime.test.ts \
  packages/nanomind-runtime/src/fleet.test.ts

# E2E: full runtime lifecycle including production gradient submission
npx tsx --test packages/nanomind-runtime/src/e2e.test.ts
```

---

## Related

- [OpenA2A Registry](https://github.com/opena2a-org/opena2a-registry) — issues ATCs, hosts fleet intelligence
- [HackMyAgent](https://github.com/opena2a-org/hackmyagent) — 204-check security scanner
- [Agent Threat Matrix](https://github.com/opena2a-org/agent-threat-matrix) — 57 techniques, 36 attack classes

## License

MIT
