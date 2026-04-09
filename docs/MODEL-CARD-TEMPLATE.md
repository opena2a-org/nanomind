# Model Card Template

Copy this template to `docs/model-cards/v{VERSION}.md` for each model release. Fill in every section. "N/A" is acceptable only with a documented reason.

---

```markdown
# Model Card: nanomind-security-classifier v{VERSION}

**Released:** {YYYY-MM-DD}
**Status:** latest | stable | deprecated
**Corpus:** sft-v{N}
**Previous Version:** v{PREV}
**Trained By:** {name / "Claude LLM (automated)"}

## Summary

{1-2 sentence description of what changed in this version and why.}

## Architecture

| Parameter | Value |
|-----------|-------|
| Architecture | Mamba TME ({N} blocks, d_model={D}, d_state=64) |
| Vocab size | {VOCAB} |
| Parameters | {COUNT} |
| ONNX model size | {SIZE} KB |
| ONNX data size | {SIZE} MB |
| Tokenizer size | {SIZE} KB |
| Total size | {SIZE} MB |
| Classes | {N} |

## Training

| Parameter | Value |
|-----------|-------|
| Corpus | sft-v{N} |
| Training samples | {N} |
| Eval samples | {N} |
| Holdout samples | {N} |
| Epochs | {N} (early stopped at {M}) |
| Batch size | {N} |
| Learning rate | {LR} (cosine schedule) |
| Dropout | {D} |
| Training time | {T}s |
| Hardware | {e.g., "Apple M4 Max, 32 GB, MLX GPU"} |
| Random seed | 42 |

### Data Augmentation

{Describe any augmentation. If none, say "None."}

Example:
> v9 base corpus augmented with 169 samples from v8 for 7 attack classes
> (exfiltration, injection, privilege_escalation, persistence, credential_abuse,
> lateral_movement, social_engineering). v8 policy_violation excluded due to
> steganography label contamination.

## Evaluation Metrics

### Overall

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Best eval accuracy | {X}% | >= 95% | PASS/FAIL |
| Final accuracy | {X}% | >= 95% | PASS/FAIL |
| Macro F1 | {X} | >= 0.94 | PASS/FAIL |

### Per-Class

| Class | Precision | Recall | F1 | Support | Target | Status |
|-------|-----------|--------|-----|---------|--------|--------|
| exfiltration | {P} | {R} | {F1} | {N} | >= 0.90 | PASS/FAIL |
| injection | {P} | {R} | {F1} | {N} | >= 0.90 | PASS/FAIL |
| ... | ... | ... | ... | ... | ... | ... |

### Confusion Matrix

{Paste confusion matrix from eval-report.json}

### Regression vs Previous Version

| Class | v{PREV} F1 | v{VERSION} F1 | Delta | Status |
|-------|------------|---------------|-------|--------|
| exfiltration | {X} | {Y} | {D} | OK/REGRESSED |
| ... | ... | ... | ... | ... |

## Benchmark Results

| Benchmark | Result | Pass | Notes |
|-----------|--------|------|-------|
| Accuracy | {X}% | PASS/FAIL | |
| Regression | max drop {X} | PASS/FAIL | |
| Holdout | {X}% | PASS/FAIL/N/A | |
| Latency (p99) | {X}ms | PASS/FAIL/N/A | |
| Size | {X} MB | PASS/FAIL | |
| False positive | {N} false CRITICAL | PASS/FAIL/N/A | |
| Robustness | {X}% drop | PASS/FAIL/N/A | |

## SHA-256 Integrity

| File | SHA-256 |
|------|---------|
| tokenizer.json | {HASH} |
| nanomind-tme.onnx | {HASH} |
| nanomind-tme.onnx.data | {HASH} |

## Known Limitations

{List specific weaknesses, failure modes, and data gaps.}

Example:
- Exfiltration F1 at 0.840 (below 0.90 target). Only 24 eval samples -- metrics are noisy.
  Root cause: exfiltration overlaps semantically with credential_abuse and lateral_movement.
  Fix: add 100+ diverse exfiltration examples in next corpus.
- No adversarial robustness testing (adversarial dataset not yet created).
- Steganography class is new and untested against real-world attacks.

## Consumer Impact

{Which tools need updating? What changes are required?}

| Consumer | Update Required | Changes |
|----------|----------------|---------|
| HMA | Yes | Update SHA-256, add steganography class |
| OpenA2A CLI | No | Delegates to HMA |
| ai-trust | No | Uses different model |

## Decision Log

{Key decisions made during this training run.}

| Decision | Rationale |
|----------|-----------|
| Augmented with v8 data | v9 alone had too few samples per class (318 vs 400) |
| Excluded v8 policy_violation | Contaminated with steganography-labeled content |
| Increased vocab to 6000 | Better Unicode token capture for stego class |
| Merged holdout into eval | Eval set too small (194 samples, some classes < 15) |

## Reproduction

{Exact commands to reproduce this model.}

\```bash
cd ~/workspace/opena2a-org/nanomind

# Step 1: Build augmented corpus (if applicable)
python3 -c "<corpus augmentation script>"

# Step 2: Train
python3 training/scripts/train-tme-mlx.py \
  --corpus-dir {CORPUS_DIR} \
  --output-dir training/models-tme-v{N} \
  --epochs {E} --batch-size {B} --layers {L} --d-model {D} \
  --dropout {DR} --lr {LR} --patience {P} --vocab-size {V}

# Step 3: Export ONNX
python3 training/scripts/export-onnx.py --model-dir training/models-tme-v{N}

# Step 4: Verify
shasum -a 256 training/models-tme-v{N}/nanomind-tme.onnx
\```
```
