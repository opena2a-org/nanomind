# NanoMind Training Playbook

**Version:** 1.0
**Last Updated:** 2026-04-09
**Companion to:** [SPECIFICATION.md](SPECIFICATION.md), [EVALUATION-STANDARD.md](EVALUATION-STANDARD.md)

---

## 1. Purpose

This is the step-by-step guide for training, evaluating, exporting, and publishing a NanoMind model. Follow it exactly. Every deviation must be documented in the model card.

## 2. Prerequisites

### 2.1 Hardware

- Apple Silicon Mac (M1/M2/M3/M4) with MLX support for training
- Minimum 16 GB RAM (32 GB recommended for larger models)
- GPU acceleration via MLX (automatic on Apple Silicon)

### 2.2 Software

```bash
# Python 3.12+ with MLX
pip install mlx numpy

# For ONNX export
pip install torch onnx onnxruntime

# For HuggingFace publishing
pip install huggingface_hub
```

### 2.3 Repository Layout

```
nanomind/                          # Model definitions and training scripts
  training/
    scripts/
      train-tme-mlx.py            # Main training script (MLX)
      export-onnx.py              # MLX -> ONNX conversion
      push-to-huggingface.py      # HuggingFace publishing
    models-tme-v{N}/              # Trained model artifacts per version
    evaluation/                    # Benchmark scripts
  nanomind-models.json            # Model catalog and manifest
  docs/                           # This documentation

nanomind-training/                 # Training data (separate private repo)
  corpus/
    sft-v{N}/                     # Versioned training corpora
      train.json                  # Training data
      eval.json                   # Evaluation data
      holdout.json                # Holdout test data
      metadata.json               # Corpus documentation
  scripts/                        # Corpus building scripts
  benchmarks/                     # Benchmark datasets
```

## 3. Data Collection (before training)

### Step 0: Collect Data from Registry Pipeline

For models beyond the initial local corpus, the Registry is the primary data source. This step is optional for small iterations but **mandatory for reaching 99.999%**.

```bash
# Export labeled training data from Registry (requires INTERNAL_API_KEY)
# Sources: registry scans, agentpwn confirmed attacks, ARIA findings, HMA evidence
curl -H "X-Internal-Key: $INTERNAL_API_KEY" \
  "https://api.oa2a.org/internal/nanomind/training-export?sources=registry,agentpwn,aria,hma&since=2026-01-01&limit=50000" \
  -o registry-export.json

# Or use the collection script (collects skill packages as training data)
node scripts/collect-skills-corpus.js \
  --registry-url=https://api.oa2a.org \
  --limit=50000
```

**Quality review of Registry exports:**

| Confidence | Action |
|-----------|--------|
| >= 0.90 | Auto-include (Registry scans with critical findings, AgentPwn confirmed) |
| 0.85 - 0.90 | Auto-include with spot-check (10% sample review) |
| 0.60 - 0.85 | Manual review required (warnings, edge cases) |
| < 0.60 | Exclude or escalate for relabeling |

**Merge with local corpus:**

```python
# Deduplicate by content hash
import hashlib
existing_hashes = set(hashlib.sha256(s['input'].encode()).hexdigest() for s in local_corpus)
new_samples = [s for s in registry_export if hashlib.sha256(s['input'].encode()).hexdigest() not in existing_hashes]
combined = local_corpus + new_samples
```

**Check feedback corrections:**

```bash
# Get recent corrections that indicate model confusion
curl -H "X-Internal-Key: $INTERNAL_API_KEY" \
  "https://api.oa2a.org/api/v1/nanomind/stats"
# Review: correctionsLast7Days by class -- these are the highest-priority training gaps
```

## 4. Training Pipeline

### Step 1: Verify Corpus

Before training, validate the corpus:

```bash
cd ~/workspace/opena2a-org/nanomind

# Check corpus exists and has required files
ls ../nanomind-training/corpus/sft-v9/
# Expected: train.json, eval.json, holdout.json, metadata.json

# Verify sample counts and class balance
python3 -c "
import json
from collections import Counter
train = json.load(open('../nanomind-training/corpus/sft-v9/train.json'))
eval_data = json.load(open('../nanomind-training/corpus/sft-v9/eval.json'))
print(f'Train: {len(train)}, Eval: {len(eval_data)}')
dist = Counter(s['attackClass'] for s in train)
for cls, count in sorted(dist.items()):
    print(f'  {cls}: {count}')
"
```

**Check:**
- All expected classes are present
- Class balance within 20% of median
- Train >= 3000, eval >= 200
- Real data >= 50% (check metadata.json)

### Step 2: Train the Model

```bash
python3 training/scripts/train-tme-mlx.py \
  --corpus-dir ../nanomind-training/corpus/sft-v9 \
  --output-dir training/models-tme-v6 \
  --epochs 300 \
  --batch-size 64 \
  --layers 8 \
  --d-model 128 \
  --dropout 0.1 \
  --lr 0.001 \
  --patience 50 \
  --vocab-size 6000
```

**Hyperparameter Guide:**

| Parameter | Default | When to Change |
|-----------|---------|---------------|
| `epochs` | 300 | Increase to 500 if early stopping triggers before epoch 100 |
| `batch-size` | 64 | Decrease to 32 if dataset < 2000 samples |
| `layers` | 8 | Increase to 10-12 for 15+ classes |
| `d-model` | 128 | Increase to 192-256 for 15+ classes or complex tasks |
| `dropout` | 0.1 | Increase to 0.15-0.2 if overfitting (100% train, <90% eval) |
| `lr` | 0.001 | Decrease to 0.0005 if training is unstable |
| `patience` | 50 | Increase to 80 if eval loss is still improving slowly |
| `vocab-size` | 6000 | Increase if Unicode/multilingual content is important |

**Training Output:**

The script produces in `training/models-tme-v{N}/`:
- `nanomind-tme-classifier.npz` -- Best checkpoint (MLX weights)
- `nanomind-tme-classifier-final.npz` -- Final epoch checkpoint
- `tokenizer.json` -- Vocabulary mapping
- `eval-report.json` -- Full evaluation metrics

### Step 3: Evaluate Results

Read `eval-report.json` and check:

1. **Overall accuracy** >= threshold (currently 95%)
2. **Per-class F1** >= 0.90 for all classes
3. **Confusion matrix** -- are there systematic misclassifications?
4. **All targets met?** -- If not, see troubleshooting below

### Step 4: Export to ONNX

```bash
python3 training/scripts/export-onnx.py \
  --model-dir training/models-tme-v6 \
  --d-model 128 \
  --layers 8
```

**Verify:**
- Output shows "Verification: pred=..., logits shape=(1, N)" where N = number of classes
- ONNX file size is within budget (< 10 MB total for CLI classification)

### Step 5: Get SHA-256 Hashes

```bash
cd training/models-tme-v6
for f in tokenizer.json nanomind-tme.onnx nanomind-tme.onnx.data; do
  echo "$f: $(shasum -a 256 $f | cut -d' ' -f1)"
done
```

Record these hashes -- they go in `nanomind-models.json` and in consumer code.

### Step 6: Update Model Catalog

Edit `nanomind-models.json`:

1. Change previous "latest" version status to "stable"
2. Add new version entry with:
   - `architecture` (e.g., "Mamba TME (8 blocks, d_model=128, d_state=64)")
   - `modelDir` (e.g., "training/models-tme-v6")
   - `files` list
   - `metrics` (evalAccuracy, macroF1, trainSamples, evalSamples, classes)
   - `corpus` version
   - `vocabSize`
   - `sha256` hashes
   - `status: "latest"`
3. Update `latestVersion`
4. Update `attackClasses` if new classes were added
5. Update model description if class count changed

### Step 7: Write Model Card

Create `docs/model-cards/v{VERSION}.md` using the template in [MODEL-CARD-TEMPLATE.md](MODEL-CARD-TEMPLATE.md).

### Step 8: Commit and Push

```bash
git checkout -b feat/tme-v{N}-{description}
git add -f nanomind-models.json \
  training/scripts/train-tme-mlx.py \
  training/scripts/export-onnx.py \
  training/models-tme-v{N}/ \
  docs/model-cards/v{VERSION}.md
git commit -m "Add {N}-class TME model v{VERSION} with {description}"
```

### Step 9: Publish to HuggingFace

**Option A: Via CI (recommended)**
Push to main. The `publish-models.yml` workflow auto-publishes.

**Option B: Manual**
```bash
python3 training/scripts/push-to-huggingface.py \
  --model nanomind-security-classifier \
  --version {VERSION}
```

### Step 10: Update Consumer Tools

For each consumer (currently HMA, OpenA2A CLI):

1. Update SHA-256 hashes in model download code
2. Add new class to CLASSES array if taxonomy changed
3. Update any hardcoded `num_classes` values
4. Run consumer tests
5. Commit and push consumer updates

For HMA specifically:
```
hackmyagent/src/nanomind-core/inference/tme-classifier.ts
  - MODEL_FILES[].sha256 values
  - CLASSES array (add new classes)
```

## 5. Troubleshooting

### Problem: Model overfits (100% train, <90% eval)

**Root cause:** Not enough training data, or training data lacks diversity.

**Solutions (try in order):**
1. Increase dropout (0.1 -> 0.15 -> 0.2)
2. Decrease learning rate (0.001 -> 0.0005)
3. Add more training data from previous corpus versions (augmentation)
4. Add synthetic examples for weak classes
5. Try smaller model (fewer layers or smaller d_model)

### Problem: Specific class has low F1

**Root cause:** Usually insufficient or non-diverse examples for that class.

**Solutions:**
1. Check confusion matrix: what is it being confused with?
2. Add more examples that distinguish the confused classes
3. If class has < 300 training samples, augment from previous corpus or generate synthetic
4. Check if eval samples for that class are too few (< 30) -- metrics may be noise

### Problem: New class causes regression in existing classes

**Root cause:** Training data for existing classes was reduced to make room, or the new class overlaps semantically.

**Solutions:**
1. Augment existing classes from previous corpus (keep all previous data + add new class)
2. Increase total dataset size rather than redistributing
3. Check for label contamination (samples in one class that should be in the new class)
4. The v0.4.0 training demonstrated this: v9 alone regressed, but v9 + v8 augmentation worked

### Problem: Eval set too small for reliable metrics

**Root cause:** Corpus building produced too few eval samples.

**Solutions:**
1. Merge holdout into eval (the training script does this automatically when eval < 300)
2. Generate more eval data for the next corpus version
3. Document in model card that metrics are provisional

### Problem: ONNX export fails

**Root cause:** PyTorch/ONNX version incompatibility or unsupported ops.

**Solutions:**
1. Check for opset version warnings -- newer PyTorch may export at opset 18+ while script requests 14
2. The export script will auto-upgrade opset if needed -- check the warning output
3. Verify with onnxruntime: the script includes a verification step
4. If verification fails, check that `num_classes` in the export script matches training

## 6. Data Augmentation Strategy

When the training corpus is too small or imbalanced:

### 5.1 Cross-Corpus Augmentation (preferred)

Combine current corpus with samples from previous versions:

```python
# Use ALL of current corpus (has correct labels for new classes)
combined = list(current_train)

# Augment only UNCONTAMINATED classes from previous corpus
for cls in safe_classes:  # Exclude classes that were relabeled
    current_count = len([s for s in combined if s['attackClass'] == cls])
    needed = target_per_class - current_count
    # Add non-duplicate samples from previous corpus
```

**Critical:** When a new class was created by relabeling samples from an existing class (e.g., steganography from policy_violation), do NOT augment the old class from the previous corpus. Those samples contain the now-relabeled content and will confuse the model.

### 5.2 Synthetic Generation

Use LLM to generate additional examples. Rules:
- Mark synthetic samples with `"source": "synthetic"`
- Keep synthetic < 50% of total corpus
- Review synthetic samples before including in "stable" models
- Synthetic samples must be diverse (not minor variations of templates)

### 5.3 Active Learning (future)

When production inference pipeline is running:
1. Log samples where model confidence < 0.7
2. Queue for human review
3. Reviewed samples feed into next training corpus
4. Prioritize samples near decision boundaries

## 7. Reproducibility Checklist

Every training run must be reproducible. Before considering a training run complete:

- [ ] Training command documented (exact arguments)
- [ ] Corpus version documented (sft-v{N})
- [ ] Any augmentation documented (what was added from where)
- [ ] Random seed is fixed (default: 42 in training script)
- [ ] eval-report.json saved in model directory
- [ ] Model card written with full metrics
- [ ] SHA-256 hashes recorded
- [ ] nanomind-models.json updated

## 8. Quick Reference

### Train a model
```bash
cd ~/workspace/opena2a-org/nanomind
python3 training/scripts/train-tme-mlx.py \
  --corpus-dir ../nanomind-training/corpus/sft-v9 \
  --output-dir training/models-tme-v6
```

### Export to ONNX
```bash
python3 training/scripts/export-onnx.py --model-dir training/models-tme-v6
```

### Get SHA-256 hashes
```bash
for f in tokenizer.json nanomind-tme.onnx nanomind-tme.onnx.data; do
  echo "$f: $(shasum -a 256 training/models-tme-v6/$f | cut -d' ' -f1)"
done
```

### Publish to HuggingFace (manual)
```bash
python3 training/scripts/push-to-huggingface.py --model nanomind-security-classifier --version 0.4.0
```
