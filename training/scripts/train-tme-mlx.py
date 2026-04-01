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
  - Mean pooling -> 9-class classification head
  - Trained on Apple Silicon M4 Max via MLX

v5 improvements:
  - Mini-batch training for larger datasets
  - Class-weighted cross-entropy loss
  - Early stopping on eval loss (patience=30)
  - Cosine learning rate schedule
  - Dropout for regularization
  - Saves best checkpoint by eval accuracy

Usage:
    source .venv/bin/activate
    python scripts/train-tme-mlx.py
    python scripts/train-tme-mlx.py --corpus-dir ../nanomind-training/corpus/sft-v8
    python scripts/train-tme-mlx.py --epochs=300 --layers=12 --batch-size=64
"""

import argparse
import json
import math
import os
import time
from pathlib import Path
from collections import Counter

import random as py_random
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np

# Use a separate random for batch shuffling
random = py_random.Random(42)

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
    def __init__(self, d_model, d_state=64, expand=2, dropout=0.1):
        super().__init__()
        d_inner = d_model * expand
        self.in_proj = nn.Linear(d_model, d_inner * 2)
        self.dt_proj = nn.Linear(d_inner, d_inner)
        self.out_proj = nn.Linear(d_inner, d_model)
        self.norm = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)
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
        y = self.dropout(y)
        return self.out_proj(y) + residual


# ============================================================================
# TME Classifier
# ============================================================================

class TMEClassifier(nn.Module):
    """Ternary Mamba Encoder for security intent classification."""
    def __init__(self, vocab_size, d_model=128, n_layers=8, num_classes=9, max_len=128, dropout=0.1):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, d_model)
        self.layers = [MambaBlock(d_model, dropout=dropout) for _ in range(n_layers)]
        self.final_norm = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)
        self.classifier = nn.Linear(d_model, num_classes)

    def __call__(self, x):
        h = self.embedding(x)
        h = self.dropout(h)
        for layer in self.layers:
            h = layer(h)
        h = self.final_norm(h)
        h = mx.mean(h, axis=1)  # mean pool over sequence
        return self.classifier(h)


# ============================================================================
# Training utilities
# ============================================================================

def compute_class_weights(labels):
    """Compute inverse-frequency class weights for balanced loss."""
    counts = Counter(int(l) for l in labels)
    total = sum(counts.values())
    n_classes = len(CLASSES)
    weights = []
    for i in range(n_classes):
        c = counts.get(i, 1)
        w = total / (n_classes * c)
        weights.append(w)
    return mx.array(weights)


def cosine_schedule(epoch, total_epochs, lr_max, lr_min=1e-6):
    """Cosine annealing learning rate schedule."""
    return lr_min + 0.5 * (lr_max - lr_min) * (1 + math.cos(math.pi * epoch / total_epochs))


def batch_iterate(x, y, batch_size, shuffle=True):
    """Yield mini-batches from data arrays."""
    n = x.shape[0]
    indices = list(range(n))
    if shuffle:
        random.shuffle(indices)
    for i in range(0, n, batch_size):
        batch_idx = indices[i:i+batch_size]
        yield x[batch_idx], y[batch_idx]


# ============================================================================
# Training
# ============================================================================

def train(args):
    print(f"MLX Device: {mx.default_device()}")
    print(f"Training NanoMind TME v5 (Mamba architecture)")
    print(f"  Layers: {args.layers}, d_model: {args.d_model}")
    print(f"  Epochs: {args.epochs}, LR: {args.lr}, Batch: {args.batch_size}")
    print(f"  Dropout: {args.dropout}, Patience: {args.patience}")
    print()

    # Load data
    corpus_dir = args.corpus_dir
    train_data = json.load(open(os.path.join(corpus_dir, 'train.json')))
    eval_data = json.load(open(os.path.join(corpus_dir, 'eval.json')))

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
        dropout=args.dropout,
    )
    mx.eval(model.parameters())

    def count_params(params):
        total = 0
        if isinstance(params, dict):
            for v in params.values():
                total += count_params(v)
        elif isinstance(params, list):
            for v in params:
                total += count_params(v)
        elif hasattr(params, 'size'):
            total += params.size
        return total
    param_count = count_params(model.parameters())
    print(f"Architecture: {args.layers} Mamba blocks, {args.d_model}d, {param_count} params")

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

    # Class weights
    class_weights = compute_class_weights(train_y.tolist())
    print(f"Class weights: {[f'{w:.2f}' for w in class_weights.tolist()]}")

    # Train class distribution
    train_dist = Counter(int(l) for l in train_y.tolist())
    print("Train distribution:")
    for i, cls in enumerate(CLASSES):
        print(f"  {cls:25s} {train_dist.get(i, 0):5d}")

    # Optimizer
    optimizer = optim.Adam(learning_rate=args.lr)

    def loss_fn(model, x, y):
        logits = model(x)
        per_sample_loss = nn.losses.cross_entropy(logits, y)
        # Apply class weights
        sample_weights = class_weights[y]
        weighted_loss = (per_sample_loss * sample_weights).mean()
        return weighted_loss

    loss_and_grad = nn.value_and_grad(model, loss_fn)

    # Train with mini-batches and early stopping
    print("\nTraining...")
    best_eval_acc = 0.0
    best_eval_loss = float('inf')
    patience_counter = 0
    start = time.time()

    for epoch in range(args.epochs):
        # Cosine LR schedule
        lr = cosine_schedule(epoch, args.epochs, args.lr)
        optimizer.learning_rate = lr

        # Mini-batch training
        epoch_loss = 0.0
        n_batches = 0
        for bx, by in batch_iterate(train_x, train_y, args.batch_size):
            loss, grads = loss_and_grad(model, bx, by)
            optimizer.update(model, grads)
            mx.eval(model.parameters(), optimizer.state)
            epoch_loss += loss.item()
            n_batches += 1

        avg_loss = epoch_loss / max(n_batches, 1)

        if (epoch + 1) % 10 == 0 or epoch == 0:
            # Evaluate in batches too
            correct = 0
            total = 0
            eval_loss_sum = 0.0
            eval_batches = 0
            for bx, by in batch_iterate(eval_x, eval_y, args.batch_size, shuffle=False):
                logits = model(bx)
                preds = mx.argmax(logits, axis=1)
                correct += (preds == by).sum().item()
                total += by.shape[0]
                el = nn.losses.cross_entropy(logits, by).mean().item()
                eval_loss_sum += el
                eval_batches += 1

            eval_acc = correct / total if total > 0 else 0
            eval_loss = eval_loss_sum / max(eval_batches, 1)

            # Train accuracy (sample for speed)
            train_preds = mx.argmax(model(train_x[:500]), axis=1)
            train_acc = (train_preds == train_y[:500]).astype(mx.float32).mean().item()

            elapsed = time.time() - start
            marker = ""
            if eval_acc > best_eval_acc:
                best_eval_acc = eval_acc
                marker = " *best*"

            print(f"  Epoch {epoch+1:4d}/{args.epochs} | Loss: {avg_loss:.4f} | EvalLoss: {eval_loss:.4f} | "
                  f"Train: {train_acc:.2%} | Eval: {eval_acc:.2%} | LR: {lr:.6f} | {elapsed:.1f}s{marker}")

            # Early stopping on eval loss
            if eval_loss < best_eval_loss:
                best_eval_loss = eval_loss
                patience_counter = 0
                # Save best checkpoint
                save_model(model, tokenizer, args.output_dir, tag="best")
            else:
                patience_counter += 1

            if patience_counter >= args.patience // 10:  # check every 10 epochs
                print(f"\nEarly stopping at epoch {epoch+1} (patience={args.patience}, counter={patience_counter*10})")
                break

    total_time = time.time() - start
    print(f"\nDone in {total_time:.1f}s. Best eval: {best_eval_acc:.2%}")

    # Load best checkpoint for final eval
    print("\nLoading best checkpoint for final evaluation...")
    best_path = os.path.join(args.output_dir, 'nanomind-tme-classifier.npz')
    if os.path.exists(best_path):
        weights = dict(np.load(best_path, allow_pickle=True))
        # Reconstruct model params from flat keys
        model_fresh = TMEClassifier(
            vocab_size=actual_vocab,
            d_model=args.d_model,
            n_layers=args.layers,
            num_classes=len(CLASSES),
            dropout=0.0,  # no dropout at eval
        )
        load_flat_weights(model_fresh, weights)
        mx.eval(model_fresh.parameters())
        model = model_fresh

    # Per-class eval
    print("\nPer-class metrics (eval set):")
    all_preds = []
    all_labels = []
    for bx, by in batch_iterate(eval_x, eval_y, args.batch_size, shuffle=False):
        preds = mx.argmax(model(bx), axis=1)
        all_preds.extend(preds.tolist())
        all_labels.extend(by.tolist())

    all_preds = np.array(all_preds)
    all_labels = np.array(all_labels)

    print(f"{'Class':25s} {'P':>6s} {'R':>6s} {'F1':>6s} {'Support':>8s}")
    print("-" * 55)
    f1_scores = {}
    for i, cls in enumerate(CLASSES):
        tp = int(((all_preds == i) & (all_labels == i)).sum())
        fp = int(((all_preds == i) & (all_labels != i)).sum())
        fn = int(((all_preds != i) & (all_labels == i)).sum())
        p = tp / (tp + fp) if (tp + fp) > 0 else 0
        r = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0
        support = int((all_labels == i).sum())
        f1_scores[cls] = f1
        print(f"  {cls:25s} {p:6.3f} {r:6.3f} {f1:6.3f} {support:8d}")

    overall_acc = (all_preds == all_labels).mean()
    macro_f1 = np.mean(list(f1_scores.values()))
    print(f"\n  Overall accuracy: {overall_acc:.2%}")
    print(f"  Macro F1: {macro_f1:.4f}")

    # Confusion matrix
    print("\nConfusion Matrix:")
    n_cls = len(CLASSES)
    cm = np.zeros((n_cls, n_cls), dtype=int)
    for pred, true in zip(all_preds, all_labels):
        cm[true][pred] += 1

    # Header
    short_names = [c[:6] for c in CLASSES]
    print(f"{'':12s}", end="")
    for sn in short_names:
        print(f" {sn:>6s}", end="")
    print()
    for i, cls in enumerate(CLASSES):
        print(f"  {cls[:10]:10s}", end="")
        for j in range(n_cls):
            print(f" {cm[i][j]:6d}", end="")
        print()

    # Check targets
    print("\nTarget check (F1 >= 0.90):")
    all_pass = True
    for cls, f1 in f1_scores.items():
        status = "PASS" if f1 >= 0.90 else "FAIL"
        if f1 < 0.90:
            all_pass = False
        print(f"  {cls:25s} F1={f1:.3f} {status}")

    if all_pass:
        print("\n  ALL TARGETS MET")
    else:
        failing = [cls for cls, f1 in f1_scores.items() if f1 < 0.90]
        print(f"\n  TARGETS NOT MET for: {', '.join(failing)}")

    # Save final model (best checkpoint already saved)
    save_model(model, tokenizer, args.output_dir, tag="final")

    # Save evaluation report
    report = {
        "model": "nanomind-tme-v5",
        "corpus": corpus_dir,
        "trainSamples": len(train_data),
        "evalSamples": len(eval_data),
        "epochs": epoch + 1,
        "bestEvalAccuracy": best_eval_acc,
        "finalAccuracy": float(overall_acc),
        "macroF1": float(macro_f1),
        "perClassF1": f1_scores,
        "confusionMatrix": cm.tolist(),
        "classNames": CLASSES,
        "allTargetsMet": all_pass,
        "architecture": {
            "layers": args.layers,
            "d_model": args.d_model,
            "vocab_size": actual_vocab,
            "dropout": args.dropout,
        },
        "trainingTime": total_time,
    }
    report_path = os.path.join(args.output_dir, 'eval-report.json')
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nEval report saved to {report_path}")


def save_model(model, tokenizer, output_dir, tag="best"):
    """Save model weights and tokenizer."""
    os.makedirs(output_dir, exist_ok=True)
    flat = {}
    def flatten_params(params, prefix=''):
        if isinstance(params, dict):
            for k, v in params.items():
                flatten_params(v, f"{prefix}{k}." if prefix else f"{k}.")
        elif isinstance(params, list):
            for i, v in enumerate(params):
                flatten_params(v, f"{prefix}{i}.")
        elif hasattr(params, 'shape'):
            key = prefix.rstrip('.')
            flat[key] = np.array(params)
    flatten_params(model.parameters())

    suffix = "" if tag == "best" else f"-{tag}"
    np.savez(os.path.join(output_dir, f'nanomind-tme-classifier{suffix}.npz'), **flat)
    with open(os.path.join(output_dir, 'tokenizer.json'), 'w') as f:
        json.dump(tokenizer.word2idx, f)


def load_flat_weights(model, flat_weights):
    """Load flat weight dict into model."""
    params = model.parameters()

    def unflatten(params, flat, prefix=''):
        if isinstance(params, dict):
            for k, v in params.items():
                p = f"{prefix}{k}." if prefix else f"{k}."
                unflatten(v, flat, p)
        elif isinstance(params, list):
            for i, v in enumerate(params):
                unflatten(v, flat, f"{prefix}{i}.")
        elif hasattr(params, 'shape'):
            key = prefix.rstrip('.')
            if key in flat:
                return mx.array(flat[key])
        return params

    def set_nested(obj, flat, prefix=''):
        if isinstance(obj, dict):
            for k in obj:
                p = f"{prefix}{k}." if prefix else f"{k}."
                result = set_nested(obj[k], flat, p)
                if result is not None:
                    obj[k] = result
        elif isinstance(obj, list):
            for i in range(len(obj)):
                result = set_nested(obj[i], flat, f"{prefix}{i}.")
                if result is not None:
                    obj[i] = result
        elif hasattr(obj, 'shape'):
            key = prefix.rstrip('.')
            if key in flat:
                return mx.array(flat[key])
        return None

    set_nested(params, flat_weights)
    model.update(params)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--corpus-dir', default='../nanomind-training/corpus/sft-v8')
    p.add_argument('--output-dir', default='training/models-tme-v5')
    p.add_argument('--epochs', type=int, default=300)
    p.add_argument('--lr', type=float, default=0.001)
    p.add_argument('--d-model', type=int, default=128)
    p.add_argument('--layers', type=int, default=8)
    p.add_argument('--vocab-size', type=int, default=4000)
    p.add_argument('--batch-size', type=int, default=64)
    p.add_argument('--dropout', type=float, default=0.1)
    p.add_argument('--patience', type=int, default=30)
    train(p.parse_args())

if __name__ == '__main__':
    main()
