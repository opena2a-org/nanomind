import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DownloadSource } from './download.ts';
import { runSetup, type SetupOptions } from './setup.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('runSetup', () => {
  const llamafileBody = '#!/bin/sh\necho llamafile\n';
  const modelBody = 'not a real model';
  const bodies: Record<string, string> = {
    '/llamafile': llamafileBody,
    '/model': modelBody,
    // As long as the model, so only its SHA-256 tells them apart.
    '/tampered-model': 'a tampered model',
  };
  // A file server on 127.0.0.1 that records the path of every request.
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const body = bodies[req.url ?? ''];
    res.writeHead(body === undefined ? 404 : 200).end(body ?? '');
  });
  let base: string;
  let home: string;
  let lines: string[];
  let llamafilePath: string;
  let modelPath: string;

  // The source of a route: its URL, and the size and SHA-256 of `body`.
  const source = (path: string, body: string): DownloadSource => ({
    url: `${base}${path}`,
    sha256: sha256(body),
    size: Buffer.byteLength(body),
  });

  const setup = (options: SetupOptions = {}) =>
    runSetup({
      home,
      llamafileDownload: source('/llamafile', llamafileBody),
      modelDownload: source('/model', modelBody),
      print: (line) => lines.push(line),
      ...options,
    });

  before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanomind-setup-'));
    lines = [];
    requests.length = 0;
    llamafilePath = join(home, '.nanomind', 'bin', 'llamafile');
    modelPath = join(home, '.nanomind', 'models', 'SmolLM2-135M.Q4_K_M.gguf');
  });

  afterEach(() => rm(home, { recursive: true, force: true }));

  it('downloads the llamafile and the model to the paths the engine reads by default', async () => {
    assert.strictEqual(await setup(), true);

    assert.deepStrictEqual(lines, [
      `llamafile: downloading ${Buffer.byteLength(llamafileBody)} bytes from ${base}/llamafile`,
      `llamafile: saved ${llamafilePath}, SHA-256 verified`,
      `model: downloading ${Buffer.byteLength(modelBody)} bytes from ${base}/model`,
      `model: saved ${modelPath}, SHA-256 verified`,
    ]);
    assert.strictEqual(readFileSync(llamafilePath, 'utf8'), llamafileBody);
    assert.strictEqual(readFileSync(modelPath, 'utf8'), modelBody);
    assert.deepStrictEqual(requests, ['/llamafile', '/model']);
    if (process.platform !== 'win32') {
      assert.strictEqual(statSync(llamafilePath).mode & 0o100, 0o100, 'the llamafile is executable by its owner');
      assert.strictEqual(statSync(modelPath).mode & 0o111, 0, 'the model is not executable');
    }
  });

  it('keeps a file that is already there with its pinned SHA-256 and downloads only the other', async () => {
    await mkdir(dirname(modelPath), { recursive: true });
    await writeFile(modelPath, modelBody);

    assert.strictEqual(await setup(), true);

    assert.deepStrictEqual(requests, ['/llamafile']);
    assert.strictEqual(lines[2], `model: ${modelPath} is already there, SHA-256 verified`);
    assert.strictEqual(lines.length, 3);
  });

  it('leaves a file whose SHA-256 differs as it is, names it, and still downloads the other', async () => {
    await mkdir(dirname(llamafilePath), { recursive: true });
    await writeFile(llamafilePath, 'another llamafile');

    assert.strictEqual(await setup(), false);

    assert.strictEqual(
      lines[0],
      `llamafile: ${llamafilePath} is already there, but its SHA-256 is ${sha256('another llamafile')}, ` +
        `not the pinned ${sha256(llamafileBody)}. ` +
        'Setup leaves it as it is. Delete it and run nanomind setup again to download the pinned file.',
    );
    assert.strictEqual(readFileSync(llamafilePath, 'utf8'), 'another llamafile');
    assert.deepStrictEqual(requests, ['/model']);
    assert.strictEqual(readFileSync(modelPath, 'utf8'), modelBody);
  });

  it('rejects, and saves nothing at the path, when a download fails its SHA-256 check', async () => {
    const tampered = { ...source('/model', modelBody), url: `${base}/tampered-model` };

    await assert.rejects(setup({ modelDownload: tampered }), {
      message:
        `Could not download ${tampered.url} to ${modelPath}: ` +
        `its SHA-256 is ${sha256('a tampered model')}, and ${tampered.sha256} is pinned for it`,
    });

    assert.strictEqual(existsSync(modelPath), false);
    assert.deepStrictEqual(readdirSync(dirname(modelPath)), []);
    assert.strictEqual(readFileSync(llamafilePath, 'utf8'), llamafileBody, 'the llamafile saved before it stays');
  });
});
