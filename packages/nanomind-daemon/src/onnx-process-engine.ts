/**
 * @nanomind/daemon — ONNX classifier in a child process
 *
 * `OnnxProcessEngine` runs `OnnxEngine` in a process of its own (see
 * onnx-host.mts) and forwards `infer()` calls to it over the IPC channel.
 * `unload()` ends that process, so an idle unload gives the model's memory
 * back to the operating system. An `OnnxEngine` inside the daemon process
 * releases its session on unload, but on macOS the process keeps the pages,
 * and each reload adds to them.
 *
 * This module does not load onnxruntime-node. An error the host raises while
 * loading the model or running inference arrives here as an Error carrying
 * the text `errorMessage()` gives for it.
 */

import { fork, type ChildProcess } from 'node:child_process';
import type { DownloadProgressEvent, OnnxEngineConfig, OnnxInferResult } from './onnx-engine.ts';
import type { HostConfig, HostMessage, ParentMessage } from './onnx-host.mts';
import { HOST_ARG, ONNX_HOST_PATH } from './onnx-host-path.cts';

// The Node flags a host keeps from this process: preloads (a test stubs the
// download with one), type stripping (which runs onnx-host.mts from source)
// and warning output. fork() would otherwise pass every flag on, and with
// `-e <script>` the host runs that script instead of onnx-host, while
// `--inspect-brk` makes it wait for a debugger.
const HOST_FLAGS_WITH_VALUE = new Set(['-r', '--require', '--import']);
const HOST_FLAG = /^(--(require|import)=.|--(no-)?experimental-(strip|transform)-types$|--no-warnings$|--no-deprecation$)/;

export function hostExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    if (HOST_FLAGS_WITH_VALUE.has(execArgv[i])) {
      if (i + 1 < execArgv.length) kept.push(execArgv[i], execArgv[i + 1]);
      i++;
    } else if (HOST_FLAG.test(execArgv[i])) {
      kept.push(execArgv[i]);
    }
  }
  return kept;
}

interface PendingInfer {
  host: ChildProcess;
  resolve: (result: OnnxInferResult) => void;
  reject: (err: Error) => void;
}

export class OnnxProcessEngine {
  private readonly hostConfig: HostConfig;
  private readonly onDownloadProgress: ((event: DownloadProgressEvent) => void) | undefined;
  private host: ChildProcess | null = null;
  private loading: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingInfer>();
  private nextId = 1;
  private loadedVersion: string | undefined;

  /**
   * Takes the `OnnxEngine` settings. Without `onDownloadProgress` the host
   * prints download progress to the stderr it shares with this process.
   */
  constructor(config: OnnxEngineConfig = {}) {
    const { onDownloadProgress, ...engineConfig } = config;
    this.onDownloadProgress = onDownloadProgress;
    this.hostConfig = { ...engineConfig, relayProgress: onDownloadProgress !== undefined };
  }

  /** The version the host reported when it last loaded the model. */
  get modelVersion(): string | undefined {
    return this.loadedVersion;
  }

  /** Process id of the model host while one runs, otherwise null. */
  get hostPid(): number | null {
    return this.host?.pid ?? null;
  }

  isLoaded(): boolean {
    return this.host !== null && this.loading === null;
  }

  /** Starts a model host unless one is running or starting. */
  ensureReady(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.host) return Promise.resolve();
    this.loading = this.startHost().finally(() => {
      this.loading = null;
      this.updateRef();
    });
    return this.loading;
  }

  /**
   * Ends the model host and waits for it to exit. A no-op when none runs.
   * An `infer()` still waiting on that host rejects.
   */
  async unload(): Promise<void> {
    const host = this.host;
    this.host = null;
    if (host) await stopHost(host);
  }

  async infer(text: string, _opts?: unknown): Promise<OnnxInferResult> {
    await this.ensureReady();
    const host = this.host;
    if (!host) throw new Error('NanoMind model was unloaded before inference ran');
    return new Promise<OnnxInferResult>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { host, resolve, reject });
      this.updateRef();
      const message: ParentMessage = { type: 'infer', id, text };
      host.send(message, (err) => {
        if (err) this.settle(id, (entry) => entry.reject(err));
      });
    });
  }

  private startHost(): Promise<void> {
    const host = fork(ONNX_HOST_PATH, [HOST_ARG, JSON.stringify(this.hostConfig)], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: hostExecArgv(process.execArgv),
      // Structured clone rather than JSON, so a result arrives with the
      // values the host computed (a NaN confidence stays NaN).
      serialization: 'advanced',
    });
    this.host = host;
    return new Promise<void>((resolve, reject) => {
      let loaded = false;
      const fail = (err: Error): void => {
        if (this.host === host) this.host = null;
        for (const [id, entry] of this.pending) {
          if (entry.host === host) this.settle(id, (e) => e.reject(err));
        }
        if (!loaded) {
          loaded = true;
          reject(err);
        }
      };

      host.on('message', (message: HostMessage) => {
        switch (message.type) {
          case 'ready':
            this.loadedVersion = message.modelVersion;
            loaded = true;
            resolve();
            break;
          case 'load_error':
            fail(new Error(message.message));
            void stopHost(host);
            break;
          case 'progress':
            this.onDownloadProgress?.(message.event);
            break;
          case 'result':
            this.settle(message.id, (entry) => entry.resolve(message.result));
            break;
          case 'infer_error':
            this.settle(message.id, (entry) => entry.reject(new Error(message.message)));
            break;
        }
      });
      // 'error' covers a host that could not be started; 'exit' a host that
      // ended, whether unloaded or not.
      host.on('error', (err) => fail(err));
      host.on('exit', (code, signal) => {
        const how = code !== null ? `exit code ${code}` : `signal ${signal}`;
        fail(new Error(`NanoMind model host process ended (${how})`));
      });
    });
  }

  private settle(id: number, action: (entry: PendingInfer) => void): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.updateRef();
    action(entry);
  }

  // The host keeps this process open only while it loads or answers a
  // request, so a script that calls infer() exits when its work is done.
  private updateRef(): void {
    const host = this.host;
    if (!host) return;
    let busy = this.loading !== null;
    for (const entry of this.pending.values()) busy ||= entry.host === host;
    if (busy) {
      host.ref();
      host.channel?.ref();
    } else {
      host.unref();
      host.channel?.unref();
    }
  }
}

function stopHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    host.once('exit', () => resolve());
    // Keeps this process open until the host has gone.
    host.ref();
    host.kill();
  });
}
