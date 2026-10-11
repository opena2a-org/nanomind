import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests run the built file that npm links as the `nanomind` command, so
// they need `npm run build` first, as CI does.
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const bin = join(packageDir, manifest.bin.nanomind);

describe('nanomind command', () => {
  let scratch: string;
  let emptyPath: string;
  let fakeToolPath: string;

  function nanomind(args: string[], options: { input?: string; path?: string } = {}) {
    return spawnSync(process.execPath, [bin, ...args], {
      input: options.input ?? '',
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: options.path ?? emptyPath,
        // No test here asks a trust question, and none may reach a real registry.
        OPENA2A_REGISTRY_URL: 'http://127.0.0.1:9',
      },
    });
  }

  before(() => {
    assert.ok(existsSync(bin), `${bin} is missing: run npm run build first`);
    scratch = mkdtempSync(join(tmpdir(), 'nanomind-bin-'));
    emptyPath = join(scratch, 'empty');
    fakeToolPath = join(scratch, 'tools');
    mkdirSync(emptyPath);
    mkdirSync(fakeToolPath);
    const fakeTool = join(fakeToolPath, 'hackmyagent');
    writeFileSync(fakeTool, '#!/bin/sh\necho "fake-hackmyagent $*"\n');
    chmodSync(fakeTool, 0o755);
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('starts the interactive session when run with no arguments', () => {
    const run = nanomind([]);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.match(run.stdout, /Type "exit" or Ctrl\+C to quit\./);
    assert.ok(run.stdout.includes(`Connected to: nanomind v${manifest.version}`), run.stdout);
    assert.ok(run.stdout.includes('nanomind > '), run.stdout);
  });

  for (const flag of ['--help', '-h']) {
    it(`describes the session and its pattern-based routing with ${flag}`, () => {
      const run = nanomind([flag]);
      assert.strictEqual(run.status, 0, run.stderr);
      assert.match(run.stdout, /Usage:/);
      assert.match(run.stdout, /interactive session/);
      assert.match(run.stdout, /fixed patterns/);
      assert.match(run.stdout, /no model is involved/);
      assert.ok(!run.stdout.includes('nanomind > '), 'help must not start a session');
    });
  }

  for (const flag of ['--version', '-v']) {
    it(`prints the package version with ${flag}`, () => {
      const run = nanomind([flag]);
      assert.strictEqual(run.status, 0, run.stderr);
      assert.strictEqual(run.stdout.trim(), manifest.version);
    });
  }

  it('rejects an unknown command instead of exiting silently', () => {
    const run = nanomind(['setup']);
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /Unknown command: setup/);
    assert.match(run.stderr, /Usage:/);
    assert.strictEqual(run.stdout, '');
  });

  it('rejects an unknown option', () => {
    const run = nanomind(['--frobnicate']);
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /Unknown option: --frobnicate/);
  });

  it('runs the command a request maps to and prints its output', { skip: process.platform === 'win32' }, () => {
    const run = nanomind([], { input: 'scan this project\n', path: fakeToolPath });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('Running: hackmyagent secure .'), run.stdout);
    assert.ok(run.stdout.includes('fake-hackmyagent secure .'), run.stdout);
  });

  it('says how to install the scanner when it is not on PATH', { skip: process.platform === 'win32' }, () => {
    const run = nanomind([], { input: 'scan this project\n' });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('hackmyagent was not found on PATH'), run.stdout);
    assert.ok(run.stdout.includes('npm install -g hackmyagent'), run.stdout);
  });

  it('refuses to run a command that a shell could reinterpret', () => {
    const { runCommand } = createRequire(import.meta.url)(bin);
    assert.throws(() => runCommand('hackmyagent secure', ['.;id']), /Refusing to run a command that contains "\.;id"/);
  });

  it('does not start a session when the package is imported', () => {
    const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(bin)})`], {
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, '');
  });
});
