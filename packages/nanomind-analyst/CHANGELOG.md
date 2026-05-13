# Changelog

## 0.1.1

- Fix: declare `accelerate>=0.26` as a runtime dependency. `transformers` raises a `ValueError` in `check_and_set_device_map` when `device_map=` is passed to `from_pretrained` without `accelerate` installed, and the NLM loader at `src/nanomind_analyst/daemon/_nlm.py` passes `device_map=device`. On clean envs without `accelerate` already present transitively, the daemon crashed at boot with `requires accelerate. You can install it with pip install accelerate`, so `healthz` never bound and the installer reported `LaunchctlError`.
- CI hardening: new `wheel-install-smoke` job in `ci-nanomind-analyst.yml` builds the wheel, installs it into a fresh venv with **no `--no-deps` shortcut**, and exercises `AutoModelForCausalLM.from_pretrained(..., device_map="cpu")` against a 5 MB stand-in model (`sshleifer/tiny-gpt2`). This is the regression gate for any future missing-runtime-dep regression on the inference path. The release workflow blocks on the same smoke before PyPI publish.

## 0.1.0

Initial release.

- CLI: `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`.
- Vendors the NanoMind-Guard daemon serving the v3.0.0 Qwen3-1.7B Analyst NLM behind the v1 input-classifier gate.
- Fetches NLM weights from `opena2a/nanomind-security-analyst` at the pinned v3.0.0 commit and verifies SHA256 against wheel-baked constants. Uses `local_dir_use_symlinks=False` so the verify reads bytes at the install location, not a swappable cache symlink.
- Bundles the input-classifier-v1 artifacts (~5 KB) inside the wheel; daemon re-verifies SHA256 at every boot before `joblib.load()` runs.
- Per-user launchd LaunchAgent at `~/Library/LaunchAgents/org.opena2a.nanomind-analyst.plist`. No root, no `sudo`. `install` calls `bootout` then `bootstrap` so upgrades reload the new plist rather than silently keeping the old in-memory definition.
- Installer's healthz probe refuses to connect to `/tmp/nanomind-guard.sock` when the path is a symlink or owned by a different uid (defense against same-host socket squatting).
- `nanomind-analyst-daemon` entrypoint is wrapped with a Darwin-arm64 platform check so a direct invocation on Linux/Intel fails with a clear message instead of a torch/MPS stacktrace.
- Release workflow refuses to publish if the tag's commit is not an ancestor of `origin/main`, and if `pyproject.toml` version does not match the tag suffix.
- Apple Silicon (Darwin arm64) only. Linux/cloud daemon support is tracked separately; the NLM is bf16-MPS and fp16 yields 0% accuracy on Qwen3-1.7B.

### Known limitations

- The daemon's default socket lives at `/tmp/nanomind-guard.sock`. On a multi-user macOS host, a different local user can prevent the daemon from binding by pre-creating the path (sticky-bit `/tmp` blocks the daemon's `unlink`). Migrating the default to a per-user path requires coordinated changes in `hackmyagent`'s IPC client; tracked separately.
- `uninstall --remove-artifacts` clears the user's Application Support dir but does not clear the Hugging Face cache at `~/.cache/huggingface/`. Symlinks are off (the install copies real files), so disk-space recovery requires both removals.
- GHA workflow steps reference upstream actions by tag (`actions/checkout@v4`, `pypa/gh-action-pypi-publish@release/v1`). Pinning to commit SHAs is a follow-up.
