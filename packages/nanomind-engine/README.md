# @nanomind/engine

Core inference backend for NanoMind — wraps llamafile for local LLM inference.

## Install

```bash
npm install @nanomind/engine
```

## Usage

```typescript
import { NanoMindEngine } from '@nanomind/engine';

const engine = new NanoMindEngine();
const result = await engine.infer('Classify: scan this project');
console.log(result.text); // "SCAN"
console.log(result.latencyMs); // ~200ms
```

## Model

Uses SmolLM2-135M (Q4_K_M quantization, ~80MB). Downloaded on first use via `nanomind setup`.

## License

MIT
