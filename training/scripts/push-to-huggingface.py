#!/usr/bin/env python3
"""
Push trained NanoMind model to HuggingFace.

Usage:
    HUGGIN_KEY=hf_xxx python scripts/push-to-huggingface.py

Or if HUGGIN_KEY is in your shell profile, just:
    python scripts/push-to-huggingface.py
"""

import os
import json
from pathlib import Path

try:
    from huggingface_hub import HfApi
except ImportError:
    print("Install: pip install huggingface_hub")
    exit(1)

token = os.environ.get('HUGGIN_KEY', '')
if not token:
    print("HUGGIN_KEY not set. Run: source ~/.zshrc")
    print("Or: HUGGIN_KEY=hf_xxx python scripts/push-to-huggingface.py")
    exit(1)

api = HfApi(token=token)
user = api.whoami()
print(f"Authenticated as: {user['name']}")

repo_id = f"{user['name']}/nanomind-v0.1-security-classifier"

# Create private model repo
api.create_repo(repo_id, repo_type="model", private=True, exist_ok=True)

# Upload model + tokenizer
models_dir = Path("models")
for f in models_dir.glob("*"):
    if f.is_file():
        print(f"Uploading {f.name}...")
        api.upload_file(
            path_or_fileobj=str(f),
            path_in_repo=f.name,
            repo_id=repo_id,
            repo_type="model",
        )

# Upload model card
card = """---
license: apache-2.0
tags:
  - security
  - ai-agents
  - nanomind
  - opena2a
---

# NanoMind v0.1 Security Classifier

MLP classifier trained on 1,028 AI agent package descriptions.
Bootstrapping model for the full NanoMind v3 Ternary Mamba Encoder.

## Metrics
- Eval accuracy: 99.51%
- Benign F1: 1.00 (zero false positives)
- Injection F1: 0.91

## Training
- 822 train / 206 eval samples
- Trained on Apple Silicon M4 Max (MLX)
- Training time: 0.7 seconds

## Architecture
- MLP classifier (stepping stone to Mamba TME)
- Word-level tokenizer (8K vocab)
- 9-class output: exfiltration, injection, privilege_escalation,
  persistence, credential_abuse, lateral_movement, social_engineering,
  policy_violation, benign

## Usage
Part of the [HackMyAgent](https://github.com/opena2a-org/hackmyagent) security scanner.
"""

api.upload_file(
    path_or_fileobj=card.encode(),
    path_in_repo="README.md",
    repo_id=repo_id,
    repo_type="model",
)

print(f"\nModel published: https://huggingface.co/{repo_id}")
