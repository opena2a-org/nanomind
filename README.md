# NanoMind

[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](./STATUS.md)

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
| [@nanomind/router](https://www.npmjs.com/package/@nanomind/router) | Intent classification (22 types incl. 6 SCAN) | `npm i @nanomind/router` |
| [@nanomind/guard](https://www.npmjs.com/package/@nanomind/guard) | Prompt injection detection | `npm i @nanomind/guard` |
| [@nanomind/atc](https://www.npmjs.com/package/@nanomind/atc) | ATC trust queries | `npm i @nanomind/atc` |
| [@nanomind/cli](https://www.npmjs.com/package/@nanomind/cli) | Interactive security assistant | `npm i @nanomind/cli` |
| [@nanomind/runtime](https://www.npmjs.com/package/@nanomind/runtime) | Behavioral anomaly detection | `npm i @nanomind/runtime` |
| **@nanomind/daemon** (NEW) | Persistent inference server (localhost:47200) | In packages/ |

## Daemon Server (NEW)

Persistent inference server. Loads model once, serves all requests via HTTP.

```bash
nanomind-daemon start    # localhost:47200
nanomind-daemon status
nanomind-daemon stop
```

## SCAN Intents (NEW)

6 security scanning intents: `SCAN_SKILL_INTENT`, `SCAN_SOUL_COMPLETENESS`, `SCAN_MCP_SCOPE`, `SCAN_PROMPT_INTENT`, `SCAN_VERSION_DELTA`, `SCAN_EXPLAIN`

## Trained Models

| Model | Visibility | Architecture | Accuracy | Status |
|-------|-----------|--------------|----------|--------|
| [nanomind-security-classifier](https://huggingface.co/opena2a/nanomind-security-classifier) | Public | Mamba TME (10 classes) | Recall 100%, Precision 79.6%, F1 88.7%, Benign FPR 9.1% (oracle-verified, TME v5 2026-04-15) | Production (v0.5.0 — terminal classifier release per CDS-003) |
| [nanomind-security-analyst](https://huggingface.co/opena2a/nanomind-security-analyst) | Public | Qwen3-1.7B SFT LoRA r=64 (10 classes) | Oracle 10-way 70.0%, binary 97.8%, attack-only 9-way 67.3%, internal 332-sample 94.24% (off-topic handled by the v3.1 input gate) | Production (v3.0.0, published 2026-05-11) |
| nanomind-mcp-analyzer | Internal | Planned | -- | Planned |
| nanomind-trust-scorer | Internal | Planned | -- | Planned |
| nanomind-runtime-guard | Internal | Planned | -- | Planned |

> **Two production model lines.** The Mamba TME **classifier** (v0.5.0) handles fast inline classification at the NLM tier (~2M params, ONNX, <1ms inference). The Qwen3-1.7B **analyst** (v3.0.0) handles generative threat reasoning at the SLM tier (~1.7B params, MPS bf16, ~18ms/token, structured Analysis/Verdict/Evidence/Remediation output). Both are public on HuggingFace under Apache-2.0 (analyst inherits Qwen3 license on base weights).
>
> **v3.0.0 — FP-suppression on benign security code (corrected 2026-06-03).** The analyst can over-classify legitimate JWT validators, RBAC middleware, parameterized queries, rate limiters, and OAuth/crypto code as threats. On a repaired 82-sample gate of *real* security-library source it correctly clears **77%** (63/82) as benign; the originally documented 57% / 43%-FP figure was measured on a gate later found to be 41% placeholder filler, which understated reliability. On ordinary benign artifacts the false-positive rate is ~1%; the over-flagging is concentrated on dual-use security code, where roughly 1 in 4 may still be over-flagged, so spot-checking findings on dedicated security libraries remains advisable. A corpus retrain (v3.1) was a no-go; the scoped fix is a benign-security pre-pass, not corpus expansion. See model card §Known Limitations §2.
>
> **Off-topic refusal requires the v3.1 input-classifier gate.** The analyst alone refuses only 34% of off-topic inputs (specialist model trained exclusively on security artifacts). The v3.1 input-classifier gate (PR #13, 1e90bf8 — sentence-transformers/all-MiniLM-L6-v2 + sklearn LogisticRegression + byte-level BIDI/stego pre-filter) runs in front of the NLM and ships at threshold 0.90 (raised from 0.65 per CDS-029, prioritizing attack recall). An earlier 92% end-to-end off-topic-refusal figure was measured at threshold 0.65 and is not the current operating point. The gate ships with the NanoMind-Guard daemon (PR #14, f98e649) and is REQUIRED for any consumer surface that may receive non-security inputs. Serving runtime: `/tmp/nanomind-guard.sock`.

Model versions tracked in [`nanomind-models.json`](nanomind-models.json). Publishing automated via GitHub Actions.


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
- [HackMyAgent](https://github.com/opena2a-org/hackmyagent) — security scanner: 310 static checks across 69 categories, 29 NanoMind semantic checks across 7 analyzers, 164 adversarial payloads, as of 2026-08-25 (hackmyagent 0.32.0; static counts: `npx hackmyagent check-metadata --json`)
- [Agent Threat Matrix](https://github.com/opena2a-org/agent-threat-matrix) — 61 techniques, 40 attack classes, 9 tactics, as of 2026-08-25 (Matrix v1.1; live counts: `curl -s https://api.oa2a.org/api/v1/threat-matrix/stats`)

## License

MIT
