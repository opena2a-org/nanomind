# Changelog

## 0.4.0

### Explicit abstain contract — FGA Step 5 Stage 1 (closes the silent-open half of #131)

`/v1/infer` responses now carry a `classification` field — `"classified"` or `"abstain"` — so a consumer can tell a confident benign apart from "the model couldn't answer". Until now both produced `attackClass: ""`, and AIM FGA Step 5 had to treat every empty class as an indistinct abstain (the conflation issue #131 is about).

- New `InferResponse.classification: "classified" | "abstain"`.
  - `"classified"`: the model produced a usable verdict (benign OR an attack class) at or above `ABSTAIN_CONFIDENCE_FLOOR`. `attackClass` is authoritative (`""` is a confident benign).
  - `"abstain"`: the model could not produce a usable verdict — inference threw, the engine reported no usable confidence (a missing or `NaN` score, e.g. a non-classifying legacy/stub engine), or the predicted-class confidence was below the floor. `attackClass` is forced to `""` (a low-confidence guess can never read downstream as a verdict) and the raw guess is preserved in `evidence`. A non-classifying engine therefore abstains rather than masquerading as a confident benign.
- New exported `ABSTAIN_CONFIDENCE_FLOOR = 0.5`. A deliberately conservative Stage-1 heuristic, **not** a calibrated value — below even odds the top-of-10 class is not trustworthy. The v0.5.0 classifier saturates confidence near 1.0 on most inputs, so this rarely trips today; the dominant Stage-1 fix is the explicit `classification` field. Stage 2 (selective-risk calibration) replaces the constant.
- The HTTP 500 (engine-error) body now also carries `classification: "abstain"`, so a consumer that reads the body without checking the status code still sees an explicit abstain instead of a clean benign.
- **Backward + forward compatible:** the field is additive. Older consumers that ignore it still get a deterministic `attackClass` (`""` on abstain); an older daemon that omits it lets AIM fall back to its legacy `attackClass==""?abstain:classified` heuristic. No lockstep deploy required.

This is a contract/fallback change only — no model retrain. Stage 1 does **not** re-enable any live Beat-5 classification line; that is gated on Stage 2 (fine-tune to F1 > 0.85).

### Unix socket at `ipcPath` (#105)

The daemon now listens on `ipcPath` (default `/tmp/nanomind.sock`) as well as `127.0.0.1:47200`. The README and package description already described a Unix socket interface, but `ipcPath` was never read and only the HTTP server was created.

- The socket serves the same routes and `/v1/infer` contract as HTTP, through the same request handler: `curl --unix-socket /tmp/nanomind.sock http://localhost/v1/status`.
- It is created with mode 0600, so only the user running the daemon can connect.
- A socket file left by a daemon that exited without closing it is replaced on start. A live listener on `ipcPath`, or a path that exists and is not a socket, makes `start()` reject without binding either listener.
- `stop()` closes the socket and removes its file.
- The CLI reads `NANOMIND_IPC_PATH` for the socket path and prints it on start.

### `InferRequest.intent` is optional (#145)

`InferRequest` declares `intent?: string`, and the specification's `/v1/infer` Request line reads `{ intent?, input, context?, priority? }`. The daemon already routed an intent from `input` when a request had none, but the type required one, so a TypeScript caller of `infer({ input })` needed a cast.

### Programmatic inference: `daemon.infer()` (#111, #139)

The README "Programmatic Usage" example called `daemon.infer()`, a method `NanoMindDaemon` did not have, and failed with `TypeError: daemon.infer is not a function`. It also used a `skillContent` it never defined.

- New `NanoMindDaemon.infer(request)`. It runs the same code as `POST /v1/infer` (request validation, the `maxConcurrent` cap, lazy model load and the abstain contract) and resolves to the same `InferResponse`. It works on a daemon that was never started: the first call loads the model and no port is bound.
- New exported `InferRequestError` (and `InferRequestErrorCode` type). `infer()` rejects with it, `code` `invalid_request` or `queue_full`, where the endpoint answers 400 or 429. When the model cannot load or inference fails, it rejects with the engine's own error, where the endpoint answers 500. A rejection is never a benign verdict.
- `POST /v1/infer` with a JSON `null` body answers 400 `invalid_request`; it used to raise an unhandled rejection and leave the client without a response. A request whose body finishes arriving after the last slot was taken answers 429 instead of running past `maxConcurrent`.
- The idle-unload timer no longer keeps the process open, so a script that only calls `infer()` exits when it is done.
- The README example defines its input, prints the verdict and stops the daemon it started, and a test runs it as written against a stub engine.

### Rate limit, model directory and entry-point exports (#141)

The README and `--help` described these; the daemon now does them.

- Every HTTP and Unix socket route is rate limited to 100 requests/second per client address (a token bucket holding 100). A request over the limit is answered with HTTP 429 (`rate_limited`) and a `Retry-After` header. The existing limit of `maxConcurrent` inference requests still answers HTTP 429 (`queue_full`). `daemon.infer()` called in-process is not rate limited.
- `nanomind-daemon start` reads `NANOMIND_MODEL_DIR` as the directory the model files are read from and downloaded to. Unset or empty, it stays `~/.nanomind/models/`.
- `ABSTAIN_CONFIDENCE_FLOOR` and the `ClassificationStatus` type are exported from the package entry point. They were declared in `server.ts` only, so `import { ABSTAIN_CONFIDENCE_FLOOR } from '@nanomind/daemon'` failed.

### Tests

- 21/21 pass (was 18; +3: a no-confidence engine result abstains; sub-floor confidence abstains and blanks attackClass; a verdict exactly at the inclusive floor classifies through).
- New tests cover the rate limit, `NANOMIND_MODEL_DIR` and the entry-point exports. The last two run the built package and skip until `npm run build` has written `dist/`.

---

## 0.3.0

### Auto-download + eager readiness (closes #28)

- `start()` now downloads missing model artifacts (`nanomind-tme.onnx`, `nanomind-tme.onnx.data`, `tokenizer.json`) from the canonical HuggingFace bucket and SHA-256 verifies each file against `EXPECTED_SHA256` before binding HTTP. Consumers running `npx @nanomind/daemon start` on a clean machine get a real classification on the first `/v1/infer`; previously the first request returned 500 (`NanoMind ONNX not found at ...`) and downstream tools (`@opena2a/aicomply 2.0`) silently fell back to regex-only Guard.
- `start()` is now eager: `engine.ensureReady()` runs before the HTTP server binds. `GET /health` only returns 200 after the model has loaded — no more "daemon up, classifier broken" race window.
- Partial downloads use a `.part` rename pattern + per-byte SHA-256, so bad bytes never land at the canonical path. No `.part` file is left behind on HTTP failure.
- Redirects followed up to 5 levels (huggingface.co 302 to S3 chain works transparently).

### Air-gap / opt-out

- `--no-download` CLI flag and `NANOMIND_NO_AUTO_DOWNLOAD=1` env var preserve the old fail-fast behavior for air-gapped operators who stage model files themselves.

### API additions (all additive on `OnnxEngineConfig`)

- `noAutoDownload?: boolean` opts out of auto-download.
- `downloadBaseUrl?: string` is a test seam for overriding the default HF base URL.
- `onDownloadProgress?: (event: DownloadProgressEvent) => void` observes `start` / `bytes` / `verifying` / `done` / `error` events for progress UI. Default observer logs one line per file to stderr.

### Tests

- 18/18 pass (was 11; +7 download tests). All download tests use a local mock HTTP server so the suite stays offline-safe.

---

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
