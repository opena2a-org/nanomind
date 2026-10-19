# @nanomind/engine

Core inference backend for NanoMind. It wraps llamafile for local LLM inference.

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
console.log(result.latencyMs); // how long this call took, in milliseconds
```

No timing figure is given here. How long a call takes depends on the machine and the llamafile build it runs on, and no measurement is recorded that would hold on yours. `infer()` times each call itself and returns that time in `latencyMs`, measured on the machine the call ran on. It labels the result's `tier` as `local-fast` or `local-full` from that same measured time.

## Model

Uses SmolLM2-135M (Q4_K_M quantization, ~80MB). The engine does not download the model or llamafile; both must be on disk before the first call. By default `infer()` looks for the model at `~/.nanomind/models/SmolLM2-135M.Q4_K_M.gguf` and for the llamafile at `~/.nanomind/bin/llamafile`. Pass `modelPath` and `llamafilePath` to the constructor to use other paths. If the llamafile or the model is missing, `infer()` rejects with an error that names the path it checked.

## License

Apache-2.0
