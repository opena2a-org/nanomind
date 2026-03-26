#!/usr/bin/env python3
"""
NanoMind v3 TME Evaluation Harness

Evaluates the trained model against the OASB benchmark holdout set.
Reports: accuracy, F1 (macro), precision, recall, confusion matrix per attack class.

Usage:
    python eval_benchmark.py --model=models/nanomind-v3-tme.gguf --dataset=corpus/oasb-holdout.json
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ATTACK_CLASSES = [
    'exfiltration',
    'injection',
    'privilege_escalation',
    'persistence',
    'credential_abuse',
    'lateral_movement',
    'social_engineering',
    'policy_violation',
    'benign',
]

def load_dataset(path: str) -> list:
    with open(path) as f:
        return json.load(f)

def evaluate(predictions: list, ground_truth: list) -> dict:
    """Compute metrics from predictions vs ground truth."""
    assert len(predictions) == len(ground_truth), "Length mismatch"

    # Per-class metrics
    class_metrics = {}
    for cls in ATTACK_CLASSES:
        tp = sum(1 for p, g in zip(predictions, ground_truth) if p == cls and g == cls)
        fp = sum(1 for p, g in zip(predictions, ground_truth) if p == cls and g != cls)
        fn = sum(1 for p, g in zip(predictions, ground_truth) if p != cls and g == cls)
        tn = sum(1 for p, g in zip(predictions, ground_truth) if p != cls and g != cls)

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

        class_metrics[cls] = {
            'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn,
            'precision': round(precision, 4),
            'recall': round(recall, 4),
            'f1': round(f1, 4),
        }

    # Macro averages (exclude benign for attack detection metrics)
    attack_classes = [c for c in ATTACK_CLASSES if c != 'benign']
    attack_metrics = [class_metrics[c] for c in attack_classes if class_metrics[c]['tp'] + class_metrics[c]['fn'] > 0]

    macro_precision = sum(m['precision'] for m in attack_metrics) / len(attack_metrics) if attack_metrics else 0
    macro_recall = sum(m['recall'] for m in attack_metrics) / len(attack_metrics) if attack_metrics else 0
    macro_f1 = sum(m['f1'] for m in attack_metrics) / len(attack_metrics) if attack_metrics else 0

    accuracy = sum(1 for p, g in zip(predictions, ground_truth) if p == g) / len(predictions)

    return {
        'accuracy': round(accuracy, 4),
        'macro_precision': round(macro_precision, 4),
        'macro_recall': round(macro_recall, 4),
        'macro_f1': round(macro_f1, 4),
        'per_class': class_metrics,
        'total_samples': len(predictions),
        'pass': macro_f1 >= 0.85,  # Target threshold
    }


def main():
    parser = argparse.ArgumentParser(description='NanoMind v3 TME Evaluation')
    parser.add_argument('--model', required=True, help='Path to GGUF model file')
    parser.add_argument('--dataset', required=True, help='Path to holdout dataset JSON')
    parser.add_argument('--output', default='evaluation/results.json', help='Output results path')
    args = parser.parse_args()

    if not Path(args.model).exists():
        print(f"Model not found: {args.model}")
        print("Note: Model training has not been completed yet.")
        print("This script will be used after Stage 2 (SFT) training completes.")
        sys.exit(0)

    dataset = load_dataset(args.dataset)
    print(f"Loaded {len(dataset)} samples from {args.dataset}")

    # TODO: Load model and run inference
    # For now, output the evaluation framework structure
    print("\nEvaluation framework ready.")
    print("Waiting for model training to complete (Stage 2 SFT).")
    print(f"Target: macro F1 >= 0.85 on holdout set")


if __name__ == '__main__':
    main()
