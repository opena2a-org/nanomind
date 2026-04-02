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

    return f"""---
license: apache-2.0
tags:
  - security
  - ai-agents
  - mcp
  - nanomind
  - opena2a
  - threat-detection
datasets:
  - opena2a/nanomind-training
metrics:
  - accuracy
  - f1
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

# {model_name} v{version_key}

{model_info['description']}

Part of the [OpenA2A](https://opena2a.org) security ecosystem.
Used by [HackMyAgent](https://github.com/opena2a-org/hackmyagent) for AI agent security scanning.

## Metrics

| Metric | Value |
|--------|-------|
| Eval accuracy | {accuracy_str} |
| Training samples | {train_samples} |
| Eval samples | {eval_samples} |
| Attack classes | {classes} |
| Training corpus | {corpus} |

## Architecture

- **Type:** {arch}
- **Inference:** ONNX (Node.js via onnxruntime-node) or NPZ weights
- **Latency:** Sub-2ms on CPU

## Attack Classes ({classes})

{attack_classes}

## Usage

```bash
# Install HackMyAgent (includes NanoMind inference)
npm install -g hackmyagent

# Scan an MCP server or AI agent project
hackmyagent scan ./my-agent --deep

# Or use via OpenA2A CLI
npx opena2a scan ./my-agent
```

## Training

Trained on Apple Silicon (MLX) using curated security corpus from:
- [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent) attack payloads
- [AgentPwn](https://agentpwn.com) honeypot captures
- [OASB](https://oasb.org) benchmark dataset
- OpenA2A Registry skill descriptions

## License

Apache-2.0. Free for commercial and non-commercial use.

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
