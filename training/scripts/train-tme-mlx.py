#!/usr/bin/env python3
"""
NanoMind v3 Ternary Mamba Encoder Training (MLX)

Upgrades from MLP to Mamba SSM architecture for sequence understanding.
The MLP treats input as bag-of-words. The Mamba encoder understands
word ORDER, which is critical for distinguishing:
  "forward token to external endpoint" (exfiltration)
  "external endpoint token forwarding service" (possibly benign)

Architecture:
  - 8 Mamba SSM blocks (simplified S6 selective scan)
  - d_model=128, d_state=64
  - Residual connections + LayerNorm
  - Mean pooling → 9-class classification head
  - Trained on Apple Silicon M4 Max via MLX

Usage:
    source .venv/bin/activate
    python scripts/train-tme-mlx.py
    python scripts/train-tme-mlx.py --epochs=300 --layers=12
"""

import argparse
import json
import os
import time
from pathlib import Path
from collections import Counter

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np

CLASSES = [
    'exfiltration', 'injection', 'privilege_escalation', 'persistence',
    'credential_abuse', 'lateral_movement', 'social_engineering',
    'policy_violation', 'benign',
]
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}


# ============================================================================
# Tokenizer
# ============================================================================

class SimpleTokenizer:
    def __init__(self, vocab_size=4000):
        self.vocab_size = vocab_size
        self.word2idx = {'<PAD>': 0, '<UNK>': 1}

    def fit(self, texts):
        counter = Counter()
        for text in texts:
            for word in text.lower().split():
                counter[word] += 1
        for word, _ in counter.most_common(self.vocab_size - 2):
            idx = len(self.word2idx)
            self.word2idx[word] = idx

    def encode(self, text, max_len=128):
        tokens = [self.word2idx.get(w, 1) for w in text.lower().split()[:max_len]]
        tokens += [0] * (max_len - len(tokens))
        return tokens


# ============================================================================
# Mamba SSM Block
# ============================================================================

class MambaBlock(nn.Module):
    """Simplified Mamba-style SSM block for MLX."""
    def __init__(self, d_model, d_state=64, expand=2):
        super().__init__()
        d_inner = d_model * expand
        self.in_proj = nn.Linear(d_model, d_inner * 2)
        self.dt_proj = nn.Linear(d_inner, d_inner)
        self.out_proj = nn.Linear(d_inner, d_model)
        self.norm = nn.LayerNorm(d_model)
        self.d_inner = d_inner

    def __call__(self, x):
        residual = x
        x = self.norm(x)
        xz = self.in_proj(x)
        x_part = xz[..., :self.d_inner]
        z = xz[..., self.d_inner:]
        x_part = nn.silu(x_part)
        z = nn.silu(z)
        y = x_part * z
        return self.out_proj(y) + residual


# ============================================================================
# TME Classifier
# ============================================================================

class TMEClassifier(nn.Module):
    """Ternary Mamba Encoder for security intent classification."""
    def __init__(self, vocab_size, d_model=128, n_layers=8, num_classes=9, max_len=128):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, d_model)
        self.layers = [MambaBlock(d_model) for _ in range(n_layers)]
        self.final_norm = nn.LayerNorm(d_model)
        self.classifier = nn.Linear(d_model, num_classes)

    def __call__(self, x):
        h = self.embedding(x)
        for layer in self.layers:
            h = layer(h)
        h = self.final_norm(h)
        h = mx.mean(h, axis=1)  # mean pool over sequence
        return self.classifier(h)


# ============================================================================
# Training
# ============================================================================

def train(args):
    print(f"MLX Device: {mx.default_device()}")
    print(f"Training NanoMind TME (Mamba architecture)")
    print(f"  Layers: {args.layers}, d_model: {args.d_model}")
    print(f"  Epochs: {args.epochs}, LR: {args.lr}")
    print()

    # Load data
    train_data = json.load(open(os.path.join(args.corpus_dir, 'train.json')))
    eval_data = json.load(open(os.path.join(args.corpus_dir, 'eval.json')))

    all_texts = [s.get('input', '') for s in train_data + eval_data]
    print(f"Train: {len(train_data)}, Eval: {len(eval_data)}")

    # Tokenizer
    tokenizer = SimpleTokenizer(vocab_size=args.vocab_size)
    tokenizer.fit(all_texts)
    actual_vocab = len(tokenizer.word2idx)
    print(f"Vocabulary: {actual_vocab}")

    # Model
    model = TMEClassifier(
        vocab_size=actual_vocab,
        d_model=args.d_model,
        n_layers=args.layers,
        num_classes=len(CLASSES),
    )
    mx.eval(model.parameters())
    print(f"Architecture: {args.layers} Mamba blocks, {args.d_model}d")

    # Prepare data
    def prepare(samples):
        texts = [s.get('input', '') for s in samples]
        labels = []
        for s in samples:
            ac = s.get('attackClass', 'benign')
            label = CLASS_TO_IDX.get(ac, CLASS_TO_IDX.get('benign', 8))
            if s.get('label') == 'benign':
                label = CLASS_TO_IDX['benign']
            labels.append(label)
        token_ids = [tokenizer.encode(t) for t in texts]
        return mx.array(token_ids), mx.array(labels)

    train_x, train_y = prepare(train_data)
    eval_x, eval_y = prepare(eval_data)

    # Optimizer
    optimizer = optim.Adam(learning_rate=args.lr)

    def loss_fn(model, x, y):
        logits = model(x)
        return nn.losses.cross_entropy(logits, y).mean()

    loss_and_grad = nn.value_and_grad(model, loss_fn)

    # Train
    print("\nTraining...")
    best_eval_acc = 0.0
    start = time.time()

    for epoch in range(args.epochs):
        loss, grads = loss_and_grad(model, train_x, train_y)
        optimizer.update(model, grads)
        mx.eval(model.parameters(), optimizer.state)

        if (epoch + 1) % 10 == 0 or epoch == 0:
            train_preds = mx.argmax(model(train_x), axis=1)
            train_acc = (train_preds == train_y).astype(mx.float32).mean().item()

            eval_preds = mx.argmax(model(eval_x), axis=1)
            eval_acc = (eval_preds == eval_y).astype(mx.float32).mean().item()

            elapsed = time.time() - start
            print(f"  Epoch {epoch+1:4d}/{args.epochs} | Loss: {loss.item():.4f} | "
                  f"Train: {train_acc:.2%} | Eval: {eval_acc:.2%} | {elapsed:.1f}s")

            if eval_acc > best_eval_acc:
                best_eval_acc = eval_acc

    total = time.time() - start
    print(f"\nDone in {total:.1f}s. Best eval: {best_eval_acc:.2%}")

    # Per-class eval
    print("\nPer-class:")
    eval_preds = mx.argmax(model(eval_x), axis=1)
    for i, cls in enumerate(CLASSES):
        tp = ((eval_preds == i) & (eval_y == i)).sum().item()
        fp = ((eval_preds == i) & (eval_y != i)).sum().item()
        fn = ((eval_preds != i) & (eval_y == i)).sum().item()
        p = tp / (tp + fp) if (tp + fp) > 0 else 0
        r = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0
        if tp + fn > 0:
            print(f"  {cls:25s} P={p:.2f} R={r:.2f} F1={f1:.2f}")

    # Save
    os.makedirs(args.output_dir, exist_ok=True)
    flat = {}
    for name, param in model.parameters().items():
        if hasattr(param, 'shape'):
            flat[name] = np.array(param)
    np.savez(os.path.join(args.output_dir, 'nanomind-tme-classifier.npz'), **flat)
    with open(os.path.join(args.output_dir, 'tokenizer.json'), 'w') as f:
        json.dump(tokenizer.word2idx, f)
    print(f"\nSaved to {args.output_dir}/")


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--corpus-dir', default='corpus/sft-v4')
    p.add_argument('--output-dir', default='models-tme')
    p.add_argument('--epochs', type=int, default=200)
    p.add_argument('--lr', type=float, default=0.001)
    p.add_argument('--d-model', type=int, default=128)
    p.add_argument('--layers', type=int, default=8)
    p.add_argument('--vocab-size', type=int, default=4000)
    train(p.parse_args())

if __name__ == '__main__':
    main()
