# NanoMind Evaluation Standard

**Version:** 1.0
**Last Updated:** 2026-04-09
**Companion to:** [SPECIFICATION.md](SPECIFICATION.md)

---

## 1. Purpose

This document defines how NanoMind models are evaluated. Every model release MUST follow this standard. No exceptions. No "we'll benchmark later." If it isn't benchmarked, it isn't shipped.

## 2. Accuracy Targets

### 2.1 Release Gate Thresholds

These are the MINIMUM thresholds for a model to be promoted to "latest":

| Metric | Current Minimum | Target (by v1.0) | Ultimate Goal |
|--------|----------------|-------------------|---------------|
| Overall eval accuracy | 95.0% | 99.0% | 99.999% |
| Per-class F1 (every class) | 0.90 | 0.95 | 0.999 |
| Macro F1 | 0.94 | 0.98 | 0.999 |
| False positive rate (benign -> attack) | < 5% | < 1% | < 0.001% |
| False negative rate (attack -> benign) | < 5% | < 1% | < 0.001% |

### 2.2 Regression Rules

- No class F1 may drop by more than 0.02 between versions
- If adding a new class causes any existing class to drop below its previous F1 - 0.02, the release is BLOCKED
- Regression is measured against the previous "latest" version, not the previous attempt

### 2.3 When Thresholds Are Not Met

If a model fails to meet thresholds:

1. **Document the gap** in the model card (which classes fail, by how much)
2. **Root cause**: Is it data quality? Data volume? Architecture limitation? Eval set noise?
3. **If eval set noise** (e.g., < 30 samples per class causing F1 volatility): merge holdout, document the merge, note that metrics are provisional
4. **If data quality**: add more training examples for the failing class, retrain
5. **If architecture limitation**: flag for architecture review in the decision log
6. **Never ship a model where the weakest class F1 < 0.80** regardless of other metrics

## 3. Benchmark Suite

### 3.1 Required Benchmarks (run on every model release)

#### Benchmark 1: Accuracy

**What:** Standard classification metrics on the eval set.
**Output:** Per-class precision, recall, F1, support. Overall accuracy. Macro F1. Confusion matrix.
**Pass criteria:** All metrics meet Section 2.1 thresholds.

```bash
# Run during training (automatic)
python3 training/scripts/train-tme-mlx.py --corpus-dir <corpus> --output-dir <output>
# eval-report.json is generated automatically
```

#### Benchmark 2: Regression

**What:** Compare all per-class metrics against the previous "latest" model.
**Output:** Delta table showing F1 change per class.
**Pass criteria:** No class F1 drops by more than 0.02.

```bash
# Compare eval reports
python3 training/evaluation/compare-models.py \
  --baseline training/models-tme-v5/eval-report.json \
  --candidate training/models-tme-v6/eval-report.json
```

#### Benchmark 3: Holdout / Cross-Corpus

**What:** Run the model on the holdout set (data never used in training or eval).
**Output:** Same metrics as Benchmark 1 but on holdout data.
**Pass criteria:** Overall accuracy within 3% of eval accuracy. No class F1 drops below 0.80.

```bash
python3 training/evaluation/eval-holdout.py \
  --model-dir training/models-tme-v6 \
  --holdout-path ../nanomind-training/corpus/sft-v9/holdout.json
```

#### Benchmark 4: Latency

**What:** Measure inference time on 1000 random inputs.
**Output:** p50, p95, p99 latency in milliseconds.
**Pass criteria:** p99 < deployment mode budget (see SPECIFICATION.md Section 7).

```bash
python3 training/evaluation/bench-latency.py \
  --model-dir training/models-tme-v6 \
  --samples 1000
```

#### Benchmark 5: Size

**What:** Measure ONNX model file sizes.
**Output:** Individual file sizes and total.
**Pass criteria:** Total < deployment mode budget.

```bash
ls -la training/models-tme-v6/nanomind-tme.onnx training/models-tme-v6/nanomind-tme.onnx.data training/models-tme-v6/tokenizer.json
```

#### Benchmark 6: False Positive Regression

**What:** Run the model on a curated set of known-benign inputs that have historically triggered false positives.
**Output:** Classification results for each benign input.
**Pass criteria:** 0 false CRITICAL/HIGH findings. 0 benign inputs classified as attack with confidence > 0.7.

Known false positive triggers (must all classify as benign):
- Packages with emoji (variation selectors, ZWJ sequences)
- Packages with CJK/Cyrillic/Arabic text (i18n badges, multilingual docs)
- Packages with legitimate zero-width joiners (Indic scripts, Arabic ligatures)
- Configuration files with long base64 strings (not credentials)
- SOUL.md files with governance language that resembles social engineering

```bash
python3 training/evaluation/eval-false-positives.py \
  --model-dir training/models-tme-v6 \
  --benign-inputs ../nanomind-training/benchmarks/benchmark-benign-unicode.json
```

#### Benchmark 7: Robustness (when adversarial dataset exists)

**What:** Run the model on adversarially crafted inputs designed to evade detection.
**Output:** Classification results with confidence scores.
**Pass criteria:** Accuracy drop < 5% vs standard eval set.

Adversarial techniques to test:
- Typo injection (common misspellings in attack keywords)
- Case variation (MiXeD cAsE, ALL CAPS)
- Synonym substitution (exfiltrate -> extract -> send -> transmit)
- Padding (irrelevant tokens added to dilute signal)
- Encoding variation (URL encoding, HTML entities in text)

### 3.2 Benchmark Data Management

- Benchmark datasets live in `nanomind-training/benchmarks/`
- Benchmark data MUST NOT overlap with training or eval data (enforced by content hash check)
- Benchmark data is versioned alongside the corpus (benchmark-v1, benchmark-v2, etc.)
- When the class taxonomy changes, benchmarks must be updated to cover the new class

### 3.3 Benchmark History

Results from every benchmark run are appended to `nanomind-training/benchmarks/benchmark-history.json`:

```json
{
  "modelVersion": "0.4.0",
  "corpus": "sft-v9",
  "date": "2026-04-09",
  "benchmarks": {
    "accuracy": { "overallAccuracy": 0.9673, "macroF1": 0.9487, "perClassF1": {...} },
    "regression": { "maxDrop": 0.0, "worstClass": null },
    "holdout": { "overallAccuracy": null, "note": "holdout merged into eval for v0.4.0" },
    "latency": { "p50ms": null, "p95ms": null, "p99ms": null },
    "size": { "totalMB": 6.3 },
    "falsePositive": { "falseCritical": 0, "total": null },
    "robustness": { "accuracyDrop": null, "note": "adversarial dataset not yet created" }
  },
  "notes": "First 10-class model. Holdout merged into eval due to small eval set."
}
```

## 4. Eval Set Quality Requirements

The eval set is the single most important dataset in NanoMind. Bad eval data produces misleading metrics which produces bad decisions.

### 4.1 Minimum Requirements

| Requirement | Threshold | Why |
|-------------|-----------|-----|
| Minimum samples per class | 30 | Below this, a single misclassification swings F1 by > 0.03 |
| Target samples per class | 100 | Stable F1 estimates (confidence interval < +/- 0.05) |
| Ideal samples per class | 500 | Publication-quality metrics |
| No overlap with training | 100% (content hash verified) | Data leakage invalidates all metrics |
| Source diversity | >= 3 sources per class | Single-source eval overfits to one data style |

### 4.2 When Eval Set Is Too Small

If the eval set has < 30 samples per class:

1. **Merge holdout** into eval. Document this in the model card.
2. **Report confidence intervals** on per-class F1 (bootstrap or Wilson).
3. **Flag metrics as provisional** -- they will be recalculated when more data is available.
4. **Prioritize data collection** for the next corpus version.

This is exactly what happened with v0.4.0: the sft-v9 eval set had only 11-16 samples for some classes. Holdout was merged into eval (194 + 204 = 398 total), and the exfiltration class still has only 24 eval samples (below the 30 minimum).

### 4.3 Eval Set Refresh

- Every major corpus version (sft-vN) should include a fresh eval set
- Eval sets should be stratified by source (not all samples from one source)
- Eval sets should include both "easy" (obvious) and "hard" (subtle) examples

## 5. Metric Definitions

For reference, the exact formulas used:

| Metric | Formula | Notes |
|--------|---------|-------|
| Precision (per class) | TP / (TP + FP) | Of predictions for class C, how many were correct |
| Recall (per class) | TP / (TP + FN) | Of actual class C samples, how many were found |
| F1 (per class) | 2 * P * R / (P + R) | Harmonic mean of precision and recall |
| Macro F1 | mean(all per-class F1) | Treats all classes equally regardless of support |
| Overall accuracy | correct / total | Weighted by natural class distribution |
| False positive rate | FP / (FP + TN) for benign class | Benign samples misclassified as any attack |
| False negative rate | FN / (FN + TP) for each attack class | Attack samples misclassified as benign |

## 6. Reporting

Every model card (see [MODEL-CARD-TEMPLATE.md](MODEL-CARD-TEMPLATE.md)) must include:

1. Full eval metrics table (per-class P/R/F1/support)
2. Confusion matrix
3. Comparison vs previous version (regression table)
4. Known weaknesses (which classes are weakest and why)
5. Data gaps (what kinds of examples are missing)
6. Benchmark pass/fail summary
7. Speed and size measurements

## 7. Automation

### 7.1 GitHub Actions (CI)

The `publish-models.yml` workflow:
1. Validates `nanomind-models.json` schema
2. Runs accuracy benchmark (dry run)
3. Checks model file sizes
4. Publishes to HuggingFace
5. Notifies consumer repos via `repository_dispatch`

### 7.2 Future: Automated Benchmark Pipeline

Goal: A single `make benchmark` command that runs all 7 benchmarks and produces a go/no-go report.

```bash
make benchmark MODEL_DIR=training/models-tme-v6 CORPUS_DIR=../nanomind-training/corpus/sft-v9
# Output: benchmark-report.json with PASS/FAIL per benchmark
```

This does not exist yet. Building it is a priority for the model owner.
