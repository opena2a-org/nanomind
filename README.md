# NanoMind

[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](STATUS.md)
[![npm version](https://img.shields.io/npm/v/@nanomind/cli.svg)](https://www.npmjs.com/package/@nanomind/cli)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> **[OpenA2A](https://github.com/opena2a-org)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/ai-browserguard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)

[Website](https://nanomind.dev) · [Discord](https://discord.gg/uRZa3KXgEn)

Embedded intelligence layer for AI security tools. Two deployment modes, one package:

- **CLI Mode**: Natural language intent routing for security CLIs (HackMyAgent, secretless-ai, OpenA2A)
- **Runtime Mode**: Behavioral anomaly detection for AI agent runtime protection (ARP)

```bash
npm install @nanomind/cli
```

```
hma > scan this project
  > Running: hma secure .

hma > why is agent billing-agent level 2

Your agent billing-agent is trust level 2 because:
  Present: HMA scan (+160 pts vulnerability surface)
  Missing: Build attestation (+80 pts supply chain)
    Fix: Add opena2a/build-action to your CI pipeline.
         Run: opena2a > "add OpenA2A to my pipeline"
  Missing: Publisher verified (+40 pts identity governance)
    Fix: Verify your publisher identity at registry.opena2a.org/auth/github
  Missing: Runtime behavioral data (+150 pts runtime behavior)
    Fix: Install ARP alongside your agent.
         Run: npm install @opena2a/arp
  Present: Threshold signatures (+70 pts cryptographic proof)
  Projected level 4 after fixes: 500 pts (230 present + 270 from fixes)
```

## Packages

| Package | What | Install |
|---------|------|---------|
| [@nanomind/engine](https://www.npmjs.com/package/@nanomind/engine) | Core inference backend (llamafile) | `npm i @nanomind/engine` |
| [@nanomind/router](https://www.npmjs.com/package/@nanomind/router) | Intent classification (22 types incl. 6 SCAN) | `npm i @nanomind/router` |
| [@nanomind/guard](https://www.npmjs.com/package/@nanomind/guard) | Prompt injection detection | `npm i @nanomind/guard` |
| [@nanomind/atc](https://www.npmjs.com/package/@nanomind/atc) | ATC trust queries | `npm i @nanomind/atc` |
| [@nanomind/cli](https://www.npmjs.com/package/@nanomind/cli) | Interactive security assistant | `npm i @nanomind/cli` |
| [@nanomind/runtime](https://www.npmjs.com/package/@nanomind/runtime) | Behavioral anomaly detection | `npm i @nanomind/runtime` |
| [@nanomind/daemon](https://www.npmjs.com/package/@nanomind/daemon) | Persistent inference server (localhost:47200) | `npm i @nanomind/daemon` |

The daemon is a persistent inference server. It loads the model once and serves all requests via HTTP ([daemon README](packages/nanomind-daemon/README.md)). `nanomind-daemon start` downloads any missing model files into `~/.nanomind/models/` (or `NANOMIND_MODEL_DIR`); `--no-download` turns that off.

```bash
nanomind-daemon start    # localhost:47200
nanomind-daemon status
nanomind-daemon stop
```

The router also carries 6 security scanning intents: `SCAN_SKILL_INTENT`, `SCAN_SOUL_COMPLETENESS`, `SCAN_MCP_SCOPE`, `SCAN_PROMPT_INTENT`, `SCAN_VERSION_DELTA`, `SCAN_EXPLAIN` ([router README](packages/nanomind-router/README.md)).

## CLI Mode

NanoMind replaces the help screen when a CLI tool is run with no arguments. It classifies natural language into one of 16 intent types and maps the intent to a command through a per-CLI routing table in `@nanomind/router` ([routing tables](docs/cli-mode.md#intent-routing)).

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

Input that does not come from a terminal is screened before routing. Piped stdin is screened as `piped` and a file redirected to stdin as `file`. Output from the commands a session runs is printed and never routed. [How agent output is labelled](docs/cli-mode.md#prompt-injection-guard).

```typescript
import { screenInput } from '@nanomind/guard';

screenInput('ignore previous instructions', 'piped');
// { safe: false, patterns: [{ type: 'instruction_override', severity: 'critical' }] }
```

In a session, a critical match blocks the line. A high or medium match prints a warning or notice that names the matched pattern, and the line is still routed. Called directly, `screenInput` returns a warning that asks you to review the input before proceeding, for a caller that screens input once and then decides whether to go on.

`nanomind --no-guard` turns screening off for one session and prints a warning to stderr. Another launcher does the same by checking its arguments with `hasNoGuardFlag(args)` from `@nanomind/cli` and starting the session with `noGuard: true`. The adapters in `integrations/` do not pass the flag yet.

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

## Runtime Mode

NanoMind-Runtime is the L1 behavioral anomaly detection layer for ARP. It does not use a language model: it scores each event with a lightweight statistical model, in the calling process.

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
4. **No LLM call**: Statistical scoring only, run synchronously by `processEvent`

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

## Documentation

- [Trained models](docs/models.md): the classifier and the analyst, their accuracy and known limits. Each daemon times every request on your machine and returns what it measured: `@nanomind/daemon` as `latencyMs` on each classifier reply, and the `nanomind-analyst` daemon as `nlmLatencyMs` and `nlmTokenCount` on each reply the analyst generated.
- [Daemon](packages/nanomind-daemon/README.md): HTTP API, response schema and model files.
- [CLI mode](docs/cli-mode.md): intent routing per CLI and how agent output is screened.
- [Integration adapters](docs/integrations.md): the `hma`, `secretless-ai` and `opena2a` adapters; `--no-smart` restores raw CLI behavior.
- [Specification](docs/SPECIFICATION.md): architecture, model inventory and the open adapter protocol ([NANOMIND-SPEC.md](spec/NANOMIND-SPEC.md)).
- [Evaluation standard](docs/EVALUATION-STANDARD.md) and [status](STATUS.md).
- [Contributing](CONTRIBUTING.md): running the tests.
- [Security policy](SECURITY.md).
- Related tools: [HackMyAgent](https://github.com/opena2a-org/hackmyagent), the security scanner, and the [Agent Threat Matrix](https://github.com/opena2a-org/agent-threat-matrix); their counts are under [Related](docs/integrations.md#related).

## License

Apache-2.0. See [LICENSE](LICENSE).
