import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
