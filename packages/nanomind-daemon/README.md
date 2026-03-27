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
  "attackClass": "exfiltration",
  "evidence": "forwards tokens to an external endpoint",
  "remediation": "Remove external data forwarding. Use declared API endpoints only.",
  "latencyMs": 3,
  "modelVersion": "nanomind-tme-v1"
}
```

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
