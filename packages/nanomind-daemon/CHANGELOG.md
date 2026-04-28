# Changelog

## 0.2.0

- Daemon now loads the production NanoMind v0.5.0 Mamba-TME classifier (`nanomind-tme.onnx`) via `onnxruntime-node` instead of the SmolLM2 GGUF text-generation path. `/v1/infer` returns real classifications: `attackClass` is mapped to the canonical 5-value enum, `confidence` is the softmax probability of the predicted class, and the raw 10-way model label is preserved in `evidence`.
- Default `engine` swapped from `NanoMindEngine` (llamafile) to `OnnxEngine`. Custom engines can still be injected via `new NanoMindDaemon({ engine })` for tests or alternative runtimes.
- Model file integrity is now actually verified: SHA-256 of `nanomind-tme.onnx`, `nanomind-tme.onnx.data`, and `tokenizer.json` is checked on first load against the canonical hashes recorded in `nanomind-models.json` v0.5.0. Mismatch raises a hard error rather than running a tampered or stale model.
- `modelVersion` field reports `nanomind-tme-v0.5.0` (was hardcoded `SmolLM2-135M-Q4_K_M`).
- Bug 1 wire contract preserved: stub engines that return only `{text}` still produce a valid `InferResponse` with `attackClass: ""` and `confidence: 0.85`.

## 0.1.1

- `/v1/infer` response now always emits an `attackClass` string field. The field is empty until the production classifier ships; this restores the wire contract that AIM FGA Step 5 expects (`fga_engine.go::checkIntentSync`).
- Canonical attackClass enum documented in README: `""`, `"exfiltration_pattern"`, `"prompt_injection"`, `"tool_misuse"`, `"data_extraction"`.
- No behavior change for the FGA decision: `blocked = attackClass != "" && confidence > 0.8` still returns `false` for every response in this release because no classifier is wired in. 0.2.0 lands the classifier behind the wire.

## 0.1.0

- Initial release.
