# nanomind-analyst

Installer for the NanoMind Analyst daemon. The daemon serves the Qwen3-1.7B security analyst NLM behind an input-classifier gate over a Unix socket at `/tmp/nanomind-guard.sock`. Consumers (hackmyagent, opena2a-cli, ai-trust) connect to that socket for generative threat analysis on individual findings.

This package writes a per-user launchd LaunchAgent, fetches and verifies the model artifacts from Hugging Face, and manages the daemon lifecycle. Apple Silicon (Darwin arm64) only in v0.1.

## Install

```bash
pip install nanomind-analyst
nanomind-analyst install
```

The install step:

1. Verifies platform (Apple Silicon required).
2. Copies the input-classifier-v1 artifacts (bundled in the wheel) into `~/Library/Application Support/nanomind-analyst/artifacts/input-classifier-v1/`. SHA256 verified before copy.
3. Fetches the Analyst NLM (~3.4 GB) from `opena2a/nanomind-security-analyst` at the pinned v3.0.0 commit. SHA256 verified after fetch.
4. Writes a launchd plist to `~/Library/LaunchAgents/org.opena2a.nanomind-analyst.plist`.
5. Bootstraps the LaunchAgent into the user's gui session.
6. Waits up to 60 seconds for the daemon to bind the socket and pass its healthz probe.

The fetch step is the long one (several minutes on first run; cached on subsequent runs).

## Commands

| Command | What |
|---------|------|
| `nanomind-analyst install` | Full install flow. Idempotent. |
| `nanomind-analyst uninstall` | Stop, unload, remove plist. `--remove-artifacts` also deletes the 3.4 GB NLM. |
| `nanomind-analyst start` | Kickstart the loaded LaunchAgent. |
| `nanomind-analyst stop` | SIGTERM the daemon. Agent stays loaded; no auto-restart on clean exit. |
| `nanomind-analyst restart` | Stop then start. |
| `nanomind-analyst status` | Report whether the agent is loaded and healthz returns ready. |
| `nanomind-analyst logs` | Tail `~/Library/Logs/nanomind-analyst.log`. `--no-follow` for one-shot. |
| `nanomind-analyst --version` | Print the package version. |

## What gets written where

| Path | Purpose |
|------|---------|
| `~/Library/LaunchAgents/org.opena2a.nanomind-analyst.plist` | LaunchAgent plist. |
| `~/Library/Application Support/nanomind-analyst/artifacts/input-classifier-v1/` | Classifier joblib + meta.json (~5 KB). |
| `~/Library/Application Support/nanomind-analyst/artifacts/nanomind-security-analyst/` | NLM weights, tokenizer, configs (~3.4 GB). |
| `~/Library/Logs/nanomind-analyst.log` | Daemon stdout + stderr. |
| `/tmp/nanomind-guard.sock` | Unix socket the daemon binds (0600, owner-only). |

No root, no `/opt`, no `sudo`.

## Trust chain

The install does not depend on Hugging Face being trustworthy. The wheel manifest is the authoritative source of artifact identity:

1. PyPI Trusted Publishing (OIDC) attests the wheel was built by the workflow at `.github/workflows/release-nanomind-analyst.yml` from a commit in `opena2a-org/nanomind` (SLSA v1 provenance).
2. The wheel bakes `EXPECTED_NLM_SAFETENSORS_SHA256` and `EXPECTED_NLM_TOKENIZER_SHA256` constants in `artifacts.py`.
3. At `install`, the fetched NLM files are SHA256-verified against those constants. A tampered Hugging Face artifact causes install to refuse.
4. At daemon boot, `INPUT_CLASSIFIER_JOBLIB_SHA256` is re-verified before `joblib.load()` runs (joblib uses pickle = arbitrary code execution at deserialization).

Verify wheel provenance after publish:

```bash
npm  # no equivalent; use:
python -m pip download nanomind-analyst --no-deps --dest /tmp/verify
# Then inspect the wheel's METADATA + RECORD; PyPI surfaces attestations
# at https://pypi.org/project/nanomind-analyst/#files
```

## Linux / cloud daemon

Not supported in v0.1. The daemon is bf16 on Apple MPS; fp16 yields 0% accuracy on Qwen3-1.7B. Cross-platform inference is tracked in `opena2a-org/nanomind` issues with the labels `nanomind-analyst` + `platform-linux`.

## Known limitations

- **Cold-boot latency.** Daemon takes ~30 seconds to load the NLM on first request after a system reboot. The install flow waits up to 60 seconds for this; subsequent restarts are faster (the launchd-managed process stays warm).
- **NLM latency floor.** The Analyst NLM emits ~400 tokens of structured output per request at ~15 ms/token on bf16 MPS. Floor is ~6 seconds per finding. Consumers (HMA, opena2a-cli) should batch or filter before invoking. The input-classifier gate bypasses the NLM on off-topic inputs (~92% bypass rate on benign user input).
- **Single-instance.** The daemon binds a single Unix socket. Multiple `nanomind-analyst install` runs on the same machine share the same socket; the LaunchAgent label is unique to the user.

## Companion package

`hackmyagent` (npm) `--nanomind` flag uses this daemon. After installing this package, `hackmyagent nanomind setup` detects the `nanomind-analyst` CLI on PATH and shells out to `nanomind-analyst install`. If the CLI is missing, it prints the `pip install` instructions.

## Model card

[opena2a/nanomind-security-analyst](https://huggingface.co/opena2a/nanomind-security-analyst) — v3.0.0 (Qwen3-1.7B SFT LoRA r=64), Apache-2.0.

## License

MIT.
