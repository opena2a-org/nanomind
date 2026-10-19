# NanoMind

[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](STATUS.md)
[![npm version](https://img.shields.io/npm/v/@nanomind/cli.svg)](https://www.npmjs.com/package/@nanomind/cli)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> **[OpenA2A](https://github.com/opena2a-org)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/ai-browserguard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)

[Website](https://nanomind.dev) · [Discord](https://discord.gg/uRZa3KXgEn)

Embedded intelligence layer for AI security tools. Two deployment modes:

- **CLI Mode**: Natural language intent routing for security CLIs (HackMyAgent, secretless-ai, OpenA2A)
- **Runtime Mode**: Behavioral anomaly detection for AI agent runtime protection (ARP)

```bash
npm install @nanomind/router
```

```typescript
import { classifyIntent, mapToCommand } from '@nanomind/router';

const intent = classifyIntent('scan this project for vulnerabilities');
console.log(intent.intent, intent.confidence);
console.log(mapToCommand(intent, 'hma'));
```

```
SCAN 0.85
{
  command: 'hma secure',
  args: [ '.' ],
  description: 'Run security scan'
}
```

## Packages

| Package | What | Install |
|---------|------|---------|
| [@nanomind/engine](https://www.npmjs.com/package/@nanomind/engine) | Core inference backend (llamafile) | `npm i @nanomind/engine` |
| [@nanomind/router](https://www.npmjs.com/package/@nanomind/router) | Intent classification (22 types incl. 6 SCAN) | `npm i @nanomind/router` |
| [@nanomind/guard](https://www.npmjs.com/package/@nanomind/guard) | Prompt injection detection | `npm i @nanomind/guard` |
| [@nanomind/atc](https://www.npmjs.com/package/@nanomind/atc) | ATC trust queries | `npm i @nanomind/atc` |
| [@nanomind/cli](https://www.npmjs.com/package/@nanomind/cli) | Interactive security assistant | `npm i @nanomind/cli` |
| [@nanomind/runtime-core](https://www.npmjs.com/package/@nanomind/runtime-core) | Behavioral anomaly detection | `npm i @nanomind/runtime-core` |
| [@nanomind/daemon](https://www.npmjs.com/package/@nanomind/daemon) | Persistent inference server (localhost:47200) | `npm i @nanomind/daemon` |

The daemon is a persistent inference server. It loads the model once and serves all requests via HTTP ([daemon README](packages/nanomind-daemon/README.md)). `nanomind-daemon start` downloads any missing model files into `~/.nanomind/models/`; `--no-download` turns that off.

```bash
nanomind-daemon start    # localhost:47200
nanomind-daemon status
nanomind-daemon stop
```

## CLI Mode

NanoMind replaces the help screen when a CLI tool is run with no arguments. It classifies natural language into one of 22 intent types or `UNKNOWN` and maps the intent to a command through a per-CLI routing table in `@nanomind/router` ([routing tables](docs/cli-mode.md#intent-routing)).

### Intent Types

| Category | Intents |
|----------|---------|
| Security | SCAN, FIX, EXPLAIN, COMPARE, STATUS, SECRETS_EXPOSE |
| Generation | GENERATE (9 CI/CD artifact types) |
| Trust (ATC) | TRUST_QUERY, ATC_STATUS, RISK_SCORE, REVOCATION, EXPOSURE, ATTEST |
| Scanning | SCAN_SKILL_INTENT, SCAN_SOUL_COMPLETENESS, SCAN_MCP_SCOPE, SCAN_PROMPT_INTENT, SCAN_VERSION_DELTA, SCAN_EXPLAIN ([router README](packages/nanomind-router/README.md)) |
| General | HELP, CONFIG, NAVIGATE |

### Prompt Injection Guard

Input that does not come from a terminal is screened before routing. Piped stdin is screened as `piped` and a file redirected to stdin as `file`. Output from the commands a session runs is printed and never routed. [How agent output is labelled](docs/cli-mode.md#prompt-injection-guard).

```typescript
import { screenInput } from '@nanomind/guard';

screenInput('ignore previous instructions', 'piped');
// { safe: false, patterns: [{ type: 'instruction_override', severity: 'critical' }] }
```

In a session, a critical match blocks the line. A high or medium match prints a warning or notice that names the matched pattern, and the line is still routed.

Called directly, `screenInput` returns a warning that asks you to review the input before proceeding, for a caller that screens input once and then decides whether to go on.

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

`RuntimeTwin` from `@nanomind/runtime-core` is the L1 behavioral anomaly detection layer for ARP. It does not use a language model: it scores each event with a lightweight statistical model, in the calling process. The earlier `@nanomind/runtime` package on npm is not built from this repository.

### Three-Tier ARP Model

| Tier | Layer | Latency | What |
|------|-------|---------|------|
| L0 | Rule-based | microseconds | Capability enforcement |
| **L1** | **RuntimeTwin** | **milliseconds** | **Behavioral anomaly detection** |
| L2 | Fleet intelligence | continuous | Federated model improvement |

### Anomaly Detection

The package's `main` is its TypeScript source, which Node does not load from `node_modules`, so import the compiled `dist/index.js`:

```typescript
import { RuntimeTwin } from '@nanomind/runtime-core/dist/index.js';

const twin = new RuntimeTwin('my-agent');

const result = twin.processEvent({
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

`processEvent` appends each event to `~/.opena2a/arp/events.jsonl`. `twin.attach(engine)` scores the events an ARP event engine emits; `twin.scoreARPEvent(event)` scores one event without changing the baseline and returns `null` until the baseline holds 100 events.

### Federated Learning

Off by default. With `fleetEnabled: true`, the twin posts a 9-value gradient with differential privacy to the OpenA2A Registry after every 300 events and on `shutdown()`. A failed post does not stop scoring.

```typescript
const twin = new RuntimeTwin('my-agent', { fleetEnabled: true, agentCategory: 'financial' });
// ...
await twin.shutdown(); // posts what accumulated since the last gradient
```

- Raw behavioral events never leave the endpoint; a gradient carries `agentCategory`, not `agentId`
- Gaussian noise (ε=1.0, δ=1e-5)
- Gradient clipping (L2 norm ≤ 1.0)

## Documentation

- [Trained models](docs/models.md): accuracy and known limits. Each daemon returns what it measured on your machine: `latencyMs` (`@nanomind/daemon`), `nlmLatencyMs` and `nlmTokenCount` (`nanomind-analyst`).
- [Daemon](packages/nanomind-daemon/README.md): HTTP API, response schema and model files.
- [CLI mode](docs/cli-mode.md): intent routing per CLI and how agent output is screened.
- [Runtime scoring](docs/how-it-works.md): the baseline `RuntimeTwin` learns, its six anomaly factors and its five responses.
- [Integration adapters](docs/integrations.md): the `hma`, `secretless-ai` and `opena2a` adapters; `--no-smart` restores raw CLI behavior.
- [Specification](docs/SPECIFICATION.md): architecture, model inventory and the open adapter protocol ([NANOMIND-SPEC.md](spec/NANOMIND-SPEC.md)).
- [Evaluation standard](docs/EVALUATION-STANDARD.md), [status](STATUS.md) and [security policy](SECURITY.md).
- [Contributing](CONTRIBUTING.md): running the tests.
- Related tools: [HackMyAgent](https://github.com/opena2a-org/hackmyagent), the security scanner, and the [Agent Threat Matrix](https://github.com/opena2a-org/agent-threat-matrix); their counts are under [Related](docs/integrations.md#related).

## License

Apache-2.0. See [LICENSE](LICENSE).
