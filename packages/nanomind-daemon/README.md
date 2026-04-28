# @nanomind/daemon

Persistent NanoMind inference server. Runs on `localhost:47200` with HTTP and Unix socket interfaces. Lazy-loads the model on first request, unloads after idle timeout.

## Install

```bash
npm install @nanomind/daemon
```

## Quick Start

```bash
# Start the daemon
nanomind-daemon start

# Check status
nanomind-daemon status

# Stop
nanomind-daemon stop
```

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
  "evidence": "benign",
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
| `attackClass` | string | yes | Canonical attack-class label, or empty string. See enum + mapping below. |
| `evidence` | string | no | Raw 10-way model label. Carries audit-trail granularity beyond the canonical bucket. |
| `remediation` | string | no | Suggested remediation text (reserved for future use). |
| `latencyMs` | number | yes | End-to-end inference latency in milliseconds. |
| `modelVersion` | string | yes | Loaded model identifier. |

### `attackClass` enum

The field is always emitted. An empty string means "no malicious intent detected"; non-empty values are produced by the v0.5.0 production classifier:

| Value | Meaning |
|---|---|
| `""` | No malicious intent detected (model classified as `benign`). |
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

### FGA contract

AIM's FGA Step 5 (`fga_engine.go::checkIntentSync`) reads this response and blocks when:

```
attackClass != "" && confidence > 0.8
```

The wire contract is required (the field is always present); the *value* is empty when the model classifies the request as benign and non-empty otherwise. Consumers needing 10-way granularity (e.g. dashboards, runtime correlation) read the raw label from `evidence`.

### GET /v1/health

```bash
curl http://127.0.0.1:47200/v1/health
# {"status":"ok","modelLoaded":true,"uptime":3600}
```

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

Download from HuggingFace (`opena2a/nanomind-security-classifier`):

```bash
mkdir -p ~/.nanomind/models
cd ~/.nanomind/models
BASE=https://huggingface.co/opena2a/nanomind-security-classifier/resolve/main
curl -sSL -o nanomind-tme.onnx        "$BASE/nanomind-tme.onnx"
curl -sSL -o nanomind-tme.onnx.data   "$BASE/nanomind-tme.onnx.data"
curl -sSL -o tokenizer.json           "$BASE/tokenizer.json"
```

## Security

- Binds to `127.0.0.1` only (no external access).
- Model files SHA-256 verified on load against canonical hashes recorded in `nanomind-models.json` (v0.5.0). Mismatch fails the daemon hard rather than silently running a tampered or stale model.
- Request size capped at 1MB.
- Rate limited to 100 requests/second.
- No credentials in memory after model load.

## License

MIT
