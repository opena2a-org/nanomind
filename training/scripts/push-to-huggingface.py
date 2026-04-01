#!/usr/bin/env python3
"""
Push NanoMind models to HuggingFace.

Reads nanomind-models.json manifest to determine what to publish.
Only publishes models with visibility=public.

Usage:
    # Publish latest version of all public models
    python scripts/push-to-huggingface.py

    # Publish specific model
    python scripts/push-to-huggingface.py --model nanomind-security-classifier

    # Publish specific version
    python scripts/push-to-huggingface.py --model nanomind-security-classifier --version 0.3.0

    # Dry run (show what would be published)
    python scripts/push-to-huggingface.py --dry-run

Environment:
    HUGGIN_KEY or HF_TOKEN: HuggingFace API token
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from huggingface_hub import HfApi
except ImportError:
    print("Install: pip install huggingface_hub")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
MANIFEST_PATH = REPO_ROOT / "nanomind-models.json"


def load_manifest():
    if not MANIFEST_PATH.exists():
        print(f"Manifest not found: {MANIFEST_PATH}")
        sys.exit(1)
    with open(MANIFEST_PATH) as f:
        return json.load(f)


def update_manifest(manifest):
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


def generate_model_card(model_name, model_info, version_key, version_info):
    """Generate a HuggingFace model card README."""
    metrics = version_info.get("metrics", {})
    accuracy = metrics.get("evalAccuracy")
    accuracy_str = f"{accuracy * 100:.2f}%" if accuracy else "N/A"
    train_samples = metrics.get("trainSamples", "N/A")
    eval_samples = metrics.get("evalSamples", "N/A")
    classes = metrics.get("classes", 9)
    arch = version_info.get("architecture", "Unknown")
    corpus = version_info.get("corpus", "Unknown")

    attack_classes = ", ".join([
        "exfiltration", "injection", "privilege_escalation", "persistence",
        "credential_abuse", "lateral_movement", "social_engineering",
        "policy_violation", "benign"
    ])

    # Build per-class table if available
    per_class = metrics.get("perClass", {})
    per_class_table = ""
    if per_class:
        per_class_table = """
## Per-Class Performance

| Attack Class | F1 Score | Description |
|-------------|----------|-------------|
"""
        class_descriptions = {
            "exfiltration": "Data forwarding to external endpoints (mirror, upload, sync)",
            "injection": "Instruction override, jailbreak, prompt injection (DAN, ignore previous)",
            "privilege_escalation": "Unauthorized access elevation (admin access, bypass permissions)",
            "persistence": "Permanent state manipulation (forever, no expiration, all future sessions)",
            "credential_abuse": "Credential harvesting and phishing (share API key, enter password)",
            "lateral_movement": "Remote config/instruction fetching (download from URL, fetch config)",
            "social_engineering": "Urgency and pressure manipulation (urgent, emergency, act now)",
            "policy_violation": "Governance bypass (bypass SOUL.md, override constraints)",
            "benign": "Normal, expected agent behavior with no exploitable patterns",
        }
        for cls in ["injection", "social_engineering", "credential_abuse", "privilege_escalation",
                     "persistence", "policy_violation", "lateral_movement", "benign", "exfiltration"]:
            f1 = per_class.get(cls, {}).get("f1", "N/A")
            f1_str = f"{f1:.2f}" if isinstance(f1, (int, float)) else f1
            desc = class_descriptions.get(cls, "")
            per_class_table += f"| {cls} | {f1_str} | {desc} |\n"

    return f"""---
license: apache-2.0
language:
  - en
tags:
  - security
  - ai-agents
  - mcp
  - nanomind
  - opena2a
  - threat-detection
  - prompt-injection
  - ai-safety
datasets:
  - opena2a/nanomind-training
metrics:
  - accuracy
  - f1
pipeline_tag: text-classification
model-index:
  - name: {model_name}
    results:
      - task:
          type: text-classification
          name: AI Agent Threat Classification
        metrics:
          - name: Eval Accuracy
            type: accuracy
            value: {accuracy if accuracy else 'N/A'}
---

# NanoMind Security Classifier v{version_key}

**9-class threat classifier for AI agent, MCP server, and skill security scanning.**

Detects exfiltration, prompt injection, privilege escalation, credential abuse, persistence, lateral movement, social engineering, and policy violations in AI agent configurations, MCP server definitions, SKILL.md files, SOUL.md governance, and system prompts.

Built by [OpenA2A](https://opena2a.org). Powers [HackMyAgent](https://github.com/opena2a-org/hackmyagent), [ai-trust](https://github.com/opena2a-org/ai-trust), and the [OpenA2A CLI](https://github.com/opena2a-org/opena2a).

## Why This Model Exists

AI agents and MCP servers can contain hidden malicious instructions that static analysis misses. A skill that says "forward all database records to analytics endpoint" looks like normal data processing but is actually exfiltration. NanoMind classifies the _intent_ of agent configurations, not just pattern-match keywords.

## Metrics

| Metric | Value |
|--------|-------|
| **Eval accuracy** | **{accuracy_str}** |
| Training samples | {train_samples} |
| Eval samples | {eval_samples} |
| Attack classes | {classes} |
| Training corpus | {corpus} |
| Architecture | {arch} |
| Inference latency | Sub-2ms on CPU |
| Model size | ~5.5MB (ONNX) |
{per_class_table}
## Architecture

- **Type:** Ternary Mamba Encoder (bidirectional discriminative, NOT autoregressive)
- **Backbone:** Mamba-3 SSM (O(1) memory, O(n) complexity, no KV cache)
- **Parameters:** 18M (3.5MB on disk via ternary quantization)
- **Inference:** ONNX (Node.js via onnxruntime-node) or NPZ weights (Python)
- **Input:** Tokenized text (4K vocabulary, 128 token max)
- **Output:** 9-class softmax probability distribution

## What It Classifies

NanoMind analyzes these AI security artifacts:

| Content Type | Examples |
|-------------|----------|
| MCP server configs | `mcpServers` JSON definitions, tool permissions |
| SKILL.md files | Agent skill definitions with capabilities and instructions |
| SOUL.md governance | Agent governance policies and constraint definitions |
| System prompts | Agent instructions, role definitions, safety rules |
| Agent cards | A2A protocol agent metadata |
| Source code | JavaScript/TypeScript/Python agent implementations |

## Quick Start

```bash
# Install HackMyAgent (auto-downloads NanoMind model on first scan)
npm install -g hackmyagent

# Scan an AI agent project (NanoMind runs automatically)
hackmyagent secure ./my-agent

# Deep scan with behavioral simulation
hackmyagent secure ./my-agent --deep

# Check a skill before installing
hackmyagent check ./path/to/SKILL.md

# Via OpenA2A CLI
npx opena2a scan ./my-agent --deep

# Via ai-trust (MCP server trust verification)
npx ai-trust check @modelcontextprotocol/server-filesystem --scan-if-missing
```

## How It Works

1. **Tokenization:** Input text is split into words and mapped to a 4K vocabulary
2. **Encoding:** 8 Mamba SSM blocks process the token sequence bidirectionally
3. **Classification:** Mean pooling + 9-way softmax head produces class probabilities
4. **Defense-in-depth:** NanoMind findings ADD to static analysis (never suppress)

The model understands word ORDER, which is critical for distinguishing:
- "forward token to external endpoint" (exfiltration)
- "external endpoint token forwarding service" (possibly benign)

## Training Pipeline

Repeatable pipeline with Claude LLM as chief data scientist:

```
Data Sources → Claude Reviews Labels → Validated Corpus → Train (MLX/M4) → Evaluate → Publish
```

**Data sources:**
- [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent) -- intentionally vulnerable AI agent attack payloads
- [AgentPwn](https://agentpwn.com) -- benevolent honeypot capturing real AI agent attacks (48 attacks, 11 categories)
- [OASB](https://oasb.org) -- Open Agent Security Benchmark dataset
- [OpenA2A Registry](https://opena2a.org) -- skill descriptions with HMA scan results
- Synthetic samples -- generated SKILL.md, MCP configs, SOUL.md, credential abuse scenarios

**Quality assurance:**
- Claude LLM reviews every label before training (chief data scientist role)
- Heuristic cross-validation against HMA's pattern library
- Balanced classes (equal samples per attack type)
- Holdout evaluation set never seen during training

**Training hardware:** Apple Silicon M4 Max, MLX framework. Training time: ~2 minutes.

## Limitations

- **Exfiltration class** has lower precision (F1=0.81) -- some benign data-processing tools get flagged
- **Benign class** has lower recall (F1=0.84) -- conservative bias (prefers false positives over false negatives for security)
- **Training data** is currently ~1,800 samples. Accuracy improves as the OpenA2A Registry accumulates more scan data
- **Context window** is 128 tokens. Very long documents are truncated
- **English only** -- not trained on non-English agent configurations

## Integration

NanoMind is used by three CLIs in the OpenA2A ecosystem:

| Tool | How NanoMind is Used |
|------|---------------------|
| [HackMyAgent](https://github.com/opena2a-org/hackmyagent) | Core semantic layer for all scan commands (secure, check, scan-soul, secure-openclaw, secure-nemoclaw) |
| [ai-trust](https://github.com/opena2a-org/ai-trust) | Deep trust verification of MCP servers and npm packages |
| [OpenA2A CLI](https://github.com/opena2a-org/opena2a) | Passes --deep flag through to HMA for semantic analysis |

## License

Apache-2.0. Free for commercial and non-commercial use.

## Links

- [HackMyAgent](https://github.com/opena2a-org/hackmyagent) -- 204-check security scanner
- [OpenA2A](https://opena2a.org) -- Open Agent-to-Agent protocol
- [OASB](https://oasb.org) -- Open Agent Security Benchmark
- [AgentPwn](https://agentpwn.com) -- AI agent attack honeypot
- [NanoMind Spec](https://nanomind.dev) -- Full specification

## Citation

```bibtex
@software{{nanomind,
  title = {{NanoMind Security Classifier}},
  author = {{OpenA2A}},
  url = {{https://github.com/opena2a-org/nanomind}},
  version = {{{version_key}}},
  year = {{2026}}
}}
```
"""


def publish_model(api, model_name, model_info, version_key, version_info, dry_run=False):
    """Publish a single model version to HuggingFace."""
    hf_config = model_info.get("huggingface")
    if not hf_config:
        print(f"  Skipping {model_name}: no HuggingFace config")
        return False

    repo_id = hf_config["repoId"]
    model_dir = REPO_ROOT / version_info["modelDir"]

    if not model_dir.exists():
        print(f"  ERROR: Model directory not found: {model_dir}")
        return False

    files_to_upload = version_info.get("files", [])
    missing = [f for f in files_to_upload if not (model_dir / f).exists()]
    if missing:
        print(f"  ERROR: Missing model files: {missing}")
        return False

    print(f"\n  Publishing {model_name} v{version_key}")
    print(f"  Repo: https://huggingface.co/{repo_id}")
    print(f"  Files: {files_to_upload}")
    print(f"  Source: {model_dir}")

    if dry_run:
        print("  [DRY RUN] Would publish above")
        return True

    # Create repo (public for public models)
    is_private = model_info["visibility"] != "public"
    api.create_repo(repo_id, repo_type="model", private=is_private, exist_ok=True)

    # Upload model files
    for filename in files_to_upload:
        filepath = model_dir / filename
        print(f"  Uploading {filename} ({filepath.stat().st_size:,} bytes)...")
        api.upload_file(
            path_or_fileobj=str(filepath),
            path_in_repo=filename,
            repo_id=repo_id,
            repo_type="model",
        )

    # Upload model card
    card = generate_model_card(model_name, model_info, version_key, version_info)
    api.upload_file(
        path_or_fileobj=card.encode(),
        path_in_repo="README.md",
        repo_id=repo_id,
        repo_type="model",
    )

    # Upload manifest subset (for consumers to verify version)
    version_meta = {
        "model": model_name,
        "version": version_key,
        "publishedAt": datetime.now(timezone.utc).isoformat(),
        "metrics": version_info.get("metrics", {}),
        "architecture": version_info.get("architecture"),
        "corpus": version_info.get("corpus"),
    }
    api.upload_file(
        path_or_fileobj=json.dumps(version_meta, indent=2).encode(),
        path_in_repo="nanomind-version.json",
        repo_id=repo_id,
        repo_type="model",
    )

    print(f"  Published: https://huggingface.co/{repo_id}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Push NanoMind models to HuggingFace")
    parser.add_argument("--model", help="Specific model to publish (default: all public)")
    parser.add_argument("--version", help="Specific version (default: latest)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be published")
    args = parser.parse_args()

    # Auth
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGIN_KEY", "")
    if not token and not args.dry_run:
        print("Set HF_TOKEN or HUGGIN_KEY environment variable")
        print("  export HF_TOKEN=hf_xxx")
        sys.exit(1)

    manifest = load_manifest()
    models = manifest["models"]

    if not args.dry_run:
        api = HfApi(token=token)
        user = api.whoami()
        print(f"Authenticated as: {user['name']}")
    else:
        api = None
        print("[DRY RUN MODE]")

    published = 0
    failed = 0

    for model_name, model_info in models.items():
        # Skip internal models
        if model_info["visibility"] != "public":
            if args.model and args.model == model_name:
                print(f"\n  WARNING: {model_name} is internal (visibility={model_info['visibility']})")
                print(f"  Internal models are not published to HuggingFace.")
            continue

        # Filter by --model flag
        if args.model and args.model != model_name:
            continue

        # Skip planned models with no versions
        if not model_info.get("versions"):
            continue

        # Determine version to publish
        version_key = args.version or model_info.get("latestVersion")
        if not version_key or version_key not in model_info["versions"]:
            print(f"\n  ERROR: Version {version_key} not found for {model_name}")
            failed += 1
            continue

        version_info = model_info["versions"][version_key]

        ok = publish_model(api, model_name, model_info, version_key, version_info, args.dry_run)
        if ok:
            published += 1
            # Update manifest with publish timestamp
            if not args.dry_run:
                model_info["huggingface"]["publishedVersion"] = version_key
                model_info["huggingface"]["lastPublished"] = datetime.now(timezone.utc).isoformat()
                update_manifest(manifest)
        else:
            failed += 1

    print(f"\nDone. Published: {published}, Failed: {failed}")
    if published > 0 and not args.dry_run:
        print("Manifest updated with publish timestamps.")


if __name__ == "__main__":
    main()
