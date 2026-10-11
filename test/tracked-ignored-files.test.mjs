import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// git finds the repository from cwd alone, not from the variables a git hook exports.
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
