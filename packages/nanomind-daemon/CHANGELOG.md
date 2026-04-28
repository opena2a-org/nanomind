# Changelog

All notable changes to `@nanomind/daemon` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-04-28

### Changed

- `/v1/infer` response now always emits an `attackClass` string field. The field defaults to `""` (empty string) when no malicious intent is detected. Non-empty values (`exfiltration_pattern`, `prompt_injection`, `tool_misuse`, `data_extraction`) land when the production classifier is wired in.
- `InferResponse.attackClass` is now a required field of type `AttackClass` (a string-literal union exported from `@nanomind/daemon`). Previously it was an optional `string` that the daemon never set, so the field was silently absent from every response.

### Why

The AIM FGA engine's Step 5 (`fga_engine.go::checkIntentSync`) decodes the daemon response into a struct that includes `attackClass`, then computes `blocked := attackClass != "" && confidence > 0.8`. Because the daemon never set the field, FGA always saw the zero value (empty string) and never blocked — the integration was silently fail-open. This change restores the wire contract so the field is present on every response. Today the value is always empty, so FGA's behavior is unchanged; this is a foundation for the production classifier to land into a working contract.

## [0.1.0] — 2026-04-12

### Added

- Initial release: persistent NanoMind inference daemon with HTTP and IPC interfaces.
- HTTP endpoints: `GET /health`, `GET /v1/status`, `POST /v1/infer`.
- Lazy model load on first request; idle unload after configurable timeout.
- Concurrency-bounded inference queue with 429 backpressure.
