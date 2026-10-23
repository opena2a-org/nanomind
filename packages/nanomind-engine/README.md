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

By default the engine runs SmolLM2-135M (Q4_K_M quantization) with llamafile 0.8.13. It reads the model from `~/.nanomind/models/SmolLM2-135M.Q4_K_M.gguf` and runs the llamafile at `~/.nanomind/bin/llamafile`. Pass `modelPath` and `llamafilePath` to the constructor to use other paths.

When either file is missing, the first `infer()` call downloads it to its path from a pinned URL:

| File | Source | Size |
|------|--------|------|
| llamafile | `llamafile-0.8.13` from the [mozilla-ai/llamafile 0.8.13 release](https://github.com/mozilla-ai/llamafile/releases/tag/0.8.13) | 241,352,637 bytes |
| Model | `SmolLM2-135M-Q4_K_M.gguf` from [ggml-org/SmolLM2-135M-GGUF](https://huggingface.co/ggml-org/SmolLM2-135M-GGUF) at a fixed commit | 101,016,128 bytes |

The download goes to a new file beside the path. That file is moved to the path only when its size and SHA-256 match the pinned ones; otherwise it is deleted and `infer()` rejects with an error that names the URL, the path and what went wrong. A process that ends during a download, on Ctrl+C for example, leaves that file behind. Its name holds the ID of the process that wrote it, and the next download to the same path deletes it unless a process other than the one downloading runs with that ID. The engine prints one line to stderr before and after each download, and `latencyMs` does not count the download. A file already at its path is used as it is. `nanomind setup`, from `@nanomind/cli`, downloads both files to the default paths before the first call.

Pass `noAutoDownload: true` to download nothing: a missing file then makes `infer()` reject with an error that names the path it checked. Only the boolean `true` does this: the strings `'true'` and `'false'` and the numbers `1` and `0` leave the download on, so convert a value read from an environment variable to a boolean first. To download from a mirror, pass `llamafileDownload` or `modelDownload` with the file's `url`, `sha256` and `size`, for example `{ ...MODEL_DOWNLOAD, url: 'https://mirror.example/SmolLM2-135M-Q4_K_M.gguf' }`. The engine exports `LLAMAFILE_DOWNLOAD` and `MODEL_DOWNLOAD` with the pinned values.

## License

Apache-2.0
