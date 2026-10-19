import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// The GIT_ variables are removed so that git locates the repository from the
// working directory: with GIT_DIR or GIT_WORK_TREE set, git reads the
// repository or the working tree they name instead.
const plain = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const git = (...args) => spawnSync('git', args, { cwd: root, env: plain, encoding: 'utf8' });

// A tracked file under an ignored path is build output that git still carries:
// a build rewrites it, and the tracked copy goes stale whenever its source
// changes without a rebuild being committed. The daemon's dist/server.d.ts
// declared InferRequest.intent as required after the source made it optional.
test('no tracked file matches a .gitignore rule', (t) => {
  // Only the .gitignore files in the tree are read, so a contributor's global
  // or per-clone excludes do not change the result.
  const listed = git('ls-files', '-z', '--cached', '--ignored', '--exclude-per-directory=.gitignore');
  if (listed.error || listed.status !== 0) {
    // A source archive, or git is not installed.
    t.skip('not a git checkout');
    return;
  }

  const tracked = listed.stdout.split('\0').filter(Boolean);
  assert.deepEqual(
    tracked,
    [],
    'these tracked files match a .gitignore rule; stop tracking them with ' +
      `"git rm --cached -- <file>" and let the build produce them:\n${tracked.join('\n')}`,
  );
});

// The check started with GIT_DIR and GIT_WORK_TREE naming another repository,
// one that tracks a file under its own ignored path, checks this repository.
test('GIT_DIR and GIT_WORK_TREE naming another repository do not change the repository checked', (t) => {
  const here = git('rev-parse', '--show-toplevel');
  if (here.error || here.status !== 0) {
    t.skip('not a git checkout');
    return;
  }

  const other = mkdtempSync(join(tmpdir(), 'tracked-ignored-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(join(other, 'dist'));
  writeFileSync(join(other, '.gitignore'), 'dist/\n');
  writeFileSync(join(other, 'dist', 'out.js'), 'export {};\n');
  for (const args of [['init', '-q'], ['add', '-f', '--', '.gitignore', 'dist/out.js']]) {
    const step = spawnSync('git', args, { cwd: other, env: plain, encoding: 'utf8' });
    assert.equal(step.status, 0, `git ${args[0]} failed: ${step.stderr}`);
  }
  const named = { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other };

  // git started in this repository with the variables reads the other one.
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--ignored', '--exclude-per-directory=.gitignore'], {
    cwd: root,
    env: { ...plain, ...named },
    encoding: 'utf8',
  });
  assert.deepEqual(listed.stdout.split('\0').filter(Boolean), ['dist/out.js']);

  // Only the check above runs in the child. NODE_TEST_CONTEXT, which node
  // --test sets for each test file, is left out so that the child prints a TAP
  // report instead of the serialized one a test runner reads.
  const env = Object.fromEntries(Object.entries(plain).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const run = spawnSync(
    process.execPath,
    ['--test-reporter=tap', '--test-name-pattern=^no tracked file matches', fileURLToPath(import.meta.url)],
    { cwd: root, env: { ...env, ...named }, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /^ok \d+ - no tracked file matches a \.gitignore rule$/m);
});
