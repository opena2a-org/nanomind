import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const PLAYBOOK = 'docs/TRAINING-PLAYBOOK.md';
const PRIVATE_SECTION = /^### 2\.4 Scripts that are not in this repository\s*$/m;

// "In this repository" means tracked by git. A maintainer's checkout can hold
// the ignored training tree on disk, so the file system is not the test.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const trim = (path) => path.replace(/\/+$/, '');
const isUnder = (path, prefix) => trim(path) === trim(prefix) || trim(path).startsWith(`${trim(prefix)}/`);
const inRepository = (path) => tracked.some((file) => isUnder(file, path));

// Repository-relative paths under training/ or scripts/, the two roots the
// playbook runs scripts from. ../nanomind-training/corpus and the like belong
// to the other repository and are not matched.
const SCRIPT_ROOT_PATH = /(?<![\w./-])(?:training|scripts)\/[\w.{}/-]*/g;

function referencedPaths(text) {
  return [...new Set(text.match(SCRIPT_ROOT_PATH) ?? [])];
}

// The paths section 2.4 lists, one per bullet, as the bullet's first code span.
function declaredPrivatePaths(text) {
  const start = text.search(PRIVATE_SECTION);
  if (start === -1) return [];
  const body = text.slice(start).split('\n').slice(1);
  const end = body.findIndex((line) => /^#{1,3} /.test(line));
  return (end === -1 ? body : body.slice(0, end))
    .map((line) => line.match(/^- `([^`]+)`/))
    .filter(Boolean)
    .map((match) => match[1]);
}

// Every `git add` command in a fenced block, with its continuation lines joined.
function gitAddArguments(text) {
  const blocks = text.match(/^```[^\n]*\n[\s\S]*?^```/gm) ?? [];
  const commands = blocks.flatMap((block) => block.replace(/\\\n\s*/g, ' ').split('\n'));
  return commands
    .map((line) => line.trim())
    .filter((line) => line.startsWith('git add '))
    .flatMap((line) => line.split(/\s+/).slice(2));
}

const playbook = read(PLAYBOOK);
const declared = declaredPrivatePaths(playbook);

test('every script path the training playbook names is in this repository or listed in section 2.4', () => {
  const unlisted = referencedPaths(playbook).filter(
    (path) => !inRepository(path) && !declared.some((prefix) => isUnder(path, prefix)),
  );
  assert.deepEqual(unlisted, []);
});

test('every path section 2.4 lists as not in this repository is absent from it', () => {
  assert.deepEqual(declared.filter(inRepository), []);
});

test('the training tree section 2.4 lists is ignored by .gitignore, as the playbook says', () => {
  if (!declared.includes('training/')) return;
  const ignored = read('.gitignore').split('\n').map((line) => line.trim());
  assert.ok(ignored.includes('training/'), '.gitignore does not list training/');
  assert.match(playbook, /`training\/` is listed in `\.gitignore`/);
});

test('the playbook never stages a path that is not in this repository', () => {
  const args = gitAddArguments(playbook);
  assert.ok(args.length > 0, 'the playbook has no git add command');
  assert.deepEqual(args.filter((arg) => arg === '-f' || arg === '--force'), []);
  assert.deepEqual(args.filter((arg) => declared.some((prefix) => isUnder(arg, prefix))), []);
});
