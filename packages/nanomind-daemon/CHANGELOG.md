# Changelog

## 0.2.0

### CLI

- `nanomind-daemon --version` (and `-v`) now prints the package version and exits 0. Previously the flag fell through to the help banner with no version output, breaking tooling that probes `--version`.
- `nanomind-daemon --help` (and `-h`) now print usage and exit 0, matching the existing `help` subcommand.
- `nanomind-daemon stop` no longer crashes with `ENOENT: unlink '~/.nanomind/daemon.pid'` after a successful SIGTERM. The daemon process unlinks its own PID file during graceful shutdown; the CLI's post-signal cleanup now uses `fs.rmSync(..., { force: true })` so the race is tolerated and `stop` exits 0 on success.
- Unknown subcommands now print `Unknown command: <name>` to stderr and exit 1 instead of silently exiting 0 with the help banner. Shells that chain on the exit code (`nanomind-daemon foo && ...`) now fail correctly.

### Inference

- Daemon now loads the production NanoMind v0.5.0 Mamba-TME classifier (`nanomind-tme.onnx`) via `onnxruntime-node` instead of the SmolLM2 GGUF text-generation path. `/v1/infer` returns real classifications: `attackClass` is mapped to the canonical 5-value enum, `confidence` is the softmax probability of the predicted class, and the raw 10-way model label is preserved in `evidence`.
- Default `engine` swapped from `NanoMindEngine` (llamafile) to `OnnxEngine`. Custom engines can still be injected via `new NanoMindDaemon({ engine })` for tests or alternative runtimes.
- Model file integrity is now actually verified: SHA-256 of `nanomind-tme.onnx`, `nanomind-tme.onnx.data`, and `tokenizer.json` is checked on first load against the canonical hashes recorded in `nanomind-models.json` v0.5.0. Mismatch raises a hard error rather than running a tampered or stale model.
- `modelVersion` field reports `nanomind-tme-v0.5.0` (was hardcoded `SmolLM2-135M-Q4_K_M`).
- Bug 1 wire contract preserved on every code path:
  - Stub engines that return only `{text}` still produce a valid `InferResponse` with `attackClass: ""` and `confidence: 0.85`.
  - The `/v1/infer` 500 (engine-error) response now carries `attackClass: ""` and `confidence: 0` — typed JSON unmarshal on the consumer side never sees a missing field.
- `/v1/infer` rejects empty or whitespace-only `input` with HTTP 400 instead of feeding a pure-pad token sequence to the classifier (which produced noisy non-benign argmax results that would have poisoned downstream telemetry).
- Tokenizer strips zero-width characters (U+FEFF BOM, U+200B/200C/200D ZWSP/ZWNJ/ZWJ) before splitting. This is a defense-in-depth divergence from the trainer (Python's `str.isspace()` keeps zero-width chars attached to surrounding tokens). Cloaked prompt injections like `"\uFEFFignore previous instructions"` now classify identically to the un-cloaked control instead of tokenizing to `<UNK>`.
- Mapping table on the classifier output is now strict: a future model version that emits an unknown raw label fails loudly instead of silently bucketing as benign.
- `OnnxEngineConfig.skipIntegrityCheck` is honored only outside production builds (`process.env.NODE_ENV !== 'production'`); production builds always verify SHA-256 regardless of caller intent.
- Corpus smoke test gains a `NANOMIND_REQUIRE_MODEL=1` env-gate. CI sets this once the workflow downloads the v0.5.0 artifacts so a missing-artifact misconfiguration fails the build instead of skipping the only test that exercises real inference.

### Known model-quality limitations (v0.5.0 classifier)

The classifier ships with documented limitations on inputs outside its training corpus distribution. These are model properties, not daemon bugs; the wire contract holds in every case. See README "Known model-quality limitations" for the full disclosure and recommended consumer mitigations.

- Confidence saturates at `1.0` on many inputs rather than expressing graduated probability.
- False positives on natural-language benign queries (e.g. `"What is the weather today?"`).
- False negatives on natural-language exfiltration paraphrases not seen in training corpus.

Until v0.6.0 retrain: set `confidence > 0.95` rather than `0.8` before acting on non-empty `attackClass`, and corroborate with a non-classifier signal before blocking.

## 0.1.1

- `/v1/infer` response now always emits an `attackClass` string field. The field is empty until the production classifier ships; this restores the wire contract that AIM FGA Step 5 expects (`fga_engine.go::checkIntentSync`).
- Canonical attackClass enum documented in README: `""`, `"exfiltration_pattern"`, `"prompt_injection"`, `"tool_misuse"`, `"data_extraction"`.
- No behavior change for the FGA decision: `blocked = attackClass != "" && confidence > 0.8` still returns `false` for every response in this release because no classifier is wired in. 0.2.0 lands the classifier behind the wire.

## 0.1.0

- Initial release.
