---
license: apache-2.0
base_model: Qwen/Qwen3-1.7B
language:
- en
library_name: transformers
pipeline_tag: text-generation
tags:
- security
- threat-analysis
- ai-agent-security
- nanomind
- opena2a
- qwen3
- lora
- sft
- structured-output
model-index:
- name: nanomind-security-analyst
  results:
  - task:
      type: text-classification
      name: AI Agent Threat Classification (10-way)
    metrics:
    - type: accuracy
      value: 0.7000
      name: Oracle 10-way canonicalized accuracy
    - type: accuracy
      value: 0.978
      name: Oracle binary (threat vs benign)
    - type: accuracy
      value: 0.6733
      name: Oracle attack-only 9-way
    - type: accuracy
      value: 0.9424
      name: Internal 332-sample accuracy
    - type: f1
      value: 0.7146
      name: Macro F1 (10-class)
---

# Model Card: nanomind-v3-qwen3-1.7B-sft-r64

## At a glance

| | |
|---|---|
| **Version** | v3.0.0 stable (PRODUCTION) |
| **Released** | 2026-05-11 |
| **Promoted from** | v3.0.0-beta (2026-04-16) — same artifact, [CDS-020] CPO sign-off |
| **Base model** | Qwen3-1.7B (Qwen3 license inherited) |
| **License** | Apache-2.0 (fine-tune) + Qwen3 license (base) |
| **Architecture** | Qwen3-1.7B + LoRA r=64 SFT fused (bfloat16) |
| **Model size** | 3.44 GB (safetensors), 1.05 GB (Q4_K_M GGUF) |
| **Inference** | Apple MPS bf16 required; ~18 ms/token, ~55 tok/s |
| **Companion model** | nanomind-security-classifier v0.5.0 (Mamba TME, NLM tier — runs in parallel for fast inline classification) |
| **Serving runtime** | NanoMind-Guard daemon (PR #14, `f98e649`) — `/tmp/nanomind-guard.sock` over JSON-Lines |
| **Input gate (REQUIRED)** | v3.1 input-classifier gate (PR #13, `1e90bf8`) — MiniLM-L6 + sklearn LR @ threshold 0.65 + byte-level BIDI/stego pre-filter. Without this gate, off-topic refusal drops from 92% to 34%. |
| **Training repo** | nanomind-training (private), tag `v3.0.0` |

## Decision history

- **[CDS-020]** 2026-05-11 — v3.0.0 stable promotion. Same artifact as 3.0.0-beta, promoted with explicit CPO sign-off on the documented FP-suppression limitation (see §Known Limitations §2). HMA users must human-review findings on packages whose primary purpose is security functionality.
- **[CDS-022]** 2026-04-16 — Beta retag of rc1 (ship with 2 failing gates documented).
- **[CDS-003]** Classifier line ended at v0.5.0 (Mamba TME). Future analyst work is the SLM-tier line (this model and successors).

## Summary

Generative threat analysis model fine-tuned from Qwen3-1.7B using SFT (LoRA r=64) on the
`instruct-v3-enriched` corpus. Replaces the Mamba TME classifier with a reasoning-first
generative approach: given an AI agent artifact (npm package, MCP config, GitHub repo), the
model produces structured analysis (Analysis / Verdict / Evidence / Remediation sections) with
an explicit `attackClass` and `classification` label.

Oracle 10-way canonicalized accuracy: 70.0% (≥70% ship gate exact). Binary threat detection:
97.8% (+19.6 pp vs v2). Internal 332-sample accuracy: 94.24%. **Promoted to v3.0.0 stable on
2026-05-11 per [CDS-020] CPO sign-off** with two documented and explicitly accepted limitations:
(1) NLM-standalone off-topic refusal 34% — addressed end-to-end by the REQUIRED v3.1
input-classifier gate which lifts e2e off-topic refusal to 92%; (2) FP-suppression on benign
security code 57% — HMA users must human-review findings on packages whose primary purpose is
security functionality (JWT validators, RBAC, parameterized queries, rate limiters, OAuth).
v3.1 fix planned via +100 benign-security-code training samples.

## Architecture

| Parameter | Value |
|-----------|-------|
| Base model | Qwen3-1.7B (28 layers, d_model=2048) |
| Fine-tuning method | SFT with LoRA (rank=64, alpha=128) |
| Fused model format | Hugging Face (bfloat16) |
| Model size (bf16, fused) | 3.44 GB |
| Tokenizer | Qwen3 tiktoken |
| Output format | Structured markdown (Analysis / Verdict / Evidence / Remediation) |
| Task type | Generative threat analysis (threatAnalysis) |
| Attack classes | 10 (injection, exfiltration, steganography, social_engineering, credential_abuse, lateral_movement, privilege_escalation, policy_violation, persistence, none) |
| Inference device | Apple MPS (bfloat16 required — float16 produces 0% accuracy on MPS) |
| Inference latency | 18.0 ms/token, 55.7 tok/s (MPS, Qwen3-1.7B bf16) |

## Training

| Parameter | Value |
|-----------|-------|
| Corpus | instruct-v3-enriched |
| Training iterations | 1821 |
| Learning rate | 2e-5 (stable SFT regime; LR ≥5e-5 diverges on this base) |
| LoRA rank | 64, alpha=128 |
| Base model dtype | bfloat16 |
| Hardware | Apple M4 Max (MPS backend) |
| Adapter checkpoints | iter 400, 800, 1200, 1600, final (fused) |
| Val loss (late iters) | High variance (1.061–1.393); use internal eval, not val loss, as quality signal |

### Data Provenance

Training corpus: `instruct-v3-enriched/train.jsonl`. No Claude-generated labels in eval ground truth.
Oracle eval set is frozen at `oracle-v060-instruct/eval.jsonl` (500 samples). Red-team mutations only
for eval set augmentation.

## CDS-006 Gate Results

| Gate | Target | Result | Status |
|------|--------|--------|--------|
| Oracle canonicalized 10-way (10 classes) | ≥70.0% | **70.0% (350/500)** | PASS |
| Oracle binary (threat/benign) | beat v2 (SmolLM2-12L v0.1.0, 78.2%) | **97.8%** | PASS (+19.6 pp) |
| Oracle attack-only 9-way | beat v2 (SmolLM2-12L v0.1.0, 29.8%) | **67.3%** | PASS (+37.6 pp) |
| Internal 332-sample accuracy | v2 ±5 pp (77.4–87.4%) | **94.24%** | PASS (+11.9 pp above v2) |
| Structure adherence | — | **98.9%** | report |
| Refusal — off-topic (≥90% → none) | ≥90% | **34.0% (17/50)** | FAIL — see Known Limitations |
| Refusal — in-domain (≥90% → non-none) | ≥90% | **100.0% (50/50)** | PASS |
| FP-suppression — benign security code (≥95% → none) | ≥95% | **57.0% (57/100)** | FAIL — see Known Limitations |

Gate eval sets: `training/data/gate-evals/` (nanomind-training private repo).
Gate eval results: attached to nanomind-training release v3.0.0-rc1.

## Per-Class Metrics (Oracle, 500 samples)

Sorted by F1 (canonicalized oracle, `eval-oracle-500-canonicalized.json`):

| Class | Recall | Precision | F1 | Notes |
|-------|--------|-----------|-----|-------|
| none | 0.940 | 0.855 | 0.895 | Monitor — slight over-prediction of benign |
| social_engineering | 0.760 | 0.826 | 0.792 | Accept |
| privilege_escalation | 0.780 | 0.765 | 0.772 | Accept |
| persistence | 0.600 | 1.000 | 0.750 | Accept — 30/50 recall; corpus expansion planned |
| steganography | 0.860 | 0.632 | 0.729 | Low precision — bias toward stego; corpus audit |
| policy_violation | 0.580 | 0.906 | 0.707 | Low recall — model avoids label; corpus audit |
| exfiltration | 0.820 | 0.594 | 0.689 | Low precision — over-predicts exfil |
| lateral_movement | 0.700 | 0.660 | 0.680 | Accept |
| credential_abuse | 0.620 | 0.689 | 0.653 | Low recall — inject/credential confusion |
| injection | 0.340 | 0.810 | **0.479** | Weakest class — corpus rebalance required |

**Macro F1 (10-class):** ~0.7146

## Known Limitations

### 1. Off-topic refusal: 34% (FAIL, gate ≥90%)

The model was fine-tuned exclusively on AI agent security artifacts. When given arbitrary
non-security structured text (cooking recipes, weather data, sports scores, jailbreaks formatted
as artifacts), it pattern-matches and hallucinates attack classes. Examples observed during eval:
- French onion soup recipe → `social_engineering`
- Sourdough bread recipe → `steganography` ("add starter+salt" = hidden payload)

**Impact:** Not blocking for the HMA use case. HMA pre-filters all inputs to AI agent artifacts
(npm packages, MCP configs, GitHub repos). The model is never exposed to cooking recipes or
general text in production. Do NOT use this model on arbitrary text input.

**Fix for v4:** Add 50-100 "I don't know" refusal examples to training corpus for truly off-topic
content. Redefine refusal gate accordingly.

### 2. FP-suppression: 57% benign recall on security-adjacent code (FAIL, gate ≥95%)

Security-adjacent benign code — legitimate JWT validators, RBAC implementations, rate limiters,
parameterized queries, cryptography libraries — is over-classified as a threat at a 43% rate.
The model recognizes security keywords and patterns from training data but lacks enough positive
examples of benign security code to distinguish correctly.

**Impact:** Partially blocking for HMA. HMA scans of legitimate security libraries (e.g., a
cryptography package that implements proper key validation, an auth library with well-formed
RBAC) may produce false positives. Human review is recommended for findings on packages where
security functionality is the primary purpose of the package.

**Fix for v4:** Add 100+ examples of legitimate JWT, RBAC, rate limiting, parameterized query,
and cryptography patterns to the training corpus with `classification: benign` labels.

### 3. Injection class recall: 34% (F1 0.479)

The weakest class by a large margin. The model under-predicts injection in favor of adjacent
classes (exfiltration, social_engineering). Users running prompt-injection checks via HMA will
see under-labeling.

**Fix for v4:** Add 50-100 canonical injection samples from HMA corpora and AIIS honeypot feed.

### 4. Malformed output on edge cases

6% of fp-suppression eval samples produced malformed `attackClass` values (e.g., `attackClass: confidence: 0.15`).
These represent cases where the model's structured output generation breaks down. Structure adherence
overall is 98.9% on the oracle set, so this is a tail behavior.

## Usage Guidance

This model is intended for use **only via HMA** on AI agent artifact inputs:
- npm packages
- MCP server configurations
- GitHub repositories containing agent code
- Docker images with agent runtimes

Do NOT use this model for:
- General text analysis
- Arbitrary code review (outside agent artifact context)
- Security advisory generation

All inference must use `dtype=torch.bfloat16` on Apple MPS. Using float16 produces 0% classification
accuracy due to Qwen3's bfloat16-specific weight initialization.

## Licensing

This model inherits the **Qwen3 license** from the Qwen3-1.7B base model. Fine-tuning data
(`instruct-v3-enriched`) is private. The fused model artifact is stored in the private
`nanomind-training` repository.

## Consumer Impact

| Consumer | Update Required | Changes |
|----------|----------------|---------|
| HMA (hackmyagent) | Yes — bump nanomind-security-analyst pin to 3.0.0 | New output format (generative Analysis/Verdict/Evidence/Remediation vs classifier label); attackClass field replaces label; REQUIRES v3.1 input-classifier gate in front for off-topic refusal; human review recommended on security-library findings (FP caveat) |
| OpenA2A CLI (opena2a-cli) | Yes — bump nanomind-security-analyst pin to 3.0.0 | Delegates to HMA for analyst calls; needs version bump on the manifest pin to surface 3.0.0 to users |
| ai-trust | Yes — bump nanomind-security-analyst pin to 3.0.0 | Uses analyst for trust-context reasoning; same FP caveat applies |

## Regression vs v2 (nanomind-security-classifier v0.5.0)

| Metric | v0.5.0 (TME) | v3.0.0-rc1 (Qwen3 SFT) | Delta |
|--------|-------------|------------------------|-------|
| Oracle binary | 78.2% | 97.8% | +19.6 pp |
| Oracle 10-way | 35.6% | 70.0% | +34.4 pp |
| Oracle 9-way attack | 29.8% | 67.3% | +37.6 pp |
| Internal 332-sample | 77.4% | 94.24% | +16.8 pp |
| Model size | ~4 MB (ONNX) | 3.44 GB (bf16) | +3.44 GB |
| Inference latency | <1 ms (ONNX CPU) | 18 ms/token (MPS) | higher per-token |

Note: v3 is a generative reasoning model, not a classifier. Latency comparison is not apples-to-apples.
v0.5.0 produces a label in <1 ms; v3 produces structured analysis with evidence and remediation,
typically 200-512 tokens at ~18 ms/token.

## Reproduction

```bash
# In nanomind-training/ (private)
# Full run at: training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64/ (3.44 GB, bf16)

# Oracle eval
PYTHONUNBUFFERED=1 .venv/bin/python3 -m training.compressm.eval \
  --model training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64 \
  --eval-data training/data/oracle-v060-instruct/eval.jsonl \
  --out training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64/eval-oracle-500.json \
  --max-new-tokens 512

# Canonicalized 10-way accuracy
python3 training/scripts/canonicalize_oracle_eval.py \
  --input training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64/eval-oracle-500.json \
  --output training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64/eval-oracle-500-canonicalized.json

# Gate evals
python3 training/scripts/build_gate_evals.py  # builds gate-evals/ JSONL sets
# Run each eval sequentially (MPS serializes GPU across processes)
PYTHONUNBUFFERED=1 .venv/bin/python3 -m training.compressm.eval \
  --model training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64 \
  --eval-data training/data/gate-evals/refusal-off-topic.jsonl \
  --out training/artifacts/nanomind-v3-qwen3-1.7B-sft-r64/gate-refusal-off-topic.json \
  --max-new-tokens 256
python3 training/scripts/analyze_gate_evals.py
```

**IMPORTANT:** Always use `.venv/bin/python3` (not system `python3`). Always use
`dtype=torch.bfloat16` (not float16) for MPS inference. Parallel MPS eval processes cause
output starvation — run evals sequentially.
