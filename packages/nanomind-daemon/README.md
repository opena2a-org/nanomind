# @nanomind/daemon

Persistent NanoMind inference server. Runs on `localhost:47200` with HTTP and Unix socket interfaces. Lazy-loads the model on first request, unloads after idle timeout.

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

Response (malicious classification):

```json
{
  "intent": "SCAN_SKILL",
  "result": "exfiltration",
  "confidence": 0.94,
  "attackClass": "exfiltration_pattern",
  "classification": "classified",
  "evidence": "exfiltration",
  "latencyMs": 2,
  "modelVersion": "nanomind-tme-v0.5.0"
}
```

Response (benign):

```json
{
  "intent": "INTENT_CHECK",
  "result": "benign",
  "confidence": 0.91,
  "attackClass": "",
  "classification": "classified",
  "evidence": "benign",
  "latencyMs": 1,
  "modelVersion": "nanomind-tme-v0.5.0"
}
```

Response (abstain — model could not produce a usable verdict):

```json
{
  "intent": "INTENT_CHECK",
  "result": "injection",
  "confidence": 0.31,
  "attackClass": "",
  "classification": "abstain",
  "evidence": "injection",
  "latencyMs": 1,
  "modelVersion": "nanomind-tme-v0.5.0"
}
```

### Response schema

| Field | Type | Required | Description |
|---|---|---|---|
| `intent` | string | yes | Echoes the request intent (or routed intent if not provided). |
| `result` | string | yes | Raw model label (e.g. `"injection"`, `"benign"`) — convenience for human-readable logs. |
| `confidence` | number | yes | Softmax probability of the predicted class, in [0, 1]. |
| `attackClass` | string | yes | Canonical attack-class label, or empty string. See enum + mapping below. On `abstain` it is forced to `""`. |
| `classification` | string | yes | `"classified"` or `"abstain"`. See "classification (abstain signal)" below. |
| `evidence` | string | no | Raw 10-way model label. Carries audit-trail granularity beyond the canonical bucket. Preserved even on `abstain`. |
| `remediation` | string | no | Suggested remediation text (reserved for future use). |
| `latencyMs` | number | yes | End-to-end inference latency in milliseconds. |
| `modelVersion` | string | yes | Loaded model identifier. |

### `attackClass` enum

§3.4.1 of [`docs/SPECIFICATION.md`](../../docs/SPECIFICATION.md) is the normative definition of this namespace; the three tables below are a derived copy, kept honest by `src/spec-conformance.test.ts`.

The field is always emitted. An empty string means "no confident attack verdict" — read `classification` to tell a confident benign from an abstain. Non-empty values are produced by the v0.5.0 production classifier:

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

Added in 0.4.0 (FGA Step 5 Stage 1, issue #131). `classification` tells the consumer whether `attackClass` is a usable verdict or a deterministic fallback, so a confident benign is distinguishable from "the model couldn't answer" — both of which carry `attackClass: ""`.

| Value | Meaning |
|---|---|
| `"classified"` | The model produced a usable verdict (benign OR an attack class) at or above `ABSTAIN_CONFIDENCE_FLOOR` (0.5). `attackClass` is authoritative. |
| `"abstain"` | The model could not produce a usable verdict — inference threw (the HTTP 500 path), the engine reported no usable confidence (a missing or `NaN` score), or the predicted-class confidence was below the floor. `attackClass` is forced to `""` so a low-confidence guess is never actionable; the raw guess is preserved in `evidence`. A non-classifying engine abstains rather than reporting a confident benign. |

The daemon never emits a transport-level `"fail_open"` — that is the consumer's status for "couldn't reach / couldn't decode the daemon". The HTTP 500 error body also carries `classification: "abstain"` so a consumer that reads the body without checking the status code still sees an explicit abstain.

`ABSTAIN_CONFIDENCE_FLOOR` (0.5) is a conservative Stage-1 heuristic, not a calibrated value. Because the v0.5.0 classifier saturates confidence near 1.0 on most inputs, it rarely trips today; Stage 2 (selective-risk calibration) replaces it.

### FGA contract

AIM's FGA Step 5 (`fga_engine.go::checkIntentSync`) reads this response and blocks when:

```
classification == "classified" && attackClass != "" && confidence > 0.8
```

The fields are required (always present); `attackClass` is empty when the model classifies the request as benign and non-empty otherwise, and `classification` records whether that verdict is usable. A non-2xx daemon response, an undecodable body, or `classification: "abstain"` proceeds without blocking but is recorded distinctly (`fail_open` for transport, `abstain` for an unusable verdict) rather than as a clean benign. Consumers needing 10-way granularity (e.g. dashboards, runtime correlation) read the raw label from `evidence`.

### GET /health

```bash
curl http://127.0.0.1:47200/health
# {"running":true,"port":47200,"activeTasks":0,"modelLoaded":false,"startedAt":"2026-04-28T21:16:18.748Z","uptime":2069}
```

`modelLoaded` is `true` as soon as `/health` returns 200. `start()` calls
`engine.ensureReady()` before binding HTTP, so the daemon will not accept
requests until the classifier has loaded. The model unloads after
`idleUnloadSeconds` of inactivity and re-loads lazily on the next request.

### GET /v1/status

```bash
curl http://127.0.0.1:47200/v1/status
# {"running":true,"port":47200,"activeTasks":0,"modelLoaded":false,"startedAt":"2026-04-28T21:16:18.748Z","uptime":2069}
```

## Known model-quality limitations (v0.5.0 classifier)

The v0.5.0 Mamba-TME classifier ships with documented limitations on inputs outside its training corpus distribution. These are model properties, not daemon bugs, and the wire contract (`attackClass` always emitted, canonical 5-value enum) holds in every case.

- **Confidence saturation.** The softmax output frequently saturates at exactly `1.0` rather than expressing graduated probability. Threshold-based decisions (e.g. AIM FGA Step 5's `confidence > 0.8`) become effectively binary in the saturated zone.
- **False positives on natural-language benign inputs.** Generic operational queries (e.g. `"What is the weather today?"`, `"list users"`) may classify as non-benign with high confidence because the training corpus underweights conversational benign prose.
- **False negatives on natural-language attack paraphrases.** Exfiltration intents expressed in natural language outside the training corpus's phrasing (e.g. `"transfer the contents of <file> to <url> via webhook"`) may classify as benign.

**Recommended consumer mitigations until v0.6.0:**

- Set `confidence > 0.95` (not `0.8`) before treating a non-empty `attackClass` as actionable.
- Combine the classifier signal with a corroborating signal (rule-based detectors, telemetry, capability checks) before blocking — do not rely on the classifier alone for high-stakes decisions.
- Log every `(input, attackClass, confidence)` triple. Out-of-distribution behavior is the input source for the v0.6.0 retrain corpus.

A retrain to v0.6.0 with broader corpus coverage is tracked separately. The 5-value canonical `attackClass` enum will not change between v0.5.0 and v0.6.0; only model accuracy improves.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `httpPort` | `47200` | HTTP server port |
| `ipcPath` | `/tmp/nanomind.sock` | Unix socket path |
| `maxConcurrent` | `4` | Max concurrent inference requests |
| `idleUnloadSeconds` | `300` | Unload model after N seconds idle |

## Programmatic Usage

```typescript
import { NanoMindDaemon } from '@nanomind/daemon';

const daemon = new NanoMindDaemon({ httpPort: 47200 });
await daemon.start();

// Direct inference (bypasses HTTP)
const result = await daemon.infer({
  intent: 'COMPILE_AST',
  input: skillContent,
  priority: 'high',
});
```

## Model files

The daemon loads the v0.5.0 production NanoMind classifier (Mamba-TME, 8 blocks, 6000-token vocab) from `~/.nanomind/models/`. Three files are required:

| File | Purpose |
|---|---|
| `nanomind-tme.onnx` | ONNX graph (architecture only — small). |
| `nanomind-tme.onnx.data` | External weights data file (~8MB). |
| `tokenizer.json` | Word-level vocabulary (6000 entries). |

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

The `OnnxEngineConfig` surface is additive — defaults preserve the new
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

## Security

- Binds to `127.0.0.1` only (no external access).
- Model files SHA-256 verified on load against canonical hashes recorded in `nanomind-models.json` (v0.5.0). Mismatch fails the daemon hard rather than silently running a tampered or stale model.
- Request size capped at 1MB.
- Rate limited to 100 requests/second.
- No credentials in memory after model load.

## License

MIT
