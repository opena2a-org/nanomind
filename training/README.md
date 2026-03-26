# NanoMind v3 TME Training Pipeline

Ternary Mamba Encoder -- 18M param, 3.5MB disk, < 6ms inference on any CPU.

## Architecture

- **Type:** Bidirectional discriminative encoder (NOT autoregressive decoder)
- **Backbone:** Mamba-3 SSM (O(1) memory, O(n) complexity, no KV cache)
- **Weights:** Native 1.58-bit ternary (BitNet methodology, trained from scratch)
- **Output:** 9-class softmax + evidence span indices
- **Dimensions:** d_model=128, n_mamba_layers=24, 3 GQA attention layers (at 9, 18, 27)

## Attack Classes (9)

1. exfiltration
2. injection
3. privilege_escalation
4. persistence
5. credential_abuse
6. lateral_movement
7. social_engineering
8. policy_violation
9. benign

## Training Stages

### Stage 1: Domain Pre-training (2-3 weeks)
- Corpus: public agent code, SOUL.md files, MCP descriptions, OASB controls, HMA rationale
- Objective: learn security artifact language in ternary weights
- Config: `configs/pretrain.yaml`

### Stage 2: Supervised Fine-tuning (1 week)
- Corpus: DVAA attack corpus, HMA payloads, OASB benchmark dataset, ARIA variants
- Objective: 9-class discrimination + evidence span prediction
- Config: `configs/sft.yaml`

### Stage 3: RL in DVAA Environments (1-2 weeks)
- Environments: live DVAA attack scenarios
- Reward: correct classification + evidence quality + confidence calibration
- Technique: GRPO (Group Relative Policy Optimization)
- Config: `configs/rl.yaml`

## Corpus Collection

```bash
# Collect public skills corpus from Registry
node scripts/collect-skills-corpus.js --registry-url=https://api.oa2a.org --limit=50000

# Collect SOUL.md corpus from public repos
node scripts/collect-soul-corpus.js --limit=5000

# Collect MCP tool descriptions from Registry catalog
node scripts/collect-mcp-corpus.js --registry-url=https://api.oa2a.org --limit=200000

# Prepare labeled training pairs from DVAA + HMA
node scripts/prepare-labeled-pairs.js --dvaa-path=../damn-vulnerable-ai-agent --hma-path=../hackmyagent
```

## Evaluation

```bash
# Evaluate on OASB benchmark holdout set
python evaluation/eval_benchmark.py --model=models/nanomind-v3-tme.gguf --dataset=corpus/oasb-holdout.json

# Target: F1 > 0.85 on malicious skills holdout
```

## Cost Estimate
- Training: ~$2,000-4,000 on 4x A100 (spot instances)
- Quarterly retraining: ~$3,000 per cycle
- Compare: NanoMind v2 770M model was $15-20K
