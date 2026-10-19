/**
 * Downloads the llamafile and the model that @nanomind/engine runs, from
 * pinned URLs, and checks the size and SHA-256 of each download before it is
 * moved into place.
 *
 * @nanomind/cli depends on a published @nanomind/engine, so `nanomind setup`
 * cannot import this file from the engine. The same file is in both packages,
 * as packages/nanomind-engine/src/download.ts and
 * packages/nanomind-cli/src/download.ts, and test/download-copies.test.mjs
 * fails when the two differ.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A file to download: where it comes from, and the size and SHA-256 it must have. */
export interface DownloadSource {
  /** The URL to fetch. Redirects are followed. */
  url: string;
  /** SHA-256 of the file, as 64 lowercase hex digits. */
  sha256: string;
  /** Size of the file in bytes. */
  size: number;
}

/** llamafile 0.8.13: the llamafile-0.8.13 asset of that mozilla-ai/llamafile release. */
export const LLAMAFILE_DOWNLOAD: Readonly<DownloadSource> = Object.freeze({
  url: 'https://github.com/mozilla-ai/llamafile/releases/download/0.8.13/llamafile-0.8.13',
  sha256: 'd0a2b5c6a665ba34e23ef5107b009a3b0e9c290e317a23cf4d2cc7e9692a181e',
  size: 241352637,
});

/** SmolLM2-135M, Q4_K_M quantization, from ggml-org/SmolLM2-135M-GGUF at a fixed commit. */
export const MODEL_DOWNLOAD: Readonly<DownloadSource> = Object.freeze({
  url: 'https://huggingface.co/ggml-org/SmolLM2-135M-GGUF/resolve/44686446221a479a9227d7a895cf92930f86de8a/SmolLM2-135M-Q4_K_M.gguf',
  sha256: 'e3131339bf4e8065265593d4fd8f7bb7ff2d3abff1edb5618aa1197b89cad9f5',
  size: 101016128,
});

/** The path the engine runs the llamafile from when it is given none. */
export function defaultLlamafilePath(home: string = homedir()): string {
  return join(home, '.nanomind', 'bin', 'llamafile');
}

/** The path the engine reads the model from when it is given none. */
export function defaultModelPath(home: string = homedir()): string {
  return join(home, '.nanomind', 'models', 'SmolLM2-135M.Q4_K_M.gguf');
}

/** SHA-256 of the file at `path`, as lowercase hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Download `source` to `path`, creating its directory when it is missing. The
 * bytes go to a new file beside `path`, created with permission `mode`. That
 * file is read back and renamed to `path` only when it holds `source.size`
 * bytes with SHA-256 `source.sha256`; otherwise it is deleted and the call
 * rejects, so a failed download leaves nothing at `path`. Resolves to the size
 * of the file.
 */
export async function downloadVerified(source: DownloadSource, path: string, mode: number): Promise<number> {
  const partial = `${path}.${randomBytes(6).toString('hex')}.part`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(partial, 'wx', mode);
    await fetchInto(source, file).finally(() => file.close());
    // Checked on disk, so a write that fell short fails the checks too.
    const { size } = await stat(partial);
    if (size !== source.size) {
      throw new Error(`it is ${size} bytes, and ${source.size} are pinned for it`);
    }
    const sha256 = await sha256File(partial);
    if (sha256 !== source.sha256) {
      throw new Error(`its SHA-256 is ${sha256}, and ${source.sha256} is pinned for it`);
    }
    await rename(partial, path);
    return size;
  } catch (error) {
    // When the file was never created, removing it fails too (ENOTDIR, for
    // one); the error to report is the first.
    await rm(partial, { force: true }).catch(() => undefined);
    throw new Error(`Could not download ${source.url} to ${path}: ${reason(error)}`);
  }
}

// Writes the body of source.url to `file`, stopping once it runs past source.size.
async function fetchInto(source: DownloadSource, file: FileHandle): Promise<void> {
  const response = await fetch(source.url);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`the server answered HTTP ${response.status}`);
  }
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > source.size) {
      throw new Error(`the server sent more than the ${source.size} bytes pinned for it`);
    }
    await file.write(chunk);
  }
}

// fetch rejects with "fetch failed" and keeps what went wrong in `cause`.
function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { message?: string; code?: string } | undefined;
  const detail = cause?.message || cause?.code;
  return detail ? `${error.message} (${detail})` : error.message;
}
