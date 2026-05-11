# Changelog

## 0.1.0

Initial release.

- CLI: `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`.
- Vendors the NanoMind-Guard daemon serving the v3.0.0 Qwen3-1.7B Analyst NLM behind the v1 input-classifier gate.
- Fetches NLM weights from `opena2a/nanomind-security-analyst` at the pinned v3.0.0 commit and verifies SHA256 against wheel-baked constants.
- Bundles the input-classifier-v1 artifacts (~5 KB) inside the wheel; daemon re-verifies SHA256 at every boot before `joblib.load()` runs.
- Per-user launchd LaunchAgent at `~/Library/LaunchAgents/org.opena2a.nanomind-analyst.plist`. No root, no `sudo`.
- Apple Silicon (Darwin arm64) only. Linux/cloud daemon support is tracked separately; the NLM is bf16-MPS and fp16 yields 0% accuracy on Qwen3-1.7B.
