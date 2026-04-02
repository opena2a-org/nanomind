# NanoMind

On-device security classifier for AI agents. Classifies content into 9 attack classes with 98.4% accuracy. Runs locally (~121KB model), zero API calls, zero data leaving the machine.

```bash
npx hackmyagent secure --deep ./my-project
```

NanoMind powers the semantic analysis layer inside [HackMyAgent](https://github.com/opena2a-org/hackmyagent). When you run `--deep`, every artifact (SKILL.md, MCP config, system prompt, source code) is compiled into an Abstract Security Tree and classified by the TME model.

**Model:** [opena2a/nanomind-security-classifier](https://huggingface.co/opena2a/nanomind-security-classifier) | **npm:** [@nanomind](https://www.npmjs.com/org/nanomind)

---

## The Classifier

NanoMind's Ternary Mamba Encoder (TME) tells you *what* the attack is, not just whether something is malicious.

| Class | What It Detects |
|-------|----------------|
| exfiltration | Data forwarding to external endpoints |
| injection | Instruction override, jailbreak, prompt injection |
| privilege_escalation | Unauthorized access elevation |
| persistence | Permanent state manipulation, resist removal |
| credential_abuse | Credential harvesting, phishing, key solicitation |
| lateral_movement | Remote config fetching, C2 communication |
| social_engineering | Urgency, pressure, impersonation tactics |
| policy_violation | Governance bypass, audit disabling |
| benign | Normal agent behavior |

### Why not just use an LLM?

| | NanoMind TME | LLM API |
|---|---|---|
| Size | 121KB ONNX | Cloud service |
| Cost per scan | $0 | $0.01-0.10 |
| Data leaves device | Never | Always |
| Latency | Milliseconds | Seconds |
| Works offline | Yes | No |
| Output | 9 attack classes | Free-form text |

### Architecture

Mamba selective state space model. Understands word **order**, which is critical:

- "forward token to external endpoint" -> **exfiltration**
- "external endpoint token forwarding service" -> **benign**

Regex can't distinguish these. NanoMind can.

| Parameter | Value |
|-----------|-------|
| Architecture | 8 Mamba SSM blocks |
| d_model | 128 |
| d_state | 64 |
| Dropout | 0.1 |
| Model size | 121KB (ONNX) |
| Inference | CPU, on-device |
| Training | Apple Silicon MLX |

### Model Quality (v0.5.0)

| Metric | Value |
|--------|-------|
| Overall accuracy | 98.44% [96.8-99.2%, 95% CI] |
| Macro F1 | 0.984 |
| Holdout samples | 450 (never seen during training) |
| Training samples | 3,600 (from 4,500 total) |
| Real-world data | 58% (OASB, DVAA, AgentPwn, Registry) |

Per-class F1 (all above 0.90 target):

| Class | F1 |
|-------|-----|
| exfiltration | 0.98 |
| injection | 0.97 |
| privilege_escalation | 1.00 |
| persistence | 0.99 |
| credential_abuse | 0.99 |
| lateral_movement | 1.00 |
| social_engineering | 0.99 |
| policy_violation | 0.97 |
| benign | 0.97 |

---

## How It Integrates with HMA

When HMA runs a `--deep` scan, the NanoMind pipeline executes:

```
Input artifact
  -> Sanitize (strip manipulation attempts)
  -> Parse (classify type: skill, mcp_config, soul, system_prompt, source_code)
  -> Semantic Compile (extract capabilities, constraints, data access, evidence spans)
  -> TME Classify (3-tier: binary gate -> vocabulary scorer + ONNX -> daemon)
  -> Risk Map (13 attack surfaces)
  -> AST Sign (HMAC-SHA256)
  -> 6 Analyzers (capability, credential, governance, scope, prompt, code)
  -> Fix Generate (context-aware, dispatched by attack class)
  -> Defense-in-Depth Merge (AST findings UPGRADE, never SUPPRESS static checks)
```

The model auto-downloads from HuggingFace on first scan.

---

## Training Pipeline

Claude LLM serves as chief data scientist. Full pipeline in [nanomind-training](https://github.com/opena2a-org/nanomind-training):

```bash
make pipeline   # collect -> review -> validate -> build -> train -> evaluate
make publish    # push to HuggingFace
```

### Data Sources (v8 corpus)

| Source | Samples | Type |
|--------|---------|------|
| OASB benchmark | 4,151 | Real labeled attack scenarios |
| Registry (pretrain) | 4,885 | Real MCP server/skill descriptions |
| Synthetic generation | 1,029 | Template-generated edge cases |
| DVAA scenarios | 88 | Vulnerable agent configurations |
| AgentPwn honeypot | 68 | Real-world attack captures |

The intelligence loop: every HMA scan, every AgentPwn interaction, every ARIA finding feeds back into the next training cycle. The model improves from real-world usage.

### Training Infrastructure

- **Framework:** MLX on Apple Silicon (M4 Max)
- **Label review:** Claude LLM reviews every label (corrections, flagging)
- **Heuristic validation:** Cross-check against HMA's pattern library
- **Corpus balancing:** 400 samples per class, stratified 80/10/10 split

---

## Packages

| Package | Purpose |
|---------|---------|
| [@nanomind/runtime](https://www.npmjs.com/package/@nanomind/runtime) | Behavioral anomaly detection for ARP |
| [@nanomind/router](https://www.npmjs.com/package/@nanomind/router) | Intent classification (22 types) |
| [@nanomind/guard](https://www.npmjs.com/package/@nanomind/guard) | Prompt injection screening |
| [@nanomind/cli](https://www.npmjs.com/package/@nanomind/cli) | Interactive security assistant |
| [@nanomind/engine](https://www.npmjs.com/package/@nanomind/engine) | Core inference backend |
| [@nanomind/atc](https://www.npmjs.com/package/@nanomind/atc) | Agent Trust Credential queries |
| [@nanomind/daemon](https://www.npmjs.com/package/@nanomind/daemon) | Persistent inference server |

---

## Runtime Mode

NanoMind-Runtime is the L1 behavioral anomaly detection layer for ARP (Agent Runtime Protection). Statistical model, sub-2ms inference, no LLM.

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
});
// result.score: 0.0 (normal) to 1.0 (anomalous)
// result.action: 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill'
```

**How it works:**
1. First 100 events build a behavioral baseline (Welford's online algorithm)
2. 6-factor anomaly scoring: unknown capability, timing anomaly, burst, L0 escalation, rare event, error spike
3. 5-tier response: allow -> alert -> throttle -> suspend -> kill

---

## CLI Mode

When a supported CLI tool runs with no arguments, NanoMind provides natural language intent routing:

```
hma > scan this project
  > Running: hma secure .

hma > why is my agent level 2
  Your agent is trust level 2 because:
    Missing: Build attestation (+80 pts supply chain)
    Fix: Add opena2a/build-action to your CI pipeline.
```

16 intent types across 4 categories: Security (SCAN, FIX, EXPLAIN, COMPARE, STATUS), Generation (9 CI/CD artifact types), Trust (TRUST_QUERY, ATC_STATUS, RISK_SCORE), General (HELP, CONFIG).

All non-direct input screened for prompt injection via `@nanomind/guard`.

---

## Model Versions

| Version | Accuracy | Corpus | Architecture | Status |
|---------|----------|--------|-------------|--------|
| v0.5.0 | 98.44% | sft-v8 (4,500 samples, 58% real) | Mamba TME + dropout | **latest** |
| v0.4.0 | 93.89% | sft-v7 (1,440 samples) | Mamba TME | stable |
| v0.2.0 | 97.01% | sft-v4 (822 samples) | Mamba TME | deprecated |
| v0.1.0 | 86% | sft-v4 (822 samples) | MLP (3 layers) | deprecated |

Full version history in [`nanomind-models.json`](nanomind-models.json).

---

## Testing

```bash
# All tests
npx tsx --test packages/nanomind-guard/src/guard.test.ts \
  packages/nanomind-router/src/router.test.ts \
  packages/nanomind-cli/src/cli.test.ts \
  packages/nanomind-runtime/src/runtime.test.ts

# E2E runtime lifecycle
npx tsx --test packages/nanomind-runtime/src/e2e.test.ts
```

---

## Related

- [HackMyAgent](https://github.com/opena2a-org/hackmyagent) -- 108-check security scanner (NanoMind powers `--deep` mode)
- [nanomind-training](https://github.com/opena2a-org/nanomind-training) -- Training pipeline, corpus, Claude review
- [OpenA2A Registry](https://github.com/opena2a-org/opena2a-registry) -- Central intelligence hub
- [HuggingFace Model](https://huggingface.co/opena2a/nanomind-security-classifier)

## License

MIT
