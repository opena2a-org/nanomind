#!/usr/bin/env python3
"""
NanoMind v3 TME Supervised Fine-Tuning (MLX)

Real training loop using Apple Silicon GPU via MLX.
Trains a 9-class security intent classifier on labeled attack data.

This is the actual training script (not a stub). It:
1. Loads labeled pairs from corpus/sft/
2. Tokenizes using a simple word-level tokenizer
3. Builds a small MLP classifier (stepping stone to full Mamba TME)
4. Trains with cross-entropy loss on Apple Silicon GPU
5. Evaluates F1 on holdout set
6. Saves trained weights

Usage:
    source .venv/bin/activate
    python scripts/train-sft-mlx.py
    python scripts/train-sft-mlx.py --epochs=50 --lr=0.001
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

# Attack classes (9-way classification)
CLASSES = [
    'exfiltration', 'injection', 'privilege_escalation', 'persistence',
    'credential_abuse', 'lateral_movement', 'social_engineering',
    'policy_violation', 'benign',
]
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}

# ============================================================================
# Simple Tokenizer (word-level, for bootstrapping)
# ============================================================================

class SimpleTokenizer:
    def __init__(self, vocab_size=8000):
        self.vocab_size = vocab_size
        self.word2idx = {'<PAD>': 0, '<UNK>': 1}
        self.idx2word = {0: '<PAD>', 1: '<UNK>'}

    def fit(self, texts):
        counter = Counter()
        for text in texts:
            for word in text.lower().split():
                counter[word] += 1
        for word, _ in counter.most_common(self.vocab_size - 2):
            idx = len(self.word2idx)
            self.word2idx[word] = idx
            self.idx2word[idx] = word

    def encode(self, text, max_len=256):
        tokens = [self.word2idx.get(w, 1) for w in text.lower().split()[:max_len]]
        # Pad to max_len
        tokens += [0] * (max_len - len(tokens))
        return tokens


# ============================================================================
# MLP Classifier (stepping stone to full Mamba TME)
# ============================================================================

class SecurityClassifier(nn.Module):
    """
    Simple MLP classifier for bootstrapping NanoMind training.
    This trains fast and validates the pipeline.
    Will be replaced by Mamba TME encoder for production.
    """
    def __init__(self, vocab_size, embed_dim=64, hidden_dim=128, num_classes=9, max_len=256):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, embed_dim)
        self.fc1 = nn.Linear(embed_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.fc3 = nn.Linear(hidden_dim, num_classes)
        self.max_len = max_len

    def __call__(self, x):
        # x: (batch, seq_len) integer token IDs
        embeds = self.embedding(x)          # (batch, seq_len, embed_dim)
        pooled = mx.mean(embeds, axis=1)    # (batch, embed_dim) mean pooling
        h = nn.relu(self.fc1(pooled))       # (batch, hidden_dim)
        h = nn.relu(self.fc2(h))            # (batch, hidden_dim)
        logits = self.fc3(h)                # (batch, num_classes)
        return logits


# ============================================================================
# Data Loading
# ============================================================================

def load_sft_data(corpus_dir):
    """Load labeled training pairs from corpus/sft/."""
    train_path = os.path.join(corpus_dir, 'train.json')
    eval_path = os.path.join(corpus_dir, 'eval.json')

    train_data = json.load(open(train_path)) if os.path.exists(train_path) else []
    eval_data = json.load(open(eval_path)) if os.path.exists(eval_path) else []

    return train_data, eval_data


def prepare_batch(samples, tokenizer):
    """Convert samples to model inputs."""
    texts = [s.get('input', s.get('description', '')) for s in samples]
    labels = []
    for s in samples:
        attack_class = s.get('attackClass', 'benign')
        # Map to our 9 classes
        label = CLASS_TO_IDX.get(attack_class, CLASS_TO_IDX.get('injection', 1))
        if s.get('label') == 'benign':
            label = CLASS_TO_IDX['benign']
        labels.append(label)

    token_ids = [tokenizer.encode(t) for t in texts]
    return mx.array(token_ids), mx.array(labels)


# ============================================================================
# Training Loop
# ============================================================================

def train(args):
    print(f"MLX Device: {mx.default_device()}")
    print(f"Training NanoMind Security Classifier")
    print(f"  Epochs: {args.epochs}")
    print(f"  Learning rate: {args.lr}")
    print(f"  Corpus: {args.corpus_dir}")
    print()

    # Load data
    train_data, eval_data = load_sft_data(args.corpus_dir)
    if not train_data:
        print("No training data found. Run prepare-labeled-pairs.js first.")
        return

    all_texts = [s.get('input', s.get('description', '')) for s in train_data + eval_data]
    print(f"Train samples: {len(train_data)}, Eval samples: {len(eval_data)}")

    # Build tokenizer
    tokenizer = SimpleTokenizer(vocab_size=args.vocab_size)
    tokenizer.fit(all_texts)
    actual_vocab = len(tokenizer.word2idx)
    print(f"Vocabulary: {actual_vocab} words")

    # Build model
    model = SecurityClassifier(
        vocab_size=actual_vocab,
        embed_dim=args.embed_dim,
        hidden_dim=args.hidden_dim,
        num_classes=len(CLASSES),
    )
    mx.eval(model.parameters())

    param_count = sum(p.size for p in model.parameters().values() if hasattr(p, 'size'))
    print(f"Model parameters: {param_count:,}")
    print()

    # Optimizer
    optimizer = optim.Adam(learning_rate=args.lr)

    # Loss function
    def loss_fn(model, x, y):
        logits = model(x)
        return nn.losses.cross_entropy(logits, y).mean()

    loss_and_grad = nn.value_and_grad(model, loss_fn)

    # Prepare batches
    train_x, train_y = prepare_batch(train_data, tokenizer)
    eval_x, eval_y = prepare_batch(eval_data, tokenizer) if eval_data else (None, None)

    # Training loop
    print("Training...")
    best_eval_acc = 0.0
    start_time = time.time()

    for epoch in range(args.epochs):
        # Forward + backward
        loss, grads = loss_and_grad(model, train_x, train_y)
        optimizer.update(model, grads)
        mx.eval(model.parameters(), optimizer.state)

        loss_val = loss.item()

        # Evaluate every 10 epochs
        if (epoch + 1) % 10 == 0 or epoch == 0:
            # Training accuracy
            train_logits = model(train_x)
            train_preds = mx.argmax(train_logits, axis=1)
            train_acc = (train_preds == train_y).astype(mx.float32).mean().item()

            # Eval accuracy
            eval_acc = 0.0
            if eval_x is not None:
                eval_logits = model(eval_x)
                eval_preds = mx.argmax(eval_logits, axis=1)
                eval_acc = (eval_preds == eval_y).astype(mx.float32).mean().item()

            elapsed = time.time() - start_time
            print(f"  Epoch {epoch+1:4d}/{args.epochs} | Loss: {loss_val:.4f} | "
                  f"Train acc: {train_acc:.2%} | Eval acc: {eval_acc:.2%} | "
                  f"Time: {elapsed:.1f}s")

            if eval_acc > best_eval_acc:
                best_eval_acc = eval_acc

    total_time = time.time() - start_time
    print(f"\nTraining complete in {total_time:.1f}s")
    print(f"Best eval accuracy: {best_eval_acc:.2%}")

    # Final evaluation with per-class metrics
    if eval_x is not None:
        print("\nPer-class evaluation:")
        eval_logits = model(eval_x)
        eval_preds = mx.argmax(eval_logits, axis=1)

        for i, cls in enumerate(CLASSES):
            tp = ((eval_preds == i) & (eval_y == i)).sum().item()
            fp = ((eval_preds == i) & (eval_y != i)).sum().item()
            fn = ((eval_preds != i) & (eval_y == i)).sum().item()
            prec = tp / (tp + fp) if (tp + fp) > 0 else 0
            rec = tp / (tp + fn) if (tp + fn) > 0 else 0
            f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0
            if tp + fn > 0:
                print(f"  {cls:25s} P={prec:.2f} R={rec:.2f} F1={f1:.2f}")

    # Save model weights
    os.makedirs(args.output_dir, exist_ok=True)
    weights_path = os.path.join(args.output_dir, 'nanomind-sft-classifier.npz')
    flat_params = {}
    for name, param in model.parameters().items():
        if hasattr(param, 'shape'):
            flat_params[name] = np.array(param)
    np.savez(weights_path, **flat_params)
    print(f"\nModel saved to {weights_path}")

    # Save tokenizer
    tokenizer_path = os.path.join(args.output_dir, 'tokenizer.json')
    with open(tokenizer_path, 'w') as f:
        json.dump(tokenizer.word2idx, f)
    print(f"Tokenizer saved to {tokenizer_path}")


def main():
    parser = argparse.ArgumentParser(description='NanoMind SFT Training (MLX)')
    parser.add_argument('--corpus-dir', default='corpus/sft', help='Path to SFT corpus')
    parser.add_argument('--output-dir', default='models', help='Output directory for trained model')
    parser.add_argument('--epochs', type=int, default=100, help='Training epochs')
    parser.add_argument('--lr', type=float, default=0.001, help='Learning rate')
    parser.add_argument('--embed-dim', type=int, default=64, help='Embedding dimension')
    parser.add_argument('--hidden-dim', type=int, default=128, help='Hidden layer dimension')
    parser.add_argument('--vocab-size', type=int, default=8000, help='Max vocabulary size')
    args = parser.parse_args()

    train(args)


if __name__ == '__main__':
    main()
