import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  LLAMAFILE_DOWNLOAD,
  MODEL_DOWNLOAD,
  defaultLlamafilePath,
  defaultModelPath,
  downloadVerified,
  type DownloadSource,
} from './download.ts';
import { NanoMindEngine } from './index.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface Route {
  body?: string;
  status?: number;
  redirect?: string;
  delay?: number;
  /** Send `body` and leave the response open. */
  hang?: boolean;
}

// A file server on 127.0.0.1 that records the path of every request.
async function startServer(routes: Record<string, Route>) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    setTimeout(() => {
      if (route.redirect) {
        res.writeHead(302, { location: route.redirect }).end();
      } else if (route.hang) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).write(route.body ?? '');
      } else {
        res.writeHead(route.status ?? 200, { 'content-type': 'application/octet-stream' }).end(route.body ?? '');
      }
    }, route.delay ?? 0);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// The source a test passes for a route: its URL, and the size and SHA-256 of `body`.
function source(base: string, path: string, body: string): DownloadSource {
  return { url: `${base}${path}`, sha256: sha256(body), size: Buffer.byteLength(body) };
}

// Starts another process that runs downloadVerified(pinned, path, 0o644).
function downloadInChild(pinned: DownloadSource, path: string): ChildProcess {
  const download = JSON.stringify(new URL('./download.ts', import.meta.url).href);
  const script = `const { downloadVerified } = await import(${download});
await downloadVerified(${JSON.stringify(pinned)}, ${JSON.stringify(path)}, 0o644);`;
  return spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], { stdio: 'ignore' });
}

// Sends `signal` to `child` and resolves once it has exited.
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

// Resolves to the name of the partial file in `dir` once it holds `bytes` bytes.
async function partialFile(dir: string, bytes: number): Promise<string> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    const name = readdirSync(dir).find((entry) => entry.endsWith('.part') && statSync(join(dir, entry)).size === bytes);
    if (name) return name;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no partial file of ${bytes} bytes appeared in ${dir}`);
}

// The ID of a process that has exited.
const exitedPid = () => spawnSync(process.execPath, ['--eval', '']).pid;

describe('downloadVerified', () => {
  const body = 'file contents';
  let server: Awaited<ReturnType<typeof startServer>>;
  let dir: string;

  before(async () => {
    server = await startServer({
      '/file': { body },
      '/moved': { redirect: '/file' },
      '/missing': { status: 404, body: 'not here' },
    });
  });

  after(() => server.close());

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanomind-download-'));
    server.requests.length = 0;
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('saves the file at its path, in a directory it creates, when its size and SHA-256 match', async () => {
    const path = join(dir, 'bin', 'file');

    assert.strictEqual(await downloadVerified(source(server.base, '/file', body), path, 0o755), Buffer.byteLength(body));
    assert.strictEqual(readFileSync(path, 'utf8'), body);
    assert.deepStrictEqual(readdirSync(join(dir, 'bin')), ['file']);
    if (process.platform !== 'win32') {
      assert.strictEqual(statSync(path).mode & 0o100, 0o100, 'the file is executable by its owner');
    }
  });

  it('creates the file with the mode it is given', { skip: process.platform === 'win32' }, async () => {
    const path = join(dir, 'file');

    await downloadVerified(source(server.base, '/file', body), path, 0o644);

    assert.strictEqual(statSync(path).mode & 0o111, 0, 'the file is not executable');
  });

  it('follows a redirect', async () => {
    const path = join(dir, 'file');

    await downloadVerified({ ...source(server.base, '/file', body), url: `${server.base}/moved` }, path, 0o644);

    assert.strictEqual(readFileSync(path, 'utf8'), body);
    assert.deepStrictEqual(server.requests, ['/moved', '/file']);
  });

  it('deletes a download whose SHA-256 differs and leaves nothing at the path', async () => {
    const path = join(dir, 'file');
    const pinned = { ...source(server.base, '/file', body), sha256: sha256('other contents') };

    await assert.rejects(downloadVerified(pinned, path, 0o644), {
      message:
        `Could not download ${pinned.url} to ${path}: ` +
        `its SHA-256 is ${sha256(body)}, and ${pinned.sha256} is pinned for it`,
    });
    assert.deepStrictEqual(readdirSync(dir), []);
  });

  it('stops a download that runs past the pinned size', async () => {
    const path = join(dir, 'file');
    const pinned = { ...source(server.base, '/file', body), size: 5 };

    await assert.rejects(downloadVerified(pinned, path, 0o644), {
      message: `Could not download ${pinned.url} to ${path}: the server sent more than the 5 bytes pinned for it`,
    });
    assert.deepStrictEqual(readdirSync(dir), []);
  });

  it('deletes a download that ends before the pinned size', async () => {
    const path = join(dir, 'file');
    const pinned = { ...source(server.base, '/file', body), size: 100 };

    await assert.rejects(downloadVerified(pinned, path, 0o644), {
      message: `Could not download ${pinned.url} to ${path}: it is ${Buffer.byteLength(body)} bytes, and 100 are pinned for it`,
    });
    assert.deepStrictEqual(readdirSync(dir), []);
  });

  it('names the HTTP status of a failed request and leaves nothing at the path', async () => {
    const path = join(dir, 'file');
    const pinned = source(server.base, '/missing', 'not here');

    await assert.rejects(downloadVerified(pinned, path, 0o644), {
      message: `Could not download ${pinned.url} to ${path}: the server answered HTTP 404`,
    });
    assert.deepStrictEqual(readdirSync(dir), []);
  });

  it('sends no request, and names the download, when its directory cannot be made', async () => {
    await writeFile(join(dir, 'bin'), 'a file where the directory goes');
    const path = join(dir, 'bin', 'file');
    const pinned = source(server.base, '/file', body);

    await assert.rejects(downloadVerified(pinned, path, 0o644), (error: Error) => {
      assert.ok(error.message.startsWith(`Could not download ${pinned.url} to ${path}: `), error.message);
      return true;
    });
    assert.deepStrictEqual(server.requests, []);
  });

  it('names the connection error when nothing answers', async () => {
    const closed = await startServer({});
    await closed.close();
    const path = join(dir, 'file');
    const pinned = source(closed.base, '/file', body);

    await assert.rejects(downloadVerified(pinned, path, 0o644), (error: Error) => {
      assert.ok(error.message.startsWith(`Could not download ${pinned.url} to ${path}: fetch failed (`), error.message);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
    assert.deepStrictEqual(readdirSync(dir), []);
  });
});

describe('downloadVerified and the partial files of earlier downloads', () => {
  const body = 'file contents';
  let server: Awaited<ReturnType<typeof startServer>>;
  let dir: string;
  let path: string;

  before(async () => {
    server = await startServer({
      '/file': { body },
      '/hang': { body: body.slice(0, 4), hang: true },
    });
  });

  after(() => server.close());

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanomind-partial-'));
    path = join(dir, 'file');
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  const pinned = () => source(server.base, '/file', body);
  // Sends the first 4 bytes of the file and never ends.
  const hanging = () => ({ ...pinned(), url: `${server.base}/hang` });

  it('deletes the partial file of a download whose process was interrupted, before it downloads', async () => {
    const interrupted = downloadInChild(hanging(), path);
    const partial = await partialFile(dir, 4).finally(() => stop(interrupted, 'SIGINT'));
    assert.deepStrictEqual(readdirSync(dir), [partial], 'the interrupted download left its partial file');

    await downloadVerified(pinned(), path, 0o644);

    assert.deepStrictEqual(readdirSync(dir), ['file']);
  });

  it('names the partial file for the process that writes it, and leaves it while that process runs', async () => {
    const running = downloadInChild(hanging(), path);
    try {
      const partial = await partialFile(dir, 4);
      assert.match(partial, new RegExp(`^file\\.${running.pid}\\.[0-9a-f]{12}\\.part$`));

      await downloadVerified(pinned(), path, 0o644);

      assert.deepStrictEqual(readdirSync(dir).sort(), ['file', partial].sort());
    } finally {
      await stop(running);
    }
  });

  it('leaves the partial file of another download in this process', async () => {
    const other = await startServer({ '/hang': { body: body.slice(0, 4), hang: true } });
    const first = downloadVerified({ ...pinned(), url: `${other.base}/hang` }, path, 0o644);
    const firstRejects = assert.rejects(first);
    try {
      const partial = await partialFile(dir, 4);
      assert.match(partial, new RegExp(`^file\\.${process.pid}\\.[0-9a-f]{12}\\.part$`));

      await downloadVerified(pinned(), path, 0o644);

      assert.deepStrictEqual(readdirSync(dir).sort(), ['file', partial].sort());
    } finally {
      // Closing its connection fails the first download, which deletes its own file.
      await other.close();
      await firstRejects;
    }
    assert.deepStrictEqual(readdirSync(dir), ['file']);
  });

  it('deletes a partial file named for this process that no download in it is writing', async () => {
    // As a process that ran before this one, with the same ID, leaves it.
    await writeFile(join(dir, `file.${process.pid}.0123456789ab.part`), 'file');

    await downloadVerified(pinned(), path, 0o644);

    assert.deepStrictEqual(readdirSync(dir), ['file']);
  });

  it('leaves files that are not partial files of its path as they are', async () => {
    const pid = exitedPid();
    const others = ['file.part', 'file.0123456789ab.part', `file.${pid}.0123456789ab.part.old`, `other.${pid}.0123456789ab.part`];
    for (const name of others) await writeFile(join(dir, name), 'kept');

    await downloadVerified(pinned(), path, 0o644);

    assert.deepStrictEqual(readdirSync(dir).sort(), ['file', ...others].sort());
  });

  it('downloads when a partial file it would delete cannot be deleted', async () => {
    // rm fails on a directory, as it is not asked to remove one.
    const left = `file.${exitedPid()}.0123456789ab.part`;
    await mkdir(join(dir, left));
    await writeFile(join(dir, left, 'inside'), 'kept');

    await downloadVerified(pinned(), path, 0o644);

    assert.deepStrictEqual(readdirSync(dir).sort(), ['file', left].sort());
  });

  it('downloads into a directory it cannot list', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    await chmod(dir, 0o300);
    try {
      await downloadVerified(pinned(), path, 0o644);
    } finally {
      await chmod(dir, 0o700);
    }

    assert.strictEqual(readFileSync(path, 'utf8'), body);
  });
});

describe('pinned downloads', () => {
  it('fetch the llamafile from a release and the model from a fixed commit, over HTTPS', () => {
    assert.match(LLAMAFILE_DOWNLOAD.url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.-]+$/);
    assert.match(MODEL_DOWNLOAD.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[\w.-]+\.gguf$/);
  });

  it('each name a SHA-256 and a size, and cannot be changed at run time', () => {
    for (const pinned of [LLAMAFILE_DOWNLOAD, MODEL_DOWNLOAD]) {
      assert.match(pinned.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(pinned.size) && pinned.size > 0, String(pinned.size));
      assert.ok(Object.isFrozen(pinned));
    }
  });

  it('go to the paths the engine reads by default', () => {
    const home = join(tmpdir(), 'home');

    assert.strictEqual(defaultLlamafilePath(home), join(home, '.nanomind', 'bin', 'llamafile'));
    assert.strictEqual(defaultModelPath(home), join(home, '.nanomind', 'models', 'SmolLM2-135M.Q4_K_M.gguf'));
    assert.strictEqual(new NanoMindEngine().getModelPath(), defaultModelPath());
  });
});

describe('NanoMindEngine first call without the llamafile or the model', () => {
  // A stand-in llamafile that prints the model path the engine passes it.
  const llamafileBody = '#!/bin/sh\necho "ran with $2"\n';
  const modelBody = 'not a real model';
  let server: Awaited<ReturnType<typeof startServer>>;
  let dir: string;
  let llamafilePath: string;
  let modelPath: string;

  before(async () => {
    server = await startServer({
      '/llamafile': { body: llamafileBody },
      '/model': { body: modelBody },
      '/slow-llamafile': { body: llamafileBody, delay: 1000 },
      // As long as the model, so only its SHA-256 tells them apart.
      '/tampered-model': { body: 'a tampered model' },
    });
  });

  after(() => server.close());

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanomind-first-call-'));
    llamafilePath = join(dir, 'bin', 'llamafile');
    modelPath = join(dir, 'models', 'model.gguf');
    server.requests.length = 0;
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  const llamafileSource = () => source(server.base, '/llamafile', llamafileBody);
  const modelSource = () => source(server.base, '/model', modelBody);

  it('downloads both to the default paths, says so on stderr, then runs them', { skip: process.platform === 'win32' }, async () => {
    const index = JSON.stringify(new URL('./index.ts', import.meta.url).href);
    const config = JSON.stringify({ llamafileDownload: llamafileSource(), modelDownload: modelSource() });
    const script = `const { NanoMindEngine } = await import(${index});
await new NanoMindEngine(${config}).infer('hi').then(
  (result) => console.log('resolved: ' + result.text),
  (error) => console.log('rejected: ' + error.message),
);`;
    // The server answers in this process, so the call runs in another one,
    // whose home directory is `dir`.
    const run = await promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', script],
      { env: { ...process.env, HOME: dir }, encoding: 'utf8' },
    );
    const defaultLlamafile = join(dir, '.nanomind', 'bin', 'llamafile');
    const defaultModel = join(dir, '.nanomind', 'models', 'SmolLM2-135M.Q4_K_M.gguf');

    assert.deepStrictEqual(run.stdout.trimEnd().split('\n'), [`resolved: ran with ${defaultModel}`]);
    assert.deepStrictEqual(run.stderr.split('\n').filter((line) => line.startsWith('NanoMind:')), [
      `NanoMind: downloading the llamafile (${llamafileSource().size} bytes) from ${server.base}/llamafile to ${defaultLlamafile}`,
      `NanoMind: saved ${defaultLlamafile}, SHA-256 verified`,
      `NanoMind: downloading the model (${modelSource().size} bytes) from ${server.base}/model to ${defaultModel}`,
      `NanoMind: saved ${defaultModel}, SHA-256 verified`,
    ]);
    assert.strictEqual(readFileSync(defaultModel, 'utf8'), modelBody);
    assert.deepStrictEqual(server.requests, ['/llamafile', '/model']);
  });

  it('downloads only the file that is missing', { skip: process.platform === 'win32' }, async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    await mkdir(join(dir, 'models'));
    await writeFile(modelPath, 'a model already on disk');
    const engine = new NanoMindEngine({ llamafilePath, modelPath, llamafileDownload: llamafileSource(), modelDownload: modelSource() });

    assert.strictEqual((await engine.infer('hi')).text, `ran with ${modelPath}`);
    assert.deepStrictEqual(server.requests, ['/llamafile']);
    assert.strictEqual(readFileSync(modelPath, 'utf8'), 'a model already on disk');
  });

  it('rejects and runs nothing when a download fails its SHA-256 check', async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    const ran = join(dir, 'ran');
    await mkdir(join(dir, 'bin'));
    await writeFile(llamafilePath, `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
    const tampered = { ...modelSource(), url: `${server.base}/tampered-model` };
    const engine = new NanoMindEngine({ llamafilePath, modelPath, modelDownload: tampered });

    await assert.rejects(engine.infer('hi'), {
      message:
        `Could not download ${tampered.url} to ${modelPath}: ` +
        `its SHA-256 is ${sha256('a tampered model')}, and ${tampered.sha256} is pinned for it`,
    });
    assert.strictEqual(existsSync(modelPath), false);
    assert.deepStrictEqual(readdirSync(join(dir, 'models')), []);
    assert.strictEqual(existsSync(ran), false, 'the llamafile ran');
  });

  it('downloads each file once for calls made while the download runs', { skip: process.platform === 'win32' }, async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    const engine = new NanoMindEngine({ llamafilePath, modelPath, llamafileDownload: llamafileSource(), modelDownload: modelSource() });

    const results = await Promise.all([engine.infer('one'), engine.infer('two')]);

    assert.deepStrictEqual(results.map((result) => result.text), [`ran with ${modelPath}`, `ran with ${modelPath}`]);
    assert.deepStrictEqual(server.requests, ['/llamafile', '/model']);
  });

  it('downloads nothing with noAutoDownload', async () => {
    const engine = new NanoMindEngine({
      llamafilePath,
      modelPath,
      llamafileDownload: llamafileSource(),
      modelDownload: modelSource(),
      noAutoDownload: true,
    });

    await assert.rejects(engine.infer('hi'), (error: Error) => {
      assert.ok(error.message.startsWith(`llamafile not found at ${llamafilePath}. noAutoDownload is set`), error.message);
      return true;
    });
    assert.deepStrictEqual(server.requests, []);
    assert.deepStrictEqual(readdirSync(dir), []);
  });

  // noAutoDownload is declared boolean, but a JavaScript caller is not held
  // to that type, and a value read from an environment variable arrives as a
  // string, where 'false' is truthy. Only the boolean true downloads nothing.
  for (const value of ['false', 'true', 1, 0] as unknown[]) {
    it(`downloads both with noAutoDownload ${JSON.stringify(value)} (${typeof value})`, async (t) => {
      t.mock.method(process.stderr, 'write', () => true);
      const engine = new NanoMindEngine({
        llamafilePath,
        modelPath,
        llamafileDownload: llamafileSource(),
        modelDownload: modelSource(),
        noAutoDownload: value as boolean,
      });

      await engine.ensureReady();

      assert.deepStrictEqual(server.requests, ['/llamafile', '/model']);
      assert.strictEqual(readFileSync(llamafilePath, 'utf8'), llamafileBody);
      assert.strictEqual(readFileSync(modelPath, 'utf8'), modelBody);
    });
  }

  it('leaves the download out of latencyMs', { skip: process.platform === 'win32' }, async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    const slow = { ...llamafileSource(), url: `${server.base}/slow-llamafile` };
    const engine = new NanoMindEngine({ llamafilePath, modelPath, llamafileDownload: slow, modelDownload: modelSource() });

    const started = Date.now();
    const result = await engine.infer('hi');
    const elapsed = Date.now() - started;

    // The server holds the llamafile back for a second before it answers, so
    // a latencyMs that counted the download would be close to `elapsed`.
    assert.ok(result.latencyMs <= elapsed - 900, `latencyMs is ${result.latencyMs} of ${elapsed}`);
  });
});
