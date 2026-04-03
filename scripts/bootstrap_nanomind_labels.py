#!/usr/bin/env python3
"""Bootstrap NanoMind relevance classification training labels.

Collects historical intelligence data from configured sources to build
the initial training dataset for the NanoMind relevance classification head.

Usage:
    python scripts/bootstrap_nanomind_labels.py \
        --registry-url https://api.oa2a.org \
        --output-dir ../nanomind-training/corpus/aria-relevance-v1 \
        --limit 1000

This script:
1. Fetches classified intel items from the Registry API
2. Extracts text features (title, description, tags)
3. Creates labeled pairs: (text -> relevant/irrelevant)
4. Splits into train/eval sets (80/20)
5. Outputs in NanoMind corpus format (train.json, eval.json)

The labels come from confirmed ARIA classifications:
- source='aria_confirmed': items verified by ARIA research (confidence=1.0)
- Items classified as 'relevant' or 'queued': positive labels
- Items classified as 'irrelevant': negative labels
"""

import argparse
import json
import os
import random
import sys
from datetime import datetime
from urllib.request import urlopen, Request
from urllib.error import URLError


def fetch_intel_items(registry_url: str, status: str, limit: int, api_key: str = None) -> list:
    """Fetch intel items from the Registry API with a given status."""
    url = f"{registry_url}/api/v1/intel/items?status={status}&limit={limit}"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key

    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            return data.get("items", [])
    except URLError as e:
        print(f"Warning: Failed to fetch {status} items: {e}", file=sys.stderr)
        return []


def item_to_training_example(item: dict, label: str) -> dict:
    """Convert an intel item to a NanoMind training example."""
    # Build text from available fields
    parts = [item.get("title", "")]
    if item.get("description"):
        parts.append(item["description"])
    if item.get("tags"):
        parts.extend(item["tags"])
    if item.get("affectedProducts"):
        parts.extend(item["affectedProducts"])

    text = " ".join(p for p in parts if p)

    return {
        "input": text,
        "label": label,
        "source": "aria_confirmed" if item.get("status") in ("queued", "relevant") else "aria_classified",
        "confidence": 1.0 if item.get("status") in ("queued", "relevant") else 0.8,
        "metadata": {
            "itemId": item.get("id"),
            "cveId": item.get("cveId"),
            "cvssScore": item.get("cvssScore"),
            "sourceType": item.get("sourceType"),
            "originalStatus": item.get("status"),
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Bootstrap NanoMind relevance classification labels")
    parser.add_argument("--registry-url", default="https://api.oa2a.org",
                        help="Registry API base URL")
    parser.add_argument("--api-key", default=os.environ.get("INTERNAL_API_KEY"),
                        help="Registry internal API key (default: $INTERNAL_API_KEY)")
    parser.add_argument("--output-dir", default="../nanomind-training/corpus/aria-relevance-v1",
                        help="Output directory for training corpus")
    parser.add_argument("--limit", type=int, default=1000,
                        help="Maximum items to fetch per status")
    parser.add_argument("--train-ratio", type=float, default=0.8,
                        help="Train/eval split ratio")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducibility")
    args = parser.parse_args()

    random.seed(args.seed)

    print(f"Fetching intel items from {args.registry_url}...")

    # Fetch positive examples (relevant items)
    relevant_items = fetch_intel_items(args.registry_url, "relevant", args.limit, args.api_key)
    queued_items = fetch_intel_items(args.registry_url, "queued", args.limit, args.api_key)
    positive_items = relevant_items + queued_items

    # Fetch negative examples (irrelevant items)
    negative_items = fetch_intel_items(args.registry_url, "irrelevant", args.limit, args.api_key)

    print(f"  Positive examples: {len(positive_items)} (relevant: {len(relevant_items)}, queued: {len(queued_items)})")
    print(f"  Negative examples: {len(negative_items)}")

    if len(positive_items) == 0 and len(negative_items) == 0:
        print("No items found. The classification pipeline may not have processed any items yet.")
        print("Run the intel ingestion scheduler first, then the classifier.")
        sys.exit(1)

    # Convert to training examples
    examples = []
    for item in positive_items:
        examples.append(item_to_training_example(item, "relevant"))
    for item in negative_items:
        examples.append(item_to_training_example(item, "irrelevant"))

    # Filter out empty inputs
    examples = [e for e in examples if len(e["input"].strip()) > 10]

    # Shuffle and split
    random.shuffle(examples)
    split_idx = int(len(examples) * args.train_ratio)
    train_data = examples[:split_idx]
    eval_data = examples[split_idx:]

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    # Write train and eval sets
    train_path = os.path.join(args.output_dir, "train.json")
    eval_path = os.path.join(args.output_dir, "eval.json")
    meta_path = os.path.join(args.output_dir, "metadata.json")

    with open(train_path, "w") as f:
        json.dump(train_data, f, indent=2)
    with open(eval_path, "w") as f:
        json.dump(eval_data, f, indent=2)

    metadata = {
        "created": datetime.utcnow().isoformat(),
        "registryUrl": args.registry_url,
        "totalExamples": len(examples),
        "trainExamples": len(train_data),
        "evalExamples": len(eval_data),
        "positiveCount": len(positive_items),
        "negativeCount": len(negative_items),
        "labels": ["relevant", "irrelevant"],
        "source": "aria_classification_pipeline",
        "trainRatio": args.train_ratio,
        "seed": args.seed,
    }
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nCorpus written to {args.output_dir}/")
    print(f"  Train: {len(train_data)} examples")
    print(f"  Eval:  {len(eval_data)} examples")
    print(f"  Metadata: {meta_path}")

    # Summary by source
    source_counts = {}
    for e in examples:
        s = e.get("source", "unknown")
        source_counts[s] = source_counts.get(s, 0) + 1
    print(f"\nBy source: {json.dumps(source_counts)}")


if __name__ == "__main__":
    main()
