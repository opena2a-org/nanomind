import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OnnxEngine, type DownloadProgressEvent } from './onnx-engine.ts';

/**
 * These tests cover the auto-download path added in the
 * "daemon: auto-download model on first start" change. They use a
 * local HTTP server as the upstream so the suite stays offline-safe
 * (CI without internet still passes) and stand up bytes whose SHA-256
 * matches what the engine expects only when we want it to.
 *
 * The model artifacts themselves are NOT exercised here — the engine's
 * existing tokenizer / inference tests already cover that path with
 * real fixtures. These tests cover the streaming download, redirect
 * following, integrity verification, and the `.part`-rename pattern.
 */

// SHA-256 hashes the engine already enforces for v0.5.0. We can't
// generate matching artifacts in a unit test (the bytes ARE the model),
// so we use `skipIntegrityCheck` for these test fixtures and assert
// the download flow on its own. A separate test exercises the
// hash-mismatch failure path against EXPECTED_SHA256 by serving a
// known-bad payload that doesn't hash to the expected SHA.

const ONNX_FILE = 'nanomind-tme.onnx';
const ONNX_DATA_FILE = 'nanomind-tme.onnx.data';
const TOKENIZER_FILE = 'tokenizer.json';

// Bytes that do not hash to the pinned SHA-256 of any of the three files.
// The tokenizer is still valid JSON with the two tokens the engine requires,
// so an engine that skips both checks gets as far as onnxruntime.
const MISMATCHED_FILES: ReadonlyArray<readonly [string, Buffer]> = [
  [ONNX_FILE, Buffer.from('not-the-pinned-onnx')],
  [ONNX_DATA_FILE, Buffer.from('not-the-pinned-data')],
  [TOKENIZER_FILE, Buffer.from(JSON.stringify({ '<PAD>': 0, '<UNK>': 1 }), 'utf-8')],
];

interface MockUpstream {
  port: number;
  baseUrl: string;
  served: Map<string, Buffer>;
  fail: Set<string>;
  redirect: Map<string, string>;
  close: () => Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const served = new Map<string, Buffer>();
  const fail = new Set<string>();
  const redirect = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (fail.has(url)) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (redirect.has(url)) {
      res.writeHead(302, { Location: redirect.get(url)! });
      res.end();
      return;
    }
    const body = served.get(url);
    if (!body) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    served,
    fail,
    redirect,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

describe('OnnxEngine auto-download', () => {
  let upstream: MockUpstream;
  let modelDir: string;

  before(async () => {
    upstream = await startMockUpstream();
  });
  after(async () => {
    await upstream.close();
  });

  beforeEach(async () => {
    modelDir = await mkdtemp(join(tmpdir(), 'nanomind-engine-test-'));
    upstream.served.clear();
    upstream.fail.clear();
    upstream.redirect.clear();
  });
  afterEach(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  it('downloads all three missing files when auto-download is enabled', async () => {
    const tokenizerBody = JSON.stringify({ '<PAD>': 0, '<UNK>': 1 });
    upstream.served.set(`/${ONNX_FILE}`, Buffer.from('fake-onnx-bytes'));
    upstream.served.set(`/${ONNX_DATA_FILE}`, Buffer.from('fake-data-bytes'));
    upstream.served.set(`/${TOKENIZER_FILE}`, Buffer.from(tokenizerBody, 'utf-8'));

    const events: DownloadProgressEvent[] = [];
    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      skipIntegrityCheck: true,
      onDownloadProgress: (e) => events.push(e),
    });

    // ensureReady downloads then errors at session.create because the
    // fake onnx isn't a real model. We only care that the download phase
    // ran to completion, so catch the downstream error.
    await engine.ensureReady().catch((err) => {
      // Acceptable: onnxruntime rejects the fake bytes. Any other
      // error means the download itself failed.
      assert.ok(
        /onnx|InferenceSession|invalid|protobuf|magic/i.test(String(err)),
        `unexpected pre-onnx error: ${err}`,
      );
    });

    assert.ok(existsSync(join(modelDir, ONNX_FILE)), 'onnx file should be staged');
    assert.ok(existsSync(join(modelDir, ONNX_DATA_FILE)), 'onnx data file should be staged');
    assert.ok(existsSync(join(modelDir, TOKENIZER_FILE)), 'tokenizer should be staged');

    // Verify the progress events covered start + done for each file.
    const startedFiles = events.filter((e) => e.phase === 'start').map((e) => e.file).sort();
    assert.deepEqual(startedFiles, [ONNX_FILE, ONNX_DATA_FILE, TOKENIZER_FILE].sort());
    const doneFiles = events.filter((e) => e.phase === 'done').map((e) => e.file).sort();
    assert.deepEqual(doneFiles, [ONNX_FILE, ONNX_DATA_FILE, TOKENIZER_FILE].sort());
  });

  it('respects noAutoDownload and throws the original "not found" error', async () => {
    const engine = new OnnxEngine({
      modelDir,
      noAutoDownload: true,
      downloadBaseUrl: upstream.baseUrl,
      onDownloadProgress: () => undefined,
    });

    await assert.rejects(engine.ensureReady(), (err: Error) => {
      assert.match(err.message, /not found at/);
      assert.match(err.message, /Auto-download is disabled/);
      return true;
    });

    assert.ok(!existsSync(join(modelDir, ONNX_FILE)), 'should not have downloaded');
  });

  it('skips download for files already present', async () => {
    const tokenizerBody = JSON.stringify({ '<PAD>': 0, '<UNK>': 1 });
    await writeFile(join(modelDir, ONNX_FILE), Buffer.from('preexisting-onnx'));
    await writeFile(join(modelDir, ONNX_DATA_FILE), Buffer.from('preexisting-data'));
    await writeFile(join(modelDir, TOKENIZER_FILE), Buffer.from(tokenizerBody, 'utf-8'));

    const events: DownloadProgressEvent[] = [];
    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      skipIntegrityCheck: true,
      onDownloadProgress: (e) => events.push(e),
    });

    await engine.ensureReady().catch(() => undefined); // accept downstream onnx failure

    const startedFiles = events.filter((e) => e.phase === 'start');
    assert.equal(startedFiles.length, 0, 'no downloads should have started');

    const onnxBytes = await readFile(join(modelDir, ONNX_FILE));
    assert.equal(onnxBytes.toString(), 'preexisting-onnx', 'should not have overwritten existing');
  });

  it('follows 302 redirects from upstream', async () => {
    const tokenizerBody = JSON.stringify({ '<PAD>': 0, '<UNK>': 1 });
    // Original URL redirects; secondary serves the body.
    upstream.redirect.set(`/${ONNX_FILE}`, `/r/${ONNX_FILE}`);
    upstream.served.set(`/r/${ONNX_FILE}`, Buffer.from('via-redirect'));
    upstream.served.set(`/${ONNX_DATA_FILE}`, Buffer.from('direct'));
    upstream.served.set(`/${TOKENIZER_FILE}`, Buffer.from(tokenizerBody, 'utf-8'));

    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      skipIntegrityCheck: true,
      onDownloadProgress: () => undefined,
    });

    await engine.ensureReady().catch(() => undefined);

    const onnxBytes = await readFile(join(modelDir, ONNX_FILE));
    assert.equal(onnxBytes.toString(), 'via-redirect');
  });

  it('rejects a download whose SHA-256 does not match the expected hash', async () => {
    // Serve real content for one file we'll integrity-check against.
    // We choose ONNX_FILE because EXPECTED_SHA256 enforces it. We
    // SERVE garbage so the streamed SHA-256 won't match.
    upstream.served.set(`/${ONNX_FILE}`, Buffer.from('definitely-not-the-real-onnx'));
    upstream.served.set(`/${ONNX_DATA_FILE}`, Buffer.from('not-the-data'));
    upstream.served.set(`/${TOKENIZER_FILE}`, Buffer.from('{}'));

    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      // Do NOT skip integrity — we want the verifier to reject.
      onDownloadProgress: () => undefined,
    });

    await assert.rejects(
      engine.ensureReady(),
      (err: Error) => /failed integrity check|expected .* got/.test(err.message),
    );

    // The .part file must be cleaned up; the canonical path must NOT
    // contain the bad bytes.
    assert.ok(!existsSync(join(modelDir, `${ONNX_FILE}.part`)), '.part should be cleaned up');
    // The canonical file may not exist at all (if it was the first to fail)
    // OR may exist from a prior successful download. Either is acceptable.
  });

  it('does not leave a .part file behind on HTTP failure', async () => {
    upstream.fail.add(`/${ONNX_FILE}`);

    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      skipIntegrityCheck: true,
      onDownloadProgress: () => undefined,
    });

    await assert.rejects(engine.ensureReady());
    assert.ok(!existsSync(join(modelDir, `${ONNX_FILE}.part`)), '.part should be cleaned up');
  });

  it('emits a default-reporter-quiet sequence for custom onDownloadProgress', async () => {
    const events: DownloadProgressEvent[] = [];
    upstream.served.set(`/${ONNX_FILE}`, Buffer.from('x'.repeat(100)));
    upstream.served.set(`/${ONNX_DATA_FILE}`, Buffer.from('y'.repeat(100)));
    upstream.served.set(`/${TOKENIZER_FILE}`, Buffer.from('{}'));

    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      skipIntegrityCheck: true,
      onDownloadProgress: (e) => events.push(e),
    });

    await engine.ensureReady().catch(() => undefined);

    // We expect at least: start, bytes (>=1), verifying, done for each
    // of three files. The exact byte-event count depends on chunking.
    const phases = new Set(events.map((e) => e.phase));
    assert.ok(phases.has('start'));
    assert.ok(phases.has('done'));
    assert.ok(phases.has('verifying'));
  });

  // skipIntegrityCheck is declared boolean, but a JavaScript caller is not
  // held to that type, and a value read from an environment variable or a
  // JSON file arrives as a string, where 'false' is truthy. Only the boolean
  // true skips the SHA-256 checks: each value below leaves on both the check
  // of the files in the model directory on load and the check of a
  // downloaded file before it is renamed into place.
  for (const value of ['false', 'true', 1, 0] as unknown[]) {
    const label = `${JSON.stringify(value)} (${typeof value})`;

    it(`skipIntegrityCheck ${label} keeps the SHA-256 check of the model files on load`, async () => {
      for (const [name, body] of MISMATCHED_FILES) await writeFile(join(modelDir, name), body);
      const engine = new OnnxEngine({
        modelDir,
        noAutoDownload: true,
        skipIntegrityCheck: value as boolean,
        onDownloadProgress: () => undefined,
      });

      await assert.rejects(engine.ensureReady(), {
        message: /^NanoMind integrity check failed for nanomind-tme\.onnx: /,
      });
    });

    it(`skipIntegrityCheck ${label} keeps the SHA-256 check of a downloaded file`, async () => {
      for (const [name, body] of MISMATCHED_FILES) upstream.served.set(`/${name}`, body);
      const engine = new OnnxEngine({
        modelDir,
        downloadBaseUrl: upstream.baseUrl,
        skipIntegrityCheck: value as boolean,
        onDownloadProgress: () => undefined,
      });

      await assert.rejects(engine.ensureReady(), {
        message: /^Downloaded nanomind-tme\.onnx failed integrity check: /,
      });
      assert.ok(!existsSync(join(modelDir, ONNX_FILE)), 'the file that failed the check is not renamed into place');
      assert.ok(!existsSync(join(modelDir, `${ONNX_FILE}.part`)), '.part should be cleaned up');
    });
  }

  it('skipIntegrityCheck true skips both SHA-256 checks for the same files', async () => {
    for (const [name, body] of MISMATCHED_FILES) upstream.served.set(`/${name}`, body);
    const engine = new OnnxEngine({
      modelDir,
      downloadBaseUrl: upstream.baseUrl,
      skipIntegrityCheck: true,
      onDownloadProgress: () => undefined,
    });

    // Past both checks, onnxruntime refuses bytes that are not a model.
    await assert.rejects(engine.ensureReady(), (err: Error) => {
      assert.doesNotMatch(err.message, /integrity check/);
      assert.match(err.message, /onnx|InferenceSession|invalid|protobuf|magic/i);
      return true;
    });
    for (const [name, body] of MISMATCHED_FILES) {
      assert.deepEqual(await readFile(join(modelDir, name)), body, `${name} is renamed into place unchecked`);
    }
  });
});
