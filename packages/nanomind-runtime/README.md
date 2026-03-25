# @nanomind/runtime

NanoMind Runtime — behavioral twin for AI agent anomaly detection. The L1 layer of ARP's three-tier protection model.

## Install

```bash
npm install @nanomind/runtime
```

## Usage

```typescript
import { NanoMindRuntime } from '@nanomind/runtime';

const runtime = new NanoMindRuntime('my-agent');
await runtime.initialize();

// Process behavioral events
const result = runtime.processEvent({
  agentId: 'my-agent',
  eventType: 'TOOL_CALL',
  capability: 'db:read',
  timestampDelta: 50,
  // ...
});

console.log(result.score);  // 0.0 (normal) to 1.0 (anomalous)
console.log(result.action); // 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill'
```

## How It Works

1. **Baseline learning**: First 100 events build a behavioral baseline
2. **Anomaly scoring**: 6 factors — unknown capability, timing anomaly, burst detection, L0 escalation, rare event type, error spike
3. **Sub-2ms latency**: No LLM — statistical model only
4. **Federated learning**: Gradients submitted with differential privacy

## Three-Tier ARP Model

| Tier | Layer | Latency | What |
|------|-------|---------|------|
| L0 | Rule-based | μs | Capability enforcement |
| **L1** | **NanoMind-Runtime** | **ms** | **Behavioral anomaly detection** |
| L2 | Fleet intelligence | continuous | Federated model improvement |

## License

MIT
