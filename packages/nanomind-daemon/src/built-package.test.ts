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
import { ABSTAIN_CONFIDENCE_FLOOR, NanoMindDaemon } from './server.ts';
import type { DaemonEngine } from './server.ts';

// These tests run the built package, the files a consumer installs: the entry
// point package.json names in `main` and `types`, and the `nanomind-daemon`
// binary. `npm run build` writes them to dist/, which is not tracked, so the
// tests skip until the package is built. CI builds before it tests.
const PKG_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as {
  version: string;
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

// The build is CommonJS. A require() of an ES module from it needs
// require(esm), which this flag turns off, as it is off on Node releases
// that do not enable it by default.
describe('built package on a Node runtime without require(esm)', { skip: !CLI_BUILT && 'dist/ is not built' }, () => {
  let home: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'nanomind-no-require-esm-'));
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function runWithoutRequireEsm(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--no-experimental-require-module', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...env },
      encoding: 'utf-8',
      timeout: 60_000,
    });
  }

  it('nanomind-daemon --version prints the package version', () => {
    const run = runWithoutRequireEsm([CLI, '--version']);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, `${PKG.version}\n`);
  });

  it('require() of the entry point returns its exports', () => {
    const run = runWithoutRequireEsm(['-e', `console.log(typeof require(${JSON.stringify(PKG_DIR)}).NanoMindDaemon)`]);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, 'function\n');
  });

  it('nanomind-daemon start runs the model host from dist/', () => {
    // The "not found" error comes from the model host process, so it shows
    // the daemon found the host file and the host loaded.
    const modelDir = join(home, 'models');
    const run = runWithoutRequireEsm([CLI, 'start', '--no-download'], { NANOMIND_MODEL_DIR: modelDir });
    assert.strictEqual(run.status, 1, run.stderr);
    assert.ok(
      run.stderr.startsWith(`Fatal: NanoMind model not found at ${join(modelDir, 'nanomind-tme.onnx')}`),
      `stderr does not open with the host's load error:\n${run.stderr}`,
    );
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

describe('nanomind-daemon start: HTTP port held by another socket', {
  skip: (!CLI_BUILT && 'dist/ is not built') || (process.platform === 'win32' && 'ipcPath is a named pipe on Windows'),
}, () => {
  let dir: string;
  let preload: string;
  let port: number;
  // Holds the port the CLI is given, so the daemon cannot bind it.
  const holder = createServer();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nanomind-port-'));
    // Loaded before the CLI: ensureReady() resolves without starting the
    // model host, so start() goes on to bind the Unix socket and the port.
    preload = join(dir, 'model-ready.cjs');
    writeFileSync(
      preload,
      [
        `const { OnnxProcessEngine } = require(${JSON.stringify(join(CLI, '..', 'onnx-process-engine.js'))});`,
        'OnnxProcessEngine.prototype.ensureReady = async () => {};',
        '',
      ].join('\n'),
    );
    holder.listen(0, '127.0.0.1');
    await once(holder, 'listening');
    port = (holder.address() as AddressInfo).port;
  });

  after(() => {
    holder.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the listen error on one Fatal line, exits 1 and removes its socket file', () => {
    const ipcPath = join(dir, 'daemon.sock');
    const run = spawnSync(process.execPath, ['--require', preload, CLI, 'start'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        USERPROFILE: dir,
        NANOMIND_PORT: String(port),
        NANOMIND_IPC_PATH: ipcPath,
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.strictEqual(run.status, 1, run.stderr);
    assert.strictEqual(run.stderr, `Fatal: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
    assert.ok(!existsSync(ipcPath), 'the CLI left a socket file at NANOMIND_IPC_PATH');
    assert.ok(!existsSync(join(dir, '.nanomind', 'daemon.pid')), 'the CLI wrote a PID file for a daemon that did not start');
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
    // The whole output, so a status that throws after the Uptime line and then
    // prints "Daemon is not running" fails here.
    assert.strictEqual(stdout, [
      'NanoMind Daemon Status:',
      '  Running:      true',
      `  Port:         ${port}`,
      '  Active tasks: 0',
      '  Model loaded: false',
      '  Uptime:       5s',
      '',
    ].join('\n'));
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

describe('nanomind-daemon --help: /v1/infer response', { skip: !CLI_BUILT && 'dist/ is not built' }, () => {
  type EngineResult = Awaited<ReturnType<DaemonEngine['infer']>>;

  // The fields daemon.infer() returns when the engine answers with `result`.
  async function fieldsSent(result: EngineResult): Promise<string[]> {
    const daemon = new NanoMindDaemon({ engine: { ensureReady: async () => {}, infer: async () => result } });
    try {
      return Object.keys(await daemon.infer({ intent: 'INTENT_CHECK', input: 'list files' }));
    } finally {
      await daemon.stop();
    }
  }

  it('lists the fields the daemon sends and names remediation as reserved', async () => {
    const run = spawnSync(process.execPath, [CLI, '--help'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.strictEqual(run.status, 0, run.stderr);
    const line = run.stdout.match(/^\s*Response: \{([^}]*)\}$/m);
    assert.ok(line, `--help prints no Response line:\n${run.stdout}`);
    const listed = line[1].split(',').map(field => field.trim());

    // `evidence` is sent only when the engine returns a raw label, so the
    // help marks it `?`; every other field is in every response infer() returns.
    const verdict: EngineResult = { text: 'benign', attackClass: '', confidence: 0.9 };
    const always = await fieldsSent(verdict);
    const withLabel = await fieldsSent({ ...verdict, rawLabel: 'benign' });
    const sent = withLabel.map(field => (always.includes(field) ? field : `${field}?`));
    assert.deepStrictEqual(new Set(listed), new Set(sent), run.stdout);

    // InferResponse declares `remediation`, and the daemon does not send it.
    assert.ok(!withLabel.includes('remediation'), `the daemon sends remediation: ${withLabel.join(', ')}`);
    assert.match(run.stdout, /\bremediation\b[^\n]*\breserved\b/, `--help does not name remediation as reserved:\n${run.stdout}`);
  });
});
