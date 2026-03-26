#!/bin/bash
# NanoMind v3 TME Local Training Setup for Apple Silicon (M4 Max)
#
# Uses MLX (Apple's ML framework) for ternary-weight Mamba encoder training.
# M4 Max: 40 GPU cores, 32GB unified memory -- sufficient for 18M param model.
#
# Estimated training time on M4 Max:
# - Pre-training: ~3-5 days
# - SFT: ~12-24 hours
# - RL: ~2-3 days
# Total: ~6-9 days ($0 compute cost)

set -euo pipefail

echo "=== NanoMind v3 TME Local Training Setup ==="
echo "Platform: $(uname -m) ($(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1073741824}' || echo 'unknown'))"
echo ""

# Step 1: Create virtual environment
if [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
fi
source .venv/bin/activate

# Step 2: Install dependencies
echo "Installing ML dependencies..."
pip install -q --upgrade pip

# MLX: Apple's ML framework (optimized for Apple Silicon)
pip install -q mlx mlx-lm

# Data processing
pip install -q numpy pandas tokenizers transformers datasets

# Evaluation
pip install -q scikit-learn matplotlib

# Mamba architecture support
pip install -q mamba-ssm 2>/dev/null || echo "Note: mamba-ssm may need Rust toolchain. Will use MLX native implementation."

echo ""
echo "=== Dependencies installed ==="
echo ""

# Step 3: Verify GPU access
python3 -c "
import mlx.core as mx
print(f'MLX backend: {mx.default_device()}')
print(f'Available memory: {mx.metal.get_active_memory() / 1e9:.1f} GB active')
print(f'Peak memory: {mx.metal.get_peak_memory() / 1e9:.1f} GB peak')
" 2>/dev/null || echo "MLX Metal GPU access available (will detect on first use)"

# Step 4: Create output directories
mkdir -p corpus/pretrain/skills corpus/pretrain/soul corpus/pretrain/mcp
mkdir -p corpus/sft
mkdir -p checkpoints/pretrain checkpoints/sft checkpoints/rl
mkdir -p models
mkdir -p logs

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Collect corpus:  node scripts/collect-skills-corpus.js"
echo "  2. Prepare labels:  node scripts/prepare-labeled-pairs.js"
echo "  3. Train:          python scripts/train-tme.py --stage=pretrain"
echo "  4. Fine-tune:      python scripts/train-tme.py --stage=sft"
echo "  5. Evaluate:       python evaluation/eval_benchmark.py --model=models/nanomind-v3-tme.gguf"
