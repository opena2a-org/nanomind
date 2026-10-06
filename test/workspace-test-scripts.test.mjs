import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workspaceDirs() {
  return readJson(join(root, 'package.json')).workspaces.flatMap((pattern) => {
    if (!pattern.includes('*')) return [join(root, pattern)];
    assert.ok(pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*'), `unsupported workspace pattern ${pattern}`);
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  }).filter((dir) => existsSync(join(dir, 'package.json')));
}

// Workspaces whose test script runs TypeScript files directly.
const typeScriptTests = workspaceDirs()
  .map((dir) => ({ dir, script: readJson(join(dir, 'package.json')).scripts?.test }))
  .filter(({ script }) => typeof script === 'string' && /\.[cm]?ts\b/.test(script));

describe('workspace test scripts', () => {
  let probe;

  before(() => {
    probe = mkdtempSync(join(tmpdir(), 'strip-types-'));
    writeFileSync(join(probe, 'typed.ts'), 'const exitCode: number = 0;\nprocess.exitCode = exitCode;\n');
  });

  after(() => rmSync(probe, { recursive: true, force: true }));

  it('finds the workspaces that run TypeScript tests', () => {
    assert.ok(typeScriptTests.length > 0);
  });

  for (const { dir, script } of typeScriptTests) {
    const name = relative(root, dir);

    it(`${name} turns on type stripping in its test script`, () => {
      const [command, ...args] = script.trim().split(/\s+/);
      assert.strictEqual(command, 'node', `${name}: test script does not start with node: ${script}`);
      const nodeFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--test' && !arg.startsWith('--test-'));

      // Node 22 before 22.18 does not strip types by default, and Node 24 does, so a
      // script without the flag passes in CI. A flag in the script overrides NODE_OPTIONS.
      const run = spawnSync(process.execPath, [...nodeFlags, join(probe, 'typed.ts')], {
        env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' },
        encoding: 'utf8',
      });

      assert.strictEqual(run.status, 0, `${name}: ${script}\n${run.stderr}`);
    });
  }
});
