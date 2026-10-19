import type { DownloadProgressEvent, OnnxEngineConfig, OnnxInferResult } from './onnx-engine.ts';
import { errorMessage } from './error-message.ts';
import { HOST_ARG } from './onnx-host-path.cts';

/**
 * The process `OnnxProcessEngine` runs the classifier in. The engine forks
 * this file, and the host loads the model with `OnnxEngine`: the download,
 * the SHA-256 check, the vocabulary and the ORT session all happen here, so
 * every buffer they allocate belongs to this process. Unloading the model
 * ends the process, and the operating system takes back its memory. Releasing
 * an ORT session inside a long-lived process does not: the allocator keeps
 * the freed pages.
 *
 * This module is .mts, so it is ESM in both runtimes. The daemon process
 * imports only its types: onnx-host-path.cts names the file to fork, and
 * onnxruntime-node loads in the forked process alone.
 */

/** `OnnxEngineConfig` without the callback, which cannot cross processes. */
export type HostConfig = Omit<OnnxEngineConfig, 'onDownloadProgress'> & {
  /** Send download progress to the parent instead of printing it here. */
  relayProgress: boolean;
};

export type ParentMessage = { type: 'infer'; id: number; text: string };

export type HostMessage =
  | { type: 'ready'; modelVersion: string }
  | { type: 'load_error'; message: string }
  | { type: 'progress'; event: DownloadProgressEvent }
  | { type: 'result'; id: number; result: OnnxInferResult }
  | { type: 'infer_error'; id: number; message: string };

function serve(config: HostConfig): void {
  const send = (message: HostMessage): void => {
    process.send?.(message);
  };
  // The parent owns this process. Its channel closes when it unloads the
  // model, stops or exits, and the host exits with it.
  process.on('disconnect', () => process.exit(0));

  const { relayProgress, ...engineConfig } = config;
  // Registered before the model module loads, so no message is missed.
  const ready = import('./onnx-engine.ts').then(async ({ OnnxEngine }) => {
    const engine = new OnnxEngine({
      ...engineConfig,
      ...(relayProgress ? { onDownloadProgress: (event: DownloadProgressEvent) => send({ type: 'progress', event }) } : {}),
    });
    await engine.ensureReady();
    return engine;
  });
  ready.then(
    (engine) => send({ type: 'ready', modelVersion: engine.modelVersion }),
    (err) => send({ type: 'load_error', message: errorMessage(err) }),
  );

  process.on('message', (message: ParentMessage) => {
    if (message?.type !== 'infer') return;
    ready
      .then((engine) => engine.infer(message.text))
      .then(
        (result) => send({ type: 'result', id: message.id, result }),
        (err) => send({ type: 'infer_error', id: message.id, message: errorMessage(err) }),
      );
  });
}

if (process.argv[2] === HOST_ARG && typeof process.send === 'function') {
  serve(JSON.parse(process.argv[3] ?? '{}') as HostConfig);
}
