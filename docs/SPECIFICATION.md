# NanoMind Specification

**Version:** 3.0
**Status:** Active
**Last Updated:** 2026-04-09
**Maintainer:** Chief Data Scientist

---

## 1. What NanoMind Is

NanoMind is the embedded machine learning layer for the OpenA2A security ecosystem. It provides on-device neural inference for threat classification, behavioral anomaly detection, and intent routing -- without requiring cloud API calls.

NanoMind is NOT a product. It is infrastructure. It runs inside other tools (HMA, ai-trust, OASB, AIM, aibrowserguard, ARP) as a dependency. End users never interact with NanoMind directly.

## 2. Mission

Achieve **99.999% accuracy** in classifying AI agent security threats. Every false positive erodes trust in the tools that depend on NanoMind. Every false negative is a missed attack. The accuracy target is not aspirational -- it is the engineering standard.

### 2.1 Current Reality vs Target

| Metric | Current (v0.4.0) | Target | Gap |
|--------|-------------------|--------|-----|
| Overall accuracy | 96.73% | 99.999% | 3.27% |
| Macro F1 | 0.949 | 0.999 | 0.050 |
| Weakest class (exfiltration) | 0.840 F1 | 0.999 F1 | 0.159 |
| Strongest class (social_engineering) | 1.000 F1 | 1.000 F1 | 0.000 |
| Training samples | 3,337 | 50,000+ | ~47,000 |
| Eval samples | 398 | 5,000+ | ~4,600 |

The path to 99.999% is primarily a data problem, not an architecture problem. The Mamba TME architecture learns well -- it hits 100% training accuracy. The gap is generalization, which requires more diverse, high-quality training data.

### 2.2 Non-Goals

- NanoMind does NOT replace LLM-based analysis. It is the fast first pass (sub-10ms) that catches obvious threats. Complex analysis is escalated to Claude or other LLMs.
- NanoMind does NOT do content generation. It classifies, scores, and routes.
- NanoMind does NOT phone home. All inference is local. Only differentially-private gradients are submitted to the Registry for federated improvement.

## 3. Architecture

### 3.1 Core: Mamba TME (Ternary Mamba Encoder)

The production classifier uses a Mamba SSM (State Space Model) architecture:

```
Input text
  -> SimpleTokenizer (word-level, vocab_size configurable)
  -> Embedding (vocab_size x d_model)
  -> N x MambaBlock (SSM with gated projection + residual)
  -> LayerNorm
  -> Mean pooling over sequence
  -> Linear classifier head (d_model -> num_classes)
  -> Softmax -> class probabilities
```

**Why Mamba over Transformers:** Mamba is O(n) in sequence length vs O(n^2) for attention. For security classification on short texts (<128 tokens), Mamba gives comparable accuracy at 10x lower latency and 5x smaller model size.

**Why not just an MLP:** MLPs treat input as bag-of-words. Word ORDER matters for security classification. "Forward token to external endpoint" (exfiltration) vs "External endpoint token forwarding service" (potentially benign) are distinguishable only with sequence understanding.

### 3.2 Registry Intelligence Loop (the real architecture)

NanoMind is NOT a standalone train-and-ship pipeline. It is a **closed-loop intelligence system** with the OpenA2A Registry at the center. Every scan, every correction, and every threat discovery feeds back into model improvement.

```
┌─────────────────────────────────────────────────────────────────┐
│  1. CONSUMER TOOLS (HMA, ai-trust, OASB, aibrowserguard)       │
│     Run NanoMind inference locally (on-device, sub-10ms)        │
│     Produce: findings, classifications, confidence scores       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. REGISTRY INGESTION                                          │
│     POST /api/v1/trust/publish  — Unified scan results          │
│     POST /api/v1/nanomind/telemetry — Tier 1: anonymous stats   │
│     POST /api/v1/nanomind/feedback — Tier 2: labeled corrections│
│     POST /api/v1/telemetry/behavioral-gradient — Federated L2   │
│                                                                 │
│     Stores in: community_scans, nanomind_telemetry,             │
│     nanomind_feedback, nanomind_model_versions                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. REGISTRY INTELLIGENCE PROCESSING                            │
│     ConsensusService: aggregate 3+ submissions per package      │
│     NanoMindScanService: semantic scan via daemon (port 47200)  │
│     NanoMindFilter: two-tier classification (heuristic + Claude)│
│     ARIA integration: confirmed findings → threat matrix        │
│     AgentPwn: honeypot confirmed attacks                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. TRAINING DATA EXPORT                                        │
│     GET /internal/nanomind/training/export — Registry scans     │
│     GET /internal/nanomind/training/aria — Confirmed findings   │
│     GET /internal/nanomind/training-export — Unified (4 sources)│
│                                                                 │
│     Sources: Registry (477K+ versions), AgentPwn (confirmed),   │
│     ARIA (research-verified), HMA evidence (technique-linked)   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. TRAINING PIPELINE                                           │
│     Corpus build → train-tme-mlx.py (MLX) → export-onnx.py     │
│     → push-to-huggingface.py → GitHub Actions CI                │
│     → repository_dispatch → all consumer tools                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. MODEL DISTRIBUTION                                          │
│     GET /api/v1/nanomind/latest — Auto-update endpoint          │
│     HuggingFace: opena2a/nanomind-security-classifier           │
│     repository_dispatch event → HMA downloads new model         │
│     SHA-256 verification → inference resumes with new model     │
│                                                                 │
│     ──── LOOP RESTARTS AT STEP 1 ────                           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Two-Tier Classification (Registry-side)

When the Registry processes incoming intelligence (Shodan sweeps, advisory feeds, ARIA research), it uses NanoMind as a two-tier filter before expensive Claude analysis:

| Tier | Score Range | Action | Cost |
|------|------------|--------|------|
| **Tier 1: NanoMind Heuristic** | >= 0.70 | Pass (relevant to OpenA2A) | Free |
| **Tier 1: NanoMind Heuristic** | 0.35 - 0.70 | Escalate to Claude for semantic analysis | ~$0.01/item |
| **Tier 1: NanoMind Heuristic** | < 0.35 | Discard (not relevant) | Free |
| **Tier 2: Claude Escalation** | -- | Full semantic classification + remediation | ~$0.05/item |

Heuristic signals scored (0-1):
- Attack category keywords: +0.15 per match, +0.10 bonus for 2+ categories
- Product keywords (OpenA2A ecosystem): +0.20 per match
- AI/agent keywords: +0.10
- CVSS >= 7.0: +0.10

**File:** `opena2a-registry/internal/intel/classification/nanomind_filter.go`

### 3.4 NanoMind Daemon (localhost:47200)

A persistent inference server that keeps the model loaded in memory. Called by the Registry's scan service and available to all local tools.

```
POST /v1/infer          — Classification endpoint
  Request:  { intent, artifactType, content, packageName, version }
  Response: { classification, confidence, attackClass, evidence, remediation, latencyMs, modelVersion }

GET  /v1/status          — Model status and health
GET  /health             — Daemon health check
```

**FabricAdapter** provides a standardized interface for all products:

```typescript
interface FabricAdapter {
  productId: string;                                    // "hma", "arp", "browserguard"
  writeASC(agentId, signals): Promise<void>;            // PATCH /internal/asc/{agentId}
  readRiskSummary(agentId): Promise<RiskSummary>;       // GET /api/v1/asc/{agentId}/risk-summary
  infer(intent, input, context): Promise<InferResult>;  // POST /v1/infer (local daemon)
}
```

**File:** `nanomind/packages/nanomind-daemon/src/server.ts`, `fabric-adapter.ts`

### 3.5 Federated Learning Protocol (L2 Fleet Intelligence)

NanoMind-Runtime implements federated learning for fleet-wide behavioral model improvement. Raw behavioral events NEVER leave endpoints -- only differentially-private gradients are submitted.

**Three-Tier ARP Model:**

| Tier | Layer | Implementation | Latency |
|------|-------|---------------|---------|
| L0 | Rule-based enforcement | ARP capability checks | Microseconds |
| L1 | NanoMind-Runtime anomaly | 6-factor statistical scoring | < 2ms |
| L2 | Fleet intelligence | Federated gradient aggregation | Continuous |

**Gradient Submission Flow:**

```
Agent events → NanoMind-Runtime (local, Welford's online algorithm)
  → 6-factor anomaly score (capability, timing, burst, L0 escalation, event type, error)
  → Gradient computation from baseline statistics
  → Differential privacy (Gaussian noise, ε=1.0, δ=1e-5, L2 clipping ≤ 1.0)
  → POST /api/v1/telemetry/behavioral-gradient
    { agentCategory: "financial", gradientVector: [...], localLoss, eventCount, privacyEpsilon }
  → Registry aggregates (FedAvg) → model update
```

**Privacy guarantees:**
- Raw events never leave endpoint
- Only broad `agentCategory` submitted (never `agentId`)
- Gradient clipping: L2 norm ≤ 1.0
- Gaussian noise: σ = sensitivity × √(2ln(1.25/δ)) / ε
- Server rejects submissions with ε > 2.0

**Files:** `nanomind/packages/nanomind-runtime/src/fleet.ts`, `index.ts`

### 3.6 Local Training Pipeline

```
Corpus (nanomind-training repo, augmented with Registry exports)
  -> train-tme-mlx.py (Apple Silicon MLX, GPU-accelerated)
  -> MLX weights (.npz) + tokenizer.json + eval-report.json
  -> export-onnx.py (MLX -> PyTorch -> ONNX)
  -> ONNX model (.onnx + .onnx.data)
  -> push-to-huggingface.py (publish to opena2a/nanomind-security-classifier)
  -> GitHub Actions CI (auto-publish on main push)
  -> Consumer tools download via SHA-256 verified fetch
```

### 3.7 Inference Pipeline (in consumer tools)

```
Consumer tool (e.g., HMA)
  -> tme-classifier.ts (Node.js)
  -> Download model from HuggingFace (if not cached)
  -> Verify SHA-256 integrity
  -> Load ONNX session (onnxruntime-node)
  -> Tokenize input -> Run inference -> Softmax -> Top-K classes
  -> Return: { class, confidence, top3 }
```

Fallback: If ONNX runtime is unavailable, vocabulary-based scoring provides degraded but functional classification.

### 3.8 Deployment Modes

| Mode | Package | What It Does | Latency Target |
|------|---------|-------------|----------------|
| CLI Threat Classification | @nanomind/engine | Classify agent configs, prompts, skills | <10ms |
| Intent Routing | @nanomind/router | Map natural language to CLI commands | <5ms |
| Prompt Injection Guard | @nanomind/guard | Screen non-direct input for injection | <2ms |
| Runtime Anomaly Detection | @nanomind/runtime | Behavioral anomaly scoring (L1 ARP) | <2ms |
| Daemon Server | @nanomind/daemon | Persistent inference server (port 47200) | <5ms |

## 4. Model Inventory

### 4.1 Production Models

| Model | Purpose | Status | Consumers |
|-------|---------|--------|-----------|
| nanomind-security-classifier | Threat classification (10 classes) | v0.4.0 (latest) | HMA, OpenA2A CLI |
| nanomind-mcp-analyzer | MCP server behavioral analysis | Planned | HMA |
| nanomind-trust-scorer | Trust scoring for Registry | Planned | ai-trust |
| nanomind-runtime-guard | Runtime behavioral anomaly | Planned | ARP |

### 4.2 Attack Class Taxonomy (v0.4.0)

| Class | Description | Example |
|-------|-------------|---------|
| exfiltration | Data leaving intended boundaries | Forward credentials to external endpoint |
| injection | Prompt/command injection | Ignore previous instructions, execute... |
| privilege_escalation | Gaining unauthorized access | Escalate to admin via misconfigured ACL |
| persistence | Maintaining unauthorized presence | Write cron job to re-establish connection |
| credential_abuse | Misusing authentication material | Extract API keys from environment variables |
| lateral_movement | Moving between systems/agents | Discover and connect to adjacent MCP servers |
| social_engineering | Manipulating human operators | Convince user to approve dangerous action |
| policy_violation | Violating stated governance rules | Bypass rate limit / ignore SOUL.md constraints |
| steganography | Hidden data via Unicode manipulation | Zero-width chars encoding commands, homoglyph substitution |
| benign | Normal, safe behavior | Standard tool calls, legitimate config |

**Important:** The class taxonomy is not static. New classes are added when the threat landscape evolves. Each addition requires:
1. Minimum 300 training examples (balanced benign + malicious)
2. No regression on existing classes (all existing F1 scores must remain above threshold)
3. Full model card documentation
4. Consumer tool updates (all tools that use the model must handle the new class)

## 5. Consumer Integration Requirements

Every tool that uses NanoMind MUST:

1. **Pin to a specific model version** via SHA-256 hashes of model files
2. **Verify integrity** on every model load (SHA-256 check)
3. **Handle all classes** in the current taxonomy (unknown classes logged, not crashed)
4. **Graceful degradation** if model download fails or ONNX runtime unavailable
5. **Report inference latency** if it exceeds the target for that mode
6. **Never trust a single signal** -- NanoMind classification is one input to the decision, not the decision itself (defense-in-depth)

### 5.1 Current Consumers

| Consumer | Integration Point | Model Used | Classes Handled |
|----------|------------------|------------|-----------------|
| HMA | `src/nanomind-core/inference/tme-classifier.ts` | security-classifier | 10 (v0.4.0) |
| HMA | `src/nanomind-core/analyzers/` | security-classifier | Semantic analysis |
| HMA | `src/semantic/nanomind-enhancer.ts` | security-classifier | Finding enrichment |
| OpenA2A CLI | Via adapter | security-classifier | Delegated to HMA |
| ai-trust | Planned | trust-scorer | -- |
| OASB | Planned | security-classifier | Benchmark validation |
| aibrowserguard | Planned | security-classifier | Browser-level detection |
| ARP | Planned | runtime-guard | Behavioral anomaly |

## 6. Data Governance

### 6.1 Training Data Sources

NanoMind has two categories of training data: **local corpus** (hand-curated, version-controlled) and **Registry pipeline** (automated, high-volume). The Registry pipeline is the path to 99.999%.

#### Local Corpus (current, used for v0.1.0 - v0.4.0)

| Source | Type | Confidence | Volume |
|--------|------|------------|--------|
| dvaa | Lab-generated attacks from DVAA agents | High (controlled) | ~200 samples |
| original | Hand-crafted by security researchers | High (expert) | ~400 samples |
| oasb | OASB benchmark attack scenarios | High (curated) | ~400 samples |
| agentpwn | Real-world behavioral telemetry | Medium (noisy) | ~100 samples |
| stego-corpus | Generated Unicode attack/benign pairs | High (systematic) | ~600 samples |
| synthetic | LLM-generated augmentation | Medium (review required) | ~1,500 samples |

#### Registry Pipeline (future, the path to 99.999%)

The Registry's `NanoMindTrainingExporter` provides a unified export from 4 real-world data sources:

| Source | Registry Table | Confidence | Volume | Label Logic |
|--------|---------------|------------|--------|-------------|
| Registry scans | `registry_packages` + `registry_versions` | 0.85-0.95 | **477K+ versions** | Trust level + findings severity |
| AgentPwn honeypot | `agentpwn_interactions` (payload_callback) | 0.90 | Confirmed attacks | Agent fell for injection = confirmed |
| ARIA findings | `aria_findings` (status=confirmed) | 0.95 | Research-verified | Researcher confirmed vulnerability |
| HMA evidence | `threat_matrix_evidence` (type=hma_scan) | 0.85 | Technique-linked | Maps to threat matrix techniques |

**Registry label logic** (from `nanomind_training_exporter.go`):
- Critical findings → "malicious" (0.90 confidence)
- Trust level 0 (blocked) → "malicious" (0.85 confidence)
- Trust level >= 4 + clean scan → "benign" (0.95 confidence)
- Trust level >= 3 + clean scan → "benign" (0.85 confidence)
- Warnings or high > 0 → "suspicious" (0.60 confidence)

**Export API:**
```
GET /internal/nanomind/training-export?sources=registry,agentpwn,aria,hma&since=2026-01-01&limit=50000
```

**Unified export format:**
```json
{
  "input": "artifact text or description",
  "attackClass": "injection|exfiltration|...",
  "confidence": 0.90,
  "source": "registry|agentpwn|aria|hma",
  "contentType": "skill|mcp_config|soul|system_prompt|agent_config|interaction|finding"
}
```

#### Feedback Loop (continuous improvement)

The Registry collects two tiers of feedback that feed directly into retraining:

| Tier | Endpoint | Data | Privacy |
|------|----------|------|---------|
| Tier 1: Telemetry | `POST /api/v1/nanomind/telemetry` | Anonymous stats (no content) | IP hashed, no PII |
| Tier 2: Feedback | `POST /api/v1/nanomind/feedback` | Full content + corrected labels | Requires auth |

**Retraining triggers** (when Registry data indicates model degradation):
- >= 100 feedback items with `corrected_label` (indicating systematic confusion)
- Per-class error rate exceeds 5% over 7-day window
- New attack class discovered via ARIA or AgentPwn

**Files:**
- `opena2a-registry/internal/application/nanomind_training_exporter.go`
- `opena2a-registry/internal/interfaces/http/handlers/nanomind_handler.go`
- `opena2a-registry/migrations/178_nanomind_telemetry.sql`
- `opena2a-registry/migrations/193_nanomind_training_data.sql`

### 6.2 Data Quality Rules

1. **Real data >= 50%** of every training corpus. Synthetic data fills gaps but must never be the majority.
2. **Every synthetic sample must be reviewed** before inclusion in a "stable" or "latest" model.
3. **Benign samples must include realistic diversity** -- emoji, CJK, Cyrillic, Arabic, Indic scripts. A model trained only on ASCII benign data will false-positive on internationalized content.
4. **No data leakage** between train/eval/holdout splits. Deduplication by content hash is mandatory.
5. **Class balance within 20%** -- no class should have more than 1.2x or less than 0.8x the median class count.
6. **Eval set minimum: 30 samples per class.** Below this, per-class F1 is too noisy to be meaningful. If the eval set is too small, merge holdout into eval (document this in the model card).

### 6.3 Known Data Gaps (as of v0.4.0)

- Exfiltration class has lowest F1 (0.840). Needs more diverse exfiltration examples.
- No multi-language attack examples (attacks in languages other than English).
- No adversarial examples specifically designed to evade the classifier.
- Steganography class is new and may need refinement as real-world stego attacks are observed.

## 7. Speed and Size Budgets

NanoMind models run on user machines -- laptops, CI runners, Raspberry Pis. They must be small and fast.

### 7.1 Budgets by Deployment Mode

| Mode | Max Model Size | Max Inference Latency | Max Memory | Rationale |
|------|---------------|----------------------|------------|-----------|
| CLI Classification | 10 MB | 10ms | 50 MB | Runs per-file in scans; 1000s of invocations |
| Intent Routing | 5 MB | 5ms | 30 MB | Interactive; user is waiting |
| Prompt Guard | 2 MB | 2ms | 20 MB | Inline on every input; must be invisible |
| Runtime Anomaly | 1 MB | 2ms | 10 MB | Continuous; per-event in production |
| Daemon (persistent) | 20 MB | 5ms | 100 MB | Loaded once, shared across tools |

### 7.2 Current Model Sizes

| Model | Version | ONNX Size | Data Size | Tokenizer | Total | Budget | Status |
|-------|---------|-----------|-----------|-----------|-------|--------|--------|
| security-classifier | v0.4.0 | 121 KB | 6.0 MB | 165 KB | 6.3 MB | 10 MB | Within budget |
| security-classifier | v0.3.0 | 121 KB | 5.0 MB | 81 KB | 5.2 MB | 10 MB | Within budget |

### 7.3 Monitoring

Every model version MUST record in its model card:
- ONNX file sizes
- Inference latency (p50, p95, p99) on reference hardware (M4 Max, Intel i7, ARM64)
- Peak memory during inference
- Tokenizer vocabulary size and its impact on embedding layer size

If a model exceeds its budget, it MUST be optimized (quantization, pruning, distillation) before release, or the budget must be explicitly renegotiated with a documented rationale.

## 8. Versioning and Release

### 8.1 Version Scheme

Models follow semantic versioning with these meanings:
- **MAJOR** (1.0.0): Architecture change (e.g., MLP -> Mamba, Mamba -> Transformer)
- **MINOR** (0.X.0): New class added, significant accuracy improvement, corpus overhaul
- **PATCH** (0.0.X): Bug fix, small accuracy improvement, data quality fix

### 8.2 Release Criteria

A model version can be promoted to "latest" when:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Overall eval accuracy | >= 95% (current), >= 99% (target) | Minimum acceptable accuracy |
| Per-class F1 | >= 0.90 for all classes | No class should be unreliable |
| Macro F1 | >= 0.94 (current), >= 0.99 (target) | Balanced performance |
| No regression | All existing class F1 >= previous version | Never sacrifice existing capability |
| Eval set size | >= 30 per class | Statistical significance |
| Model card | Complete and reviewed | Documentation is not optional |
| Consumer compatibility | All consumers updated and tested | No broken downstream tools |
| SHA-256 hashes | Recorded in manifest and consumer code | Integrity verification |

### 8.3 Release Process

1. Train model (see [TRAINING-PLAYBOOK.md](TRAINING-PLAYBOOK.md))
2. Write model card (see [MODEL-CARD-TEMPLATE.md](MODEL-CARD-TEMPLATE.md))
3. Update `nanomind-models.json`
4. Commit and push to feature branch
5. CI auto-publishes to HuggingFace
6. Update all consumer tools with new SHA-256 hashes
7. Run consumer integration tests
8. Merge to main

## 9. Benchmark Suite

### 9.1 Required Benchmarks

Every model release MUST include results from:

| Benchmark | What It Tests | Pass Criteria |
|-----------|--------------|---------------|
| **Accuracy Benchmark** | Per-class precision/recall/F1 on eval set | All classes >= threshold |
| **Regression Benchmark** | Compare all metrics vs previous version | No class F1 decrease > 0.02 |
| **Latency Benchmark** | Inference time on 1000 samples | p99 < budget for deployment mode |
| **Size Benchmark** | Model file sizes | Total < budget for deployment mode |
| **Robustness Benchmark** | Adversarial inputs (typos, encoding tricks) | Accuracy drop < 5% |
| **False Positive Benchmark** | Known-benign packages with Unicode/i18n | 0 false CRITICAL findings |
| **Cross-Corpus Benchmark** | Performance on holdout set (never used in training/eval) | Accuracy within 3% of eval |

### 9.2 Benchmark Data

Benchmark datasets are stored in `nanomind-training/benchmarks/` and MUST NOT overlap with training or eval data.

| Dataset | Purpose | Samples | Maintained By |
|---------|---------|---------|---------------|
| `benchmark-accuracy.json` | Standard accuracy test | 500+ | Chief Data Scientist |
| `benchmark-adversarial.json` | Adversarial robustness | 200+ | Security team |
| `benchmark-benign-unicode.json` | False positive regression | 100+ | Chief Data Scientist |
| `benchmark-real-world.json` | Real packages/configs | 50+ | Manually curated |

### 9.3 Continuous Benchmarking

- Benchmarks run automatically on every model push via GitHub Actions
- Results are appended to `benchmark-history.json` for trend tracking
- Any benchmark failure blocks the release

## 10. Roadmap to 99.999%

The path to 99.999% is not manual curation. It is the **Registry intelligence pipeline** -- 477K+ real-world package scans, AgentPwn confirmed attacks, ARIA research findings, and continuous feedback corrections. The data exists. The pipeline exists. The work is connecting them to the training loop.

### 10.1 Data Scale (highest impact)

| Phase | Source | Training Samples | Eval Samples | Expected Accuracy |
|-------|--------|-----------------|--------------|-------------------|
| Current (v0.4.0) | Local corpus only | 3,337 | 398 | 96.73% |
| Phase 1 | + Registry export (high-confidence) | 10,000 | 2,000 | ~98% |
| Phase 2 | + AgentPwn + ARIA confirmed | 50,000 | 10,000 | ~99% |
| Phase 3 | + Full Registry catalog + feedback loop | 200,000+ | 40,000+ | ~99.9% |
| Phase 4 | + Active learning + federated gradients | Continuous | Continuous | 99.99%+ |

**Phase 1 is achievable now.** The Registry training exporter (`/internal/nanomind/training-export`) can produce 10K+ high-confidence labeled samples from existing scan data. The blocking work is:
1. Run the export script to collect labeled samples
2. Quality-review the labels (automated confidence >= 0.85, manual review for 0.60-0.85)
3. Deduplicate against existing local corpus
4. Retrain on the combined dataset

### 10.2 Architecture Evolution

| Phase | Architecture | Why | Size Budget |
|-------|-------------|-----|-------------|
| Current | Mamba TME (8 blocks, 128d) | Good speed/accuracy balance | 6.3 MB |
| Next | Mamba TME (12 blocks, 256d) | More capacity for 15+ classes and 50K+ data | ~15 MB |
| Future | Hybrid Mamba + character-level tokenizer | Better Unicode handling for stego | ~20 MB |
| Research | Knowledge distillation from a frontier LLM | Transfer LLM understanding to small model | Budget TBD |

**Constraint:** All models must stay within the deployment mode size budgets (Section 7). If a larger model is needed for accuracy, it must be justified by benchmarks showing the smaller model cannot achieve the target.

### 10.3 Intelligence Pipeline Evolution

| Phase | Pipeline | What Changes |
|-------|----------|-------------|
| Current | Manual corpus → local training → manual publish | Human-in-the-loop for everything |
| Next | Registry export → local training → CI publish | Automated data collection, manual training |
| Future | Registry export → automated training → CI publish → feedback | Human reviews only flagged items |
| Target | Continuous: feedback → retrain → deploy → feedback | Fully automated with quality gates |

### 10.4 Threat Matrix Alignment

The Registry's threat matrix defines 36+ attack classes organized by 9 kill chain stages. NanoMind's 10 classes are a compressed mapping:

| NanoMind Class | Threat Matrix Classes (examples) |
|---------------|----------------------------------|
| injection | prompt_injection, jailbreak, command_injection |
| exfiltration | data_exfiltration, credential_harvesting |
| privilege_escalation | privilege_escalation, capability_abuse |
| persistence | persistence, backdoor_installation |
| credential_abuse | credential_theft, token_abuse |
| lateral_movement | lateral_movement, discovery |
| social_engineering | social_engineering, phishing |
| policy_violation | policy_violation, governance_bypass |
| steganography | unicode_stego, encoding_attack |
| benign | (not in threat matrix) |

As the model scales to handle more nuance, the class taxonomy will expand toward the full 36+ threat matrix classes. The two-tier filter (Section 3.3) already uses the full 36+ categories for heuristic scoring.

## 11. Registry API Reference (NanoMind endpoints)

### 11.1 Public Endpoints

| Endpoint | Method | Rate | Purpose |
|----------|--------|------|---------|
| `/api/v1/nanomind/latest` | GET | -- | Auto-update: latest model version, SHA-256, download URL |
| `/api/v1/nanomind/telemetry` | POST | 60/min | Tier 1: anonymous classification stats (no content) |
| `/api/v1/nanomind/feedback` | POST | 30/min | Tier 2: labeled feedback with content for retraining |
| `/api/v1/nanomind/stats` | GET | -- | 7-day aggregate: classifications by tool, correction rates |
| `/api/v1/trust/publish` | POST | -- | Unified scan ingestion (all tools → Registry) |
| `/api/v1/atc/{agentId}` | GET | -- | Trust level query (cached 5 min) |
| `/api/v1/threat-matrix/classes` | GET | -- | 36+ attack classes (maps to NanoMind output) |

### 11.2 Internal Endpoints (require `INTERNAL_API_KEY`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/internal/nanomind/training/export` | GET | Export Registry scan results as training data |
| `/internal/nanomind/training/aria` | GET | Export ARIA confirmed findings |
| `/internal/nanomind/training-export` | GET | Unified export (4 sources, with `sources` + `since` params) |
| `/internal/nanomind/training/stats` | GET | Export statistics |
| `/internal/aria/findings` | POST | Ingest ARIA finding → auto-generate HMA/DVAA stubs |
| `/internal/aria/research-recommendations` | GET | Gap-driven research priorities |
| `/internal/asc/{agentId}` | PATCH | Agent state update (from NanoMind daemon) |

### 11.3 Database Tables

| Table | Migration | Purpose |
|-------|-----------|---------|
| `nanomind_telemetry` | 178 | Anonymous Tier 1 classification stats |
| `nanomind_feedback` | 178 | Labeled Tier 2 corrections for retraining |
| `nanomind_model_versions` | 178 | Version tracking with SHA-256 and accuracy |
| `nanomind_training_data` | 193 | Confirmed attack sessions (validated trap data) |
| `community_scans` | 129 | HMA/tool scan contributions |
| `community_findings` | 129 | Individual findings from community scans |
| `aria_findings` | 172 | ARIA-2026-XXXX research discoveries |
| `threat_matrix_techniques` | 172 | 57+ techniques with evidence tiers |
| `threat_matrix_attack_classes` | 172 | 36+ classes → NanoMind class mapping |
| `agentpwn_interactions` | 127 | Honeypot confirmed attacks |

## 12. Chief Data Scientist Responsibilities

The Chief Data Scientist is responsible for:

1. **Model quality**: Every model meets release criteria before shipping
2. **Benchmark maintenance**: Benchmarks are up to date, cover real threats, and catch regressions
3. **Data governance**: Training data is properly sourced, balanced, reviewed, and versioned
4. **Consumer health**: All 6+ consumer tools receive model updates and handle them correctly
5. **Accuracy tracking**: Maintain a clear picture of where we are vs the 99.999% target
6. **Speed/size monitoring**: Models stay within their budgets per deployment mode
7. **Threat evolution**: New attack classes are identified and added to the taxonomy as the landscape evolves
8. **Documentation**: Every model version has a complete model card; this specification stays current
9. **Training pipeline**: The pipeline is reproducible, automated, and version-controlled
10. **Handoff readiness**: Documentation is sufficient for any competent ML engineer (human or AI) to pick up NanoMind without tribal knowledge
11. **Registry pipeline health**: The training data export, telemetry ingestion, and feedback loop are functioning and producing usable data
12. **Federated learning oversight**: Gradient aggregation is producing meaningful model improvements, privacy guarantees are maintained
13. **Threat matrix alignment**: NanoMind classes stay aligned with the 36+ threat matrix classes; new techniques are reflected in training data

## 13. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03 | Chose Mamba over Transformer | O(n) inference, 10x faster, comparable accuracy on short sequences |
| 2026-03 | Word-level tokenizer over BPE | Simpler, sufficient for current data, avoids tokenizer complexity |
| 2026-04 | Added steganography class (10th) | False positives on emoji/i18n packages (context7-mcp incident) |
| 2026-04 | Increased vocab from 4000 to 6000 | Better Unicode token capture for steganography class |
| 2026-04 | Augmented v9 with v8 attack data | v9 alone had too few samples per class (318 vs 400) |
| 2026-04 | Excluded v8 policy_violation from augmentation | Contaminated with stego examples that were relabeled in v9 |

## 14. References

- Model catalog: [`nanomind-models.json`](../nanomind-models.json)
- Training playbook: [`docs/TRAINING-PLAYBOOK.md`](TRAINING-PLAYBOOK.md)
- Evaluation standard: [`docs/EVALUATION-STANDARD.md`](EVALUATION-STANDARD.md)
- Model card template: [`docs/MODEL-CARD-TEMPLATE.md`](MODEL-CARD-TEMPLATE.md)
- Training data: `nanomind-training` repo (private)
- HuggingFace: [opena2a/nanomind-security-classifier](https://huggingface.co/opena2a/nanomind-security-classifier)
- Protocol spec: [`spec/NANOMIND-SPEC.md`](../spec/NANOMIND-SPEC.md)
- Registry backend: `opena2a-registry` repo (Go, Fiber v3, Azure Container Apps)
- Registry NanoMind handler: `opena2a-registry/internal/interfaces/http/handlers/nanomind_handler.go`
- Registry training exporter: `opena2a-registry/internal/application/nanomind_training_exporter.go`
- Registry NanoMind filter: `opena2a-registry/internal/intel/classification/nanomind_filter.go`
- Architecture site: `opena2a-architecture/app/products/nanomind/`
