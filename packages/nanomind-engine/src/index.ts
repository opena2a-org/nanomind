/**
 * @nanomind/engine — Core inference backend
 *
 * Wraps llamafile for local LLM inference. When the llamafile or the model is
 * missing, the first call downloads it from a pinned URL and checks its size
 * and SHA-256 before it runs (see ensureReady and download.ts).
 * Target model: SmolLM2-135M (Q4_K_M quantization)
 *
 * Inference tiers:
 *   - Local Fast and Local Full: SmolLM2-135M via llamafile. infer() times each
 *     call, returns the time as latencyMs and labels the result local-fast or
 *     local-full from it, so the label says how long the call took on this
 *     machine, not a mode the caller selects. No duration is stated here: it
 *     depends on the host and the llamafile build.
 *   - Cloud Fallback: Anthropic API (only when local model unavailable)
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  LLAMAFILE_DOWNLOAD,
  MODEL_DOWNLOAD,
  defaultLlamafilePath,
  defaultModelPath,
  downloadVerified,
  sha256File,
  type DownloadSource,
} from './download.ts';

export { LLAMAFILE_DOWNLOAD, MODEL_DOWNLOAD, type DownloadSource } from './download.ts';

export interface InferenceResult {
  text: string;
  tokensUsed: number;
  latencyMs: number;
  tier: 'local-fast' | 'local-full' | 'cloud-fallback';
}

export interface EngineConfig {
  modelPath?: string;
  llamafilePath?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Where a missing llamafile is downloaded from. Defaults to LLAMAFILE_DOWNLOAD. */
  llamafileDownload?: DownloadSource;
  /** Where a missing model is downloaded from. Defaults to MODEL_DOWNLOAD. */
  modelDownload?: DownloadSource;
  /** Set to true to download nothing: a missing file then makes infer() reject. */
  noAutoDownload?: boolean;
}

export class NanoMindEngine {
  private config: Required<EngineConfig>;
  private ready = false;
  private preparing: Promise<void> | null = null;

  constructor(config: EngineConfig = {}) {
    this.config = {
      modelPath: config.modelPath ?? defaultModelPath(),
      llamafilePath: config.llamafilePath ?? defaultLlamafilePath(),
      maxTokens: config.maxTokens ?? 256,
      temperature: config.temperature ?? 0.1,
      topP: config.topP ?? 0.9,
      llamafileDownload: config.llamafileDownload ?? LLAMAFILE_DOWNLOAD,
      modelDownload: config.modelDownload ?? MODEL_DOWNLOAD,
      noAutoDownload: config.noAutoDownload ?? false,
    };
  }

  /**
   * Check if the engine is ready (model + llamafile on disk).
   */
  async isReady(): Promise<boolean> {
    if (this.ready) return true;
    this.ready =
      existsSync(this.config.modelPath) &&
      existsSync(this.config.llamafilePath);
    return this.ready;
  }

  /**
   * Make sure the llamafile and the model are on disk. infer() calls this
   * before it runs the llamafile. A file already on disk is used as it is. A
   * missing file is downloaded to its path from llamafileDownload or
   * modelDownload, and moved there only once its size and SHA-256 match (see
   * downloadVerified); one line goes to stderr before and after each download.
   * Calls made while a download runs wait for that download. With
   * noAutoDownload, a missing file is not downloaded: this throws an error
   * that names the path it checked.
   */
  async ensureReady(): Promise<void> {
    if (await this.isReady()) return;
    this.preparing ??= this.prepare().finally(() => {
      this.preparing = null;
    });
    await this.preparing;
  }

  private async prepare(): Promise<void> {
    const files = [
      {
        name: 'the llamafile',
        notFound: 'llamafile not found',
        path: this.config.llamafilePath,
        source: this.config.llamafileDownload,
        mode: 0o755,
        fix: 'put an executable llamafile at that path, pass llamafilePath to the NanoMindEngine constructor',
      },
      {
        name: 'the model',
        notFound: 'Model not found',
        path: this.config.modelPath,
        source: this.config.modelDownload,
        mode: 0o644,
        fix: 'put a GGUF model file at that path, pass modelPath to the NanoMindEngine constructor',
      },
    ];

    for (const file of files) {
      if (existsSync(file.path)) continue;
      if (this.config.noAutoDownload) {
        throw new Error(
          `${file.notFound} at ${file.path}. noAutoDownload is set, so the engine does not download it: ` +
            `${file.fix}, or leave noAutoDownload unset.`,
        );
      }
      process.stderr.write(
        `NanoMind: downloading ${file.name} (${file.source.size} bytes) from ${file.source.url} to ${file.path}\n`,
      );
      await downloadVerified(file.source, file.path, file.mode);
      process.stderr.write(`NanoMind: saved ${file.path}, SHA-256 verified\n`);
    }

    this.ready = true;
  }

  /**
   * Run inference with the local model. The time it takes to download a
   * missing file is not part of latencyMs.
   */
  async infer(prompt: string, options?: Partial<EngineConfig>): Promise<InferenceResult> {
    await this.ensureReady();

    const start = Date.now();
    const maxTokens = options?.maxTokens ?? this.config.maxTokens;
    const temperature = options?.temperature ?? this.config.temperature;

    return new Promise((resolve, reject) => {
      const args = [
        '-m', this.config.modelPath,
        '--temp', temperature.toString(),
        '-n', maxTokens.toString(),
        '-p', prompt,
        '--no-display-prompt',
        '--log-disable',
      ];

      execFile(this.config.llamafilePath, args, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Inference failed: ${error.message}`));
          return;
        }

        const text = stdout.trim();
        const latencyMs = Date.now() - start;

        resolve({
          text,
          tokensUsed: Math.ceil(text.length / 4), // rough estimate
          latencyMs,
          tier: latencyMs < 100 ? 'local-fast' : 'local-full',
        });
      });
    });
  }

  /**
   * Classify text into one of the given categories.
   * Uses a constrained prompt for fast intent classification.
   */
  async classify(text: string, categories: string[]): Promise<{ category: string; confidence: number }> {
    const prompt = `Classify the following into exactly one category.
Categories: ${categories.join(', ')}
Input: "${text}"
Category:`;

    const result = await this.infer(prompt, { maxTokens: 20, temperature: 0.0 });
    const predicted = result.text.trim().split('\n')[0].trim();

    // Find best matching category
    const match = categories.find(c =>
      predicted.toLowerCase().includes(c.toLowerCase())
    ) ?? categories[0];

    return { category: match, confidence: 0.8 };
  }

  /**
   * Get the model file path.
   */
  getModelPath(): string {
    return this.config.modelPath;
  }

  /**
   * Compute SHA-256 hash of a file (for integrity verification).
   */
  static async computeFileHash(filePath: string): Promise<string> {
    return sha256File(filePath);
  }
}

export default NanoMindEngine;
