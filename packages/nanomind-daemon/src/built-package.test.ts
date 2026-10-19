import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ABSTAIN_CONFIDENCE_FLOOR } from './server.ts';

// These tests run the built package, the files a consumer installs: the entry
// point package.json names in `main` and `types`, and the `nanomind-daemon`
// binary. `npm run build` writes them to dist/, which is not tracked, so the
// tests skip until the package is built. CI builds before it tests.
const PKG_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as {
  main: string;
  types: string;
  bin: Record<string, string>;
};
const CLI = join(PKG_DIR, PKG.bin['nanomind-daemon']);

const ENTRY_BUILT = [PKG.main, PKG.types].every(file => existsSync(join(PKG_DIR, file)));
const CLI_BUILT = existsSync(CLI);

describe('@nanomind/daemon entry point', { skip: !ENTRY_BUILT && 'dist/ is not built' }, () => {
  it('exports ABSTAIN_CONFIDENCE_FLOOR with the value the server applies', () => {
    // Requiring the package directory resolves `main`, as a consumer's
    // require('@nanomind/daemon') does.
    const entry = createRequire(import.meta.url)(PKG_DIR) as Record<string, unknown>;
    assert.strictEqual(entry.ABSTAIN_CONFIDENCE_FLOOR, 0.5);
    assert.strictEqual(entry.ABSTAIN_CONFIDENCE_FLOOR, ABSTAIN_CONFIDENCE_FLOOR);
    for (const name of ['NanoMindDaemon', 'DEFAULT_CONFIG', 'InferRequestError', 'BaseFabricAdapter']) {
      assert.ok(name in entry, `the entry point still exports ${name}`);
    }
  });

  it('declares ABSTAIN_CONFIDENCE_FLOOR and the ClassificationStatus type for TypeScript consumers', () => {
    const declarations = readFileSync(join(PKG_DIR, PKG.types), 'utf-8');
    const values: string[] = [];
    const types: string[] = [];
    for (const [, typeOnly, names] of declarations.matchAll(/^export (type )?\{([^}]*)\}/gm)) {
      (typeOnly ? types : values).push(...names.split(',').map(name => name.trim()).filter(Boolean));
    }
    assert.ok(values.includes('ABSTAIN_CONFIDENCE_FLOOR'), `value exports: ${values.join(', ')}`);
    assert.ok(types.includes('ClassificationStatus'), `type exports: ${types.join(', ')}`);
  });
});

describe('nanomind-daemon start: model directory', { skip: !CLI_BUILT && 'dist/ is not built' }, () => {
  let home: string;
  let modelDir: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'nanomind-home-'));
    modelDir = mkdtempSync(join(tmpdir(), 'nanomind-models-'));
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(modelDir, { recursive: true, force: true });
  });

  // Starts the daemon with no model files anywhere and downloads off. It
  // exits before binding a port and names the directory it looked in.
  function startWithoutModel(env: Record<string, string>) {
    return spawnSync(process.execPath, [CLI, 'start', '--no-download'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...env },
      encoding: 'utf-8',
      timeout: 60_000,
    });
  }

  it('reads the model files from NANOMIND_MODEL_DIR when it is set', () => {
    const run = startWithoutModel({ NANOMIND_MODEL_DIR: modelDir });
    assert.strictEqual(run.status, 1, run.stderr);
    assert.ok(
      run.stderr.includes(`not found at ${join(modelDir, 'nanomind-tme.onnx')}`),
      `the daemon did not look in NANOMIND_MODEL_DIR:\n${run.stderr}`,
    );
    assert.ok(!run.stderr.includes(join(home, '.nanomind', 'models')), 'the default directory is not consulted');
  });

  it('prints the error message without a stack trace and exits 1', () => {
    const run = startWithoutModel({ NANOMIND_MODEL_DIR: modelDir });
    assert.strictEqual(run.status, 1, run.stderr);
    assert.ok(
      run.stderr.startsWith(`Fatal: NanoMind model not found at ${join(modelDir, 'nanomind-tme.onnx')}`),
      `stderr does not open with the message:\n${run.stderr}`,
    );
    assert.doesNotMatch(run.stderr, /^\s+at /m, 'stderr carries stack frames');
  });

  it('reads them from ~/.nanomind/models/ when NANOMIND_MODEL_DIR is unset or empty', () => {
    for (const env of [{}, { NANOMIND_MODEL_DIR: '' }]) {
      const run = startWithoutModel(env);
      assert.strictEqual(run.status, 1, run.stderr);
      assert.ok(
        run.stderr.includes(`not found at ${join(home, '.nanomind', 'models', 'nanomind-tme.onnx')}`),
        `the daemon did not look in the default directory (env ${JSON.stringify(env)}):\n${run.stderr}`,
      );
    }
  });
});

describe('nanomind-daemon start: model download refused on every address', { skip: !CLI_BUILT && 'dist/ is not built' }, () => {
  let dir: string;
  let preload: string;
  let port: number;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nanomind-refused-'));
    // A port that was free a moment ago, so a connection to it is refused.
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    port = (probe.address() as AddressInfo).port;
    probe.close();
    await once(probe, 'close');
    // Loaded before the CLI: every HTTPS download goes to that port through a
    // lookup that returns two addresses, as on a network that refuses
    // huggingface.co on each of its addresses. Node reports that as an
    // AggregateError with an empty message.
    preload = join(dir, 'refuse-downloads.cjs');
    writeFileSync(
      preload,
      [
        "const http = require('node:http');",
        "const https = require('node:https');",
        'const lookup = (_host, options, cb) => {',
        "  const addresses = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];",
        '  if (options && options.all) cb(null, addresses);',
        '  else cb(null, addresses[0].address, addresses[0].family);',
        '};',
        `https.get = (_url, cb) => http.get('http://refused.invalid:${port}/', { autoSelectFamily: true, lookup }, cb);`,
        '',
      ].join('\n'),
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints why the download failed on the download line and the Fatal line', () => {
    const run = spawnSync(process.execPath, ['--require', preload, CLI, 'start'], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, USERPROFILE: dir, NANOMIND_MODEL_DIR: join(dir, 'models') },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.strictEqual(run.status, 1, run.stderr);
    const refused = `connect ECONNREFUSED 127.0.0.1:${port}`;
    const lines = run.stderr.split('\n');
    const download = lines.find(line => line.startsWith('[nanomind-daemon] nanomind-tme.onnx failed:'));
    assert.ok(download?.includes(refused), `the download line does not name the refusal:\n${run.stderr}`);
    const fatal = lines.find(line => line.startsWith('Fatal:'));
    assert.ok(fatal?.includes(refused), `the Fatal line does not name the refusal:\n${run.stderr}`);
  });
});

describe('nanomind-daemon status: refusals', { skip: !CLI_BUILT && 'dist/ is not built' }, () => {
  let home: string;
  let port: number;
  let status: Record<string, unknown> = {};
  const daemon = createServer((req, res) => {
    if (req.url !== '/v1/status') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  });

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'nanomind-home-'));
    daemon.listen(0, '127.0.0.1');
    await once(daemon, 'listening');
    port = (daemon.address() as AddressInfo).port;
  });

  after(() => {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  });

  // Asynchronous, because spawnSync would block this process and with it the
  // stub daemon the CLI asks.
  async function runStatus(): Promise<string> {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'status'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, NANOMIND_PORT: String(port) },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return stdout;
  }

  const running = () => ({ running: true, port, activeTasks: 0, modelLoaded: false, uptime: 5000 });

  it('prints the Refused line when the daemon reports refusals', async () => {
    status = { ...running(), refusals: { rateLimited: 3, queueFull: 2 } };
    const stdout = await runStatus();
    assert.match(stdout, /^ {2}Refused: +3 rate limited, 2 queue full$/m, stdout);
  });

  it('prints no Refused line when the daemon does not report refusals', async () => {
    status = running();
    const stdout = await runStatus();
    assert.match(stdout, /^ {2}Uptime: +5s$/m, stdout);
    assert.doesNotMatch(stdout, /Refused/, stdout);
  });
});

describe('nanomind-daemon --help: API routes', { skip: !CLI_BUILT && 'dist/ is not built' }, () => {
  // The routes the daemon serves, read as text from the
  // `url === '<path>' && method === '<METHOD>'` checks in server.ts.
  const SERVER_TS = readFileSync(join(PKG_DIR, 'src', 'server.ts'), 'utf-8');
  const served = [...SERVER_TS.matchAll(/url === '([^']+)' && method === '([A-Z]+)'/g)]
    .map(([, path, method]) => `${method} ${path}`);

  it('lists each route the daemon serves, and no other', () => {
    assert.ok(served.length > 0, 'no route checks were read from server.ts');
    const run = spawnSync(process.execPath, [CLI, '--help'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.strictEqual(run.status, 0, run.stderr);
    const listed = [...run.stdout.matchAll(/^ {2}([A-Z]+) +http:\/\/127\.0\.0\.1:\d+(\/\S*)$/gm)]
      .map(([, method, path]) => `${method} ${path}`);
    assert.deepStrictEqual([...listed].sort(), [...served].sort(), run.stdout);
  });
});
