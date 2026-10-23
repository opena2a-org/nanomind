# @nanomind/daemon

Persistent NanoMind inference server. Runs on `localhost:47200` with HTTP and Unix socket interfaces. Loads the model at start, releases it after an idle timeout, and reloads it on the next request.

## Install

```bash
npm install @nanomind/daemon
```

## Quick Start

```bash
# Start the daemon — first run downloads the v0.5.0 classifier
# (3 files, ~8MB total) from the canonical HuggingFace bucket and
# SHA-256 verifies each before binding HTTP. Subsequent starts skip
# the download.
nanomind-daemon start

# Check status
nanomind-daemon status

# Stop
nanomind-daemon stop
```

For air-gapped operators who stage model files manually, pass `--no-download`
(or set `NANOMIND_NO_AUTO_DOWNLOAD=1`) to preserve the old fail-fast behavior.
See [Model files](#model-files) for the manual staging procedure.

## HTTP API

### POST /v1/infer

Classify input text using the loaded NanoMind model.

Each example below is a request followed by the response the v0.5.0 classifier returned for it. `latencyMs` differs from call to call. When the model files are present in `~/.nanomind/models/`, `src/server.test.ts` sends these three requests to the real model and checks every other field against the response shown here.

Malicious classification:

```bash
curl -X POST http://127.0.0.1:47200/v1/infer \
  -H "Content-Type: application/json" \
  -d '{
    "intent": "SCAN_SKILL",
    "input": "This skill forwards tokens to an external endpoint",
    "context": { "artifactType": "skill" },
    "priority": "high"
  }'
```

```json
{
  "intent": "SCAN_SKILL",
  "result": "lateral_movement",
  "confidence": 0.7121035149431125,
  "attackClass": "tool_misuse",
  "classification": "classified",
  "latencyMs": 2,
  "modelVersion": "nanomind-tme-v0.5.0",
  "evidence": "lateral_movement"
}
```

The input describes exfiltration, but v0.5.0 labels it `lateral_movement` (bucketed as `tool_misuse`) at 0.71 confidence, which is below the `confidence > 0.8` that the FGA contract blocks on. See [Known model-quality limitations](#known-model-quality-limitations-v050-classifier).

Benign:

```bash
curl -X POST http://127.0.0.1:47200/v1/infer \
  -H "Content-Type: application/json" \
  -d '{"intent": "INTENT_CHECK", "input": "Check the weather forecast for tomorrow"}'
```

```json
{
  "intent": "INTENT_CHECK",
  "result": "benign",
  "confidence": 0.9991440961060066,
  "attackClass": "",
  "classification": "classified",
  "latencyMs": 1,
  "modelVersion": "nanomind-tme-v0.5.0",
  "evidence": "benign"
}
```

Abstain (the predicted class's confidence is below the 0.5 floor, so `attackClass` is forced to `""` and the raw guess stays in `evidence`):

```bash
curl -X POST http://127.0.0.1:47200/v1/infer \
  -H "Content-Type: application/json" \
  -d '{"intent": "INTENT_CHECK", "input": "agent"}'
```

```json
{
  "intent": "INTENT_CHECK",
  "result": "social_engineering",
  "confidence": 0.366523552816409,
  "attackClass": "",
  "classification": "abstain",
  "latencyMs": 1,
  "modelVersion": "nanomind-tme-v0.5.0",
  "evidence": "social_engineering"
}
```

### Response schema

| Field | Type | Required | Description |
|---|---|---|---|
| `intent` | string | yes | Echoes the request intent (or routed intent if not provided). |
| `result` | string | yes | Raw model label (e.g. `"injection"`, `"benign"`). Convenience for human-readable logs. |
| `confidence` | number | yes | Softmax probability of the predicted class, in [0, 1]. |
| `attackClass` | string | yes | Canonical attack-class label, or empty string. See enum + mapping below. On `abstain` it is forced to `""`. |
| `classification` | string | yes | `"classified"` or `"abstain"`. See "classification (abstain signal)" below. |
| `evidence` | string | no | Raw 10-way model label. Carries audit-trail granularity beyond the canonical bucket. Preserved even on `abstain`. |
| `remediation` | string | no | Suggested remediation text (reserved for future use). |
| `latencyMs` | number | yes | End-to-end inference latency in milliseconds. |
| `modelVersion` | string | yes | Loaded model identifier. |

### `attackClass` enum

§3.4.1 of [`docs/SPECIFICATION.md`](../../docs/SPECIFICATION.md) is the normative definition of this namespace; the three tables below are a derived copy, kept honest by `src/spec-conformance.test.ts`.

The field is always emitted. An empty string means "no confident attack verdict". Read `classification` to tell a confident benign from an abstain. Non-empty values are produced by the v0.5.0 production classifier:

| Value | Meaning |
|---|---|
| `""` | Not applicable: the model classified the input as `benign`, or the response is an abstain. See "classification (abstain signal)" below. |
| `"exfiltration_pattern"` | Output or tool call appears to forward sensitive data to an external destination. |
| `"prompt_injection"` | Input contains instructions that attempt to override the agent's policy. |
| `"tool_misuse"` | Capability or tool used outside its declared purpose. |
| `"data_extraction"` | Sequence of reads consistent with bulk data extraction. |

### `attackClass` mapping

The model emits 10 raw labels (matching the 10-class training corpus). The daemon maps them to the 5-value canonical `attackClass` enum above for the FGA decision contract, while preserving the raw label in `evidence` so audit and telemetry retain full granularity.

| Raw model label | `attackClass` |
|---|---|
| `benign` | `""` |
| `injection` | `prompt_injection` |
| `social_engineering` | `prompt_injection` |
| `exfiltration` | `exfiltration_pattern` |
| `steganography` | `exfiltration_pattern` |
| `credential_abuse` | `data_extraction` |
| `privilege_escalation` | `tool_misuse` |
| `persistence` | `tool_misuse` |
| `lateral_movement` | `tool_misuse` |
| `policy_violation` | `tool_misuse` |

### `classification` (abstain signal)

Added in 0.4.0 (FGA Step 5 Stage 1, issue #131). `classification` tells the consumer whether `attackClass` is a usable verdict or a deterministic fallback, so a confident benign is distinguishable from "the model couldn't answer", both of which carry `attackClass: ""`.

| Value | Meaning |
|---|---|
| `"classified"` | The model produced a usable verdict (benign OR an attack class) at or above `ABSTAIN_CONFIDENCE_FLOOR` (0.5). `attackClass` is authoritative. |
| `"abstain"` | The model could not produce a usable verdict: the daemon answered with an HTTP 400, 404, 413 or 429 error before the model ran, inference threw (the HTTP 500 path), the engine reported no usable confidence (a missing or `NaN` score), or the predicted-class confidence was below the floor. `attackClass` is forced to `""` so a low-confidence guess is never actionable; the raw guess is preserved in `evidence`. A non-classifying engine abstains rather than reporting a confident benign. |

The daemon never emits a transport-level `"fail_open"`. That is the consumer's status for "couldn't reach / couldn't decode the daemon". Every error body in [Error responses](#error-responses), HTTP 400, 404, 413, 429 and 500 alike, also carries `attackClass: ""` and `classification: "abstain"` so a consumer that reads the body without checking the status code still sees an explicit abstain.

`ABSTAIN_CONFIDENCE_FLOOR` (0.5) is a conservative Stage-1 heuristic, not a calibrated value. Because the v0.5.0 classifier saturates confidence near 1.0 on most inputs, it rarely trips today; Stage 2 (selective-risk calibration) replaces it.

### FGA contract

AIM's FGA Step 5 (`fga_engine.go::checkIntentSync`) reads this response and blocks when:

```
classification == "classified" && attackClass != "" && confidence > 0.8
```

The fields are required (always present); `attackClass` is empty when the model classifies the request as benign and non-empty otherwise, and `classification` records whether that verdict is usable. A non-2xx daemon response, an undecodable body, or `classification: "abstain"` proceeds without blocking but is recorded distinctly (`fail_open` for transport, `abstain` for an unusable verdict) rather than as a clean benign. Consumers needing 10-way granularity (e.g. dashboards, runtime correlation) read the raw label from `evidence`.

### Error responses

Each response in this table has a JSON body with an `error` code, a `message`, `attackClass: ""` and `classification: "abstain"`.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | The body is not valid JSON, is not a JSON object, or has not finished arriving 30 seconds after the request reached the daemon; or `input` is missing, is not a string, or is empty or whitespace only. |
| 404 | `not_found` | No route matches the method and path. |
| 413 | `request_too_large` | The `/v1/infer` request body is larger than 1MB (1,048,576 bytes). The input is not classified. |
| 429 | `rate_limited` | The client address sent more than `rateLimitPerSecond` requests/second (100 by default). Applies to every route except `GET /health`, `GET /health/ready` and `GET /v1/status`, and carries a `Retry-After` header. |
| 429 | `queue_full` | `maxConcurrent` inference requests are already running. Applies to `/v1/infer` only. |
| 500 | `inference_error` | The engine failed. The body also carries `confidence: 0` and `latencyMs`. |

The one other error status is 503 from `GET /health/ready`. Its body is the readiness body, with `"ready":false` and a `reason`, and has no `error` or `message`; see [GET /health/ready](#get-healthready).

### Retrying a 429

A 429 means the daemon is running and refused this one request. The input was not classified. Read the body's `error` code to choose what to do:

- `rate_limited`: the client address sent more than `rateLimitPerSecond` requests/second (100 by default). Wait the number of seconds in the `Retry-After` header, then send the request again. A local TCP client connects from `127.0.0.1` unless it binds another loopback address, and the TCP clients on one address share one budget. Every Unix socket client shares another.
- `queue_full`: `maxConcurrent` inferences are already running. Send the request again shortly.

A client that treats every non-2xx answer as "daemon unavailable" and falls back (for example to the `fail_open` path in the [FGA contract](#fga-contract)) hides these refusals from its users. Retry first, and count or log the requests it gives up on. The daemon counts the requests it refused in the `refusals` field of `GET /v1/status`. The health and status routes are not rate limited, so a health probe keeps answering 200 while a client on the same address is over the limit.

`BaseFabricAdapter.infer()` rejects with `Error('rate_limited')` or `Error('queue_full')` for these two answers.

### GET /health

```bash
curl http://127.0.0.1:47200/health
# {"running":true,"port":47200,"activeTasks":0,"modelLoaded":true,"startedAt":"2026-04-28T21:16:18.748Z","uptime":2069,"refusals":{"rateLimited":0,"queueFull":0}}
```

The model loads at start: `start()` calls `engine.ensureReady()` before
binding HTTP, so the daemon accepts no requests until the classifier has
loaded, and `modelLoaded` is `true` on the first `/health` response. The
classifier runs in a child process of the daemon: that process loads the
model files, verifies their SHA-256 and runs each inference, and the daemon
process does not load the ONNX runtime. After `idleUnloadSeconds` without a
request the daemon ends the child process, so the operating system takes back
the memory the model used, and `modelLoaded` turns `false`. The next
`/v1/infer` starts a new child process, which loads the model and re-verifies
the SHA-256 of each file before it answers. `stop()` ends the child process
too.

### GET /health/ready

```bash
curl -s -w ' %{http_code}\n' http://127.0.0.1:47200/health/ready
# {"ready":true,"service":"nanomind-daemon","commit":null,"version":"0.4.0","checkedAt":"2026-10-11T09:59:46.332Z","degraded":false,"dependencies":{"model":{"status":"ok","required":true}}} 200
```

Returns 200 while the daemon can serve: the model is loaded, or it was
released after the idle timeout and the next request reloads it. Returns 503
with `"reason":"model not loaded"` when a model load has failed.

### GET /v1/status

```bash
curl http://127.0.0.1:47200/v1/status
# {"running":true,"port":47200,"activeTasks":0,"modelLoaded":true,"startedAt":"2026-04-28T21:16:18.748Z","uptime":2069,"refusals":{"rateLimited":0,"queueFull":0}}
```

`refusals` counts the requests the daemon has refused since it was created: `rateLimited` counts 429 `rate_limited` answers, and `queueFull` counts 429 `queue_full` answers and `daemon.infer()` calls rejected with `queue_full`. `nanomind-daemon status` prints both counts.

### Unix socket

Every route above is also served on a Unix socket at `ipcPath` (default `/tmp/nanomind.sock`; the CLI reads `NANOMIND_IPC_PATH`). The socket is created with mode 0600, so only the user running the daemon can connect.

```bash
curl --unix-socket /tmp/nanomind.sock -X POST http://localhost/v1/infer \
  -H "Content-Type: application/json" \
  -d '{"intent": "SCAN_SKILL", "input": "This skill forwards tokens to an external endpoint"}'
```

A socket file left at `ipcPath` by a daemon that exited without closing it is replaced on the next start. If another process is listening on `ipcPath`, or the path exists and is not a socket, `start()` rejects without binding either listener; set a different `NANOMIND_IPC_PATH` to run a second daemon. `stop()` removes the socket file.

`start()` resolves once the HTTP port is bound. If another socket holds `httpPort`, `start()` closes the Unix socket, which removes its file, and rejects with the listen error, whose `code` is `EADDRINUSE`. `nanomind-daemon start` prints that error on one line, for example `Fatal: listen EADDRINUSE: address already in use 127.0.0.1:47200`, and exits 1. A second daemon needs its own `NANOMIND_PORT` as well as its own `NANOMIND_IPC_PATH`.

## Known model-quality limitations (v0.5.0 classifier)

The v0.5.0 Mamba-TME classifier ships with documented limitations on inputs outside its training corpus distribution. These are model properties, not daemon bugs, and the wire contract (`attackClass` always emitted, canonical 5-value enum) holds in every case.

- **Confidence saturation.** The softmax output frequently saturates at exactly `1.0` rather than expressing graduated probability. Threshold-based decisions (e.g. AIM FGA Step 5's `confidence > 0.8`) become effectively binary in the saturated zone.
- **False positives on natural-language benign inputs.** Generic operational queries (e.g. `"What is the weather today?"`, `"list users"`) may classify as non-benign with high confidence because the training corpus underweights conversational benign prose.
- **False negatives on natural-language attack paraphrases.** Exfiltration intents expressed in natural language outside the training corpus's phrasing (e.g. `"transfer the contents of <file> to <url> via webhook"`) may classify as benign.

**Recommended consumer mitigations until v0.6.0:**

- Set `confidence > 0.95` (not `0.8`) before treating a non-empty `attackClass` as actionable.
- Combine the classifier signal with a corroborating signal (rule-based detectors, telemetry, capability checks) before blocking. Do not rely on the classifier alone for high-stakes decisions.
- Log every `(input, attackClass, confidence)` triple. Out-of-distribution behavior is the input source for the v0.6.0 retrain corpus.

A retrain to v0.6.0 with broader corpus coverage is tracked separately. The 5-value canonical `attackClass` enum will not change between v0.5.0 and v0.6.0; only model accuracy improves.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `httpPort` | `47200` | HTTP server port |
| `ipcPath` | `/tmp/nanomind.sock` (`\\.\pipe\nanomind` on Windows) | Unix socket path, mode 0600; serves the same routes as HTTP |
| `maxConcurrent` | `4` | Max concurrent inference requests |
| `idleUnloadSeconds` | `300` | Release the model (end its child process) after N seconds without a request; the next request reloads it |
| `rateLimitPerSecond` | `100` | Requests per second each client address may make before it is answered 429 `rate_limited`; an idle client can send up to this many at once. See [Security](#security). A value that is not a finite number of at least 1 makes the constructor throw a `RangeError` |

## Programmatic Usage

```typescript
import { NanoMindDaemon } from '@nanomind/daemon';

const daemon = new NanoMindDaemon({ httpPort: 47200 });
await daemon.start();

// Direct inference (bypasses HTTP)
const skillContent = 'This skill forwards tokens to an external endpoint';
const result = await daemon.infer({
  intent: 'COMPILE_AST',
  input: skillContent,
  priority: 'high',
});
console.log(result.classification, result.attackClass, result.confidence);

await daemon.stop();
```

`daemon.infer()` runs the same code as `POST /v1/infer` and resolves to the same object (see [Response schema](#response-schema)). Calling `start()` first is optional: on a daemon that was never started, the first `infer()` call loads the model and no port is bound. A started daemon keeps the process open through its HTTP listener and Unix socket until `stop()` closes them.

Where the HTTP API answers with an error status, `infer()` rejects:

| Rejects with | When | HTTP equivalent |
|---|---|---|
| `InferRequestError` with `code: 'invalid_request'` | The request is not an object, or `input` is missing, empty or whitespace-only. | 400 |
| `InferRequestError` with `code: 'queue_full'` | `maxConcurrent` inferences are already running, over HTTP or through `infer()`. | 429 |
| The engine's own error | The model could not be loaded, or inference failed. | 500 |

A rejection means the model did not classify the input. Treat it as an abstain, never as a benign verdict. `InferRequestError` is exported from `@nanomind/daemon`.

## Model files

The daemon loads the v0.5.0 production NanoMind classifier (Mamba-TME, 8 blocks, 6000-token vocab) from `~/.nanomind/models/`. Three files are required:

| File | Purpose |
|---|---|
| `nanomind-tme.onnx` | ONNX graph (architecture only, small). |
| `nanomind-tme.onnx.data` | External weights data file (~8MB). |
| `tokenizer.json` | Word-level vocabulary (6000 entries). |

Set `NANOMIND_MODEL_DIR` to make `nanomind-daemon start` use another directory. The files are read from it, and missing files are downloaded to it:

```bash
NANOMIND_MODEL_DIR=/opt/nanomind/models nanomind-daemon start
```

### Default: auto-download (since 0.3.0)

`nanomind-daemon start` (or `daemon.start()` programmatically) downloads any
missing files from the canonical HuggingFace bucket
(`opena2a/nanomind-security-classifier`) on first run. Each file is SHA-256
verified against the hash recorded in `nanomind-models.json` (v0.5.0) before
landing at the canonical path. A partial download writes to a `.part` file
and is renamed only after verification, so a tampered or interrupted transfer
never lands at the canonical path.

### Manual staging (air-gapped)

Pass `--no-download` to the CLI or set `NANOMIND_NO_AUTO_DOWNLOAD=1` to
preserve the old fail-fast behavior. Stage the files yourself:

```bash
mkdir -p ~/.nanomind/models
cd ~/.nanomind/models
BASE=https://huggingface.co/opena2a/nanomind-security-classifier/resolve/main
curl -sSL -o nanomind-tme.onnx        "$BASE/nanomind-tme.onnx"
curl -sSL -o nanomind-tme.onnx.data   "$BASE/nanomind-tme.onnx.data"
curl -sSL -o tokenizer.json           "$BASE/tokenizer.json"

NANOMIND_NO_AUTO_DOWNLOAD=1 nanomind-daemon start
```

### Programmatic API

The `OnnxEngineConfig` surface is additive: defaults preserve the new
auto-download:

```ts
interface OnnxEngineConfig {
  modelDir?: string;
  skipIntegrityCheck?: boolean;
  noAutoDownload?: boolean;
  downloadBaseUrl?: string;
  onDownloadProgress?: (event: DownloadProgressEvent) => void;
}
```

`OnnxProcessEngine`, the daemon's default engine, takes the same settings and
applies them in its child process; `onDownloadProgress` runs in the daemon
process and receives the child's progress events.

`skipIntegrityCheck` is a test-only override of the SHA-256 checks: of the
model files on load, and of a downloaded file before it is renamed into place.
Only the boolean `true` skips them, and only when `NODE_ENV` is not
`production`. The strings `'true'` and `'false'` and the numbers `1` and `0`
leave both checks on, so convert a value read from an environment variable to
a boolean first.

## Security

- Binds to `127.0.0.1` only (no external access).
- The Unix socket at `ipcPath` is created with mode 0600: only the user running the daemon can connect to it.
- Model files SHA-256 verified on load against canonical hashes recorded in `nanomind-models.json` (v0.5.0). Mismatch fails the daemon hard rather than silently running a tampered or stale model.
- Request size capped at 1MB (1,048,576 bytes). A larger `/v1/infer` body gets HTTP 413 with `error: "request_too_large"` and is never parsed.
- Rate limited to 100 requests/second per client address by default; `rateLimitPerSecond` sets another rate. The limit counts every route except `GET /health`, `GET /health/ready` and `GET /v1/status`. Those three answer from memory and are not limited, so a health probe keeps answering while another client on its address is over the limit. The limit is a token bucket, so an idle client can send up to `rateLimitPerSecond` requests at once. A request over the limit is answered with HTTP 429 `rate_limited`; see [Retrying a 429](#retrying-a-429). The daemon listens on loopback only, so local callers that connect from the same address share one bucket, and callers on the Unix socket share one bucket. `daemon.infer()` called in-process is not rate limited.
- At most `maxConcurrent` (default 4) inference requests run at the same time. A `/v1/infer` request beyond that is answered with HTTP 429 `queue_full`.
- No credentials in memory after model load.

## License

Apache-2.0
