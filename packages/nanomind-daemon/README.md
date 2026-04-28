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

Response:

```json
{
  "intent": "SCAN_SKILL",
  "result": "malicious",
  "confidence": 0.92,
  "attackClass": "exfiltration_pattern",
  "evidence": "forwards tokens to an external endpoint",
  "remediation": "Remove external data forwarding. Use declared API endpoints only.",
  "latencyMs": 3,
  "modelVersion": "nanomind-tme-v1"
}
```

Default response (no malicious intent detected — also today's response for every input until the production classifier ships):

```json
{
  "intent": "INTENT_CHECK",
  "result": "...",
  "confidence": 0.85,
  "attackClass": "",
  "latencyMs": 612,
  "modelVersion": "SmolLM2-135M-Q4_K_M"
}
```

### Response schema

| Field | Type | Required | Description |
|---|---|---|---|
| `intent` | string | yes | Echoes the request intent (or routed intent if not provided). |
| `result` | string | yes | Raw model output text. |
| `confidence` | number | yes | Confidence score in [0, 1]. |
| `attackClass` | string | yes | Canonical attack-class label, or empty string. See enum below. |
| `evidence` | string | no | Free-form evidence excerpt when the classifier flags a finding. |
| `remediation` | string | no | Suggested remediation text. |
| `latencyMs` | number | yes | End-to-end inference latency in milliseconds. |
| `modelVersion` | string | yes | Loaded model identifier. |

### `attackClass` enum

The field is always emitted. An empty string means "no malicious intent detected" — that is what every response carries today, because the production classifier is not yet wired into this daemon. Non-empty values land when that work ships:

| Value | Meaning |
|---|---|
| `""` | No malicious intent detected (also: classifier not yet wired). |
| `"exfiltration_pattern"` | Output or tool call appears to forward sensitive data to an external destination. |
| `"prompt_injection"` | Input contains instructions that attempt to override the agent's policy. |
| `"tool_misuse"` | Capability or tool used outside its declared purpose. |
| `"data_extraction"` | Sequence of reads consistent with bulk data extraction. |

### FGA contract

AIM's FGA Step 5 (`fga_engine.go::checkIntentSync`) reads this response and blocks when:

```
attackClass != "" && confidence > 0.8
```

So an empty `attackClass` is fail-open by design — the wire contract is required (the field is always present), the *value* defaults to empty until the classifier produces real labels.

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

## Security

- Binds to `127.0.0.1` only (no external access)
- Model file integrity verified on load (SHA-256)
- Request size capped at 1MB
- Rate limited to 100 requests/second
- No credentials in memory after model load

## License

MIT
