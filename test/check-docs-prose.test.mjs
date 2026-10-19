import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkText, inScope, trackedDocs } from '../scripts/check-docs-prose.mjs';

const lines = (text) => checkText(text).map(({ line, rule }) => `${line}: ${rule}`);

const script = fileURLToPath(new URL('../scripts/check-docs-prose.mjs', import.meta.url));
const run = (path, args, options = {}) => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', ...options });

function scratch(t, files, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, 'docs-prose-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

// Scratch repositories are set up without the variables git exports to a
// hook, so a run of the tests from a git hook cannot reach the checkout the
// hook belongs to.
const plain = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, env: plain, encoding: 'utf8' });

// The files that git, run in cwd with the variables in env added to plain,
// lists for the pathspecs trackedDocs gives it.
const gitLists = (cwd, env = {}) =>
  spawnSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], { cwd, env: { ...plain, ...env }, encoding: 'utf8' })
    .stdout.split('\0')
    .filter(Boolean);

// A scratch repository holding files, of which the paths in tracked are added
// to its index, made inside parent when one is given. Returns null when git
// cannot be started; any other failure of git fails the test.
function scratchRepo(t, files, tracked = Object.keys(files), parent = tmpdir()) {
  const dir = scratch(t, files, parent);
  const init = git(dir, 'init', '-q');
  if (init.error) return null;
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  const add = git(dir, 'add', '--', ...tracked);
  assert.equal(add.status, 0, `git add failed: ${add.stderr}`);
  return dir;
}

// Runs fn with the variables in values set in process.env, then restores them.
function withEnv(values, fn) {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A stand-in for git that lists README.md and docs/guide.md and, for each
// variable of names that it receives, a file named after that variable, such
// as GIT_PREFIX.md. Returns the directory that holds it, to be put first on
// PATH, or null when it cannot be started.
function gitStandIn(t, names) {
  const checks = names.map((name) => `[ -z "\${${name}+set}" ] || printf '%s\\0' ${name}.md`);
  const bin = scratch(t, { git: ['#!/bin/sh', "printf '%s\\0' README.md docs/guide.md", ...checks, ''].join('\n') });
  chmodSync(join(bin, 'git'), 0o755);
  return spawnSync(join(bin, 'git')).error ? null : bin;
}

test('a dash used in prose is reported with its line', () => {
  const text = [
    '# Title',
    '',
    'The daemon runs locally -- no network call is made.',
    'The daemon runs locally — no network call is made.',
    'The daemon runs locally – no network call is made.',
    'An em dash without spaces—like this—is reported too.',
  ].join('\n');
  assert.deepEqual(lines(text), [
    '3: spaced double hyphen',
    '4: em dash',
    '5: spaced en dash',
    '6: em dash',
    '6: em dash',
  ]);
});

test('a dash in a table cell is reported', () => {
  assert.deepEqual(lines('| Model | Accuracy |\n|---|---|\n| planned | -- |\n'), ['3: spaced double hyphen']);
});

test('code, command lines, links, comments and front matter are not prose', () => {
  const text = [
    '---',
    'title: Front matter — not prose',
    '---',
    '',
    'Run `npm test -- --watch` or `node cli.js -- input`; pass ``a `--` b`` as is.',
    'Use the --model flag and an end-to-end check; pages 3–5 hold the table.',
    '[docs](https://example.com/a -- b) and <https://example.com/—> and https://example.com/x—y',
    '![badge — alt](https://img.shields.io/badge/a--b-green)',
    '<!-- an editor note -- not shown -->',
    '<!--',
    'a multi-line note — not shown',
    '-->',
    '```bash',
    'npm test -- --grep classifier',
    '# a comment — inside code',
    '```',
    '~~~',
    'text -- inside a tilde fence',
    '~~~',
    '    ````md',
    'still prose after an indented fence -- that is not a fence',
  ].join('\n');
  assert.deepEqual(lines(text), ['21: spaced double hyphen']);
});

test('a fence closes only on the same character and at least the same length', () => {
  const text = ['````md', '```', 'inside -- the outer fence', '```', '````', 'after -- the fence'].join('\n');
  assert.deepEqual(lines(text), ['6: spaced double hyphen']);
  const tilde = ['```', '~~~', 'inside -- the backtick fence', '```', 'after -- the fence'].join('\n');
  assert.deepEqual(lines(tilde), ['5: spaced double hyphen']);
});

test('a double or triple hyphen used as a dash is reported, a flag or a rule is not', () => {
  const text = [
    'The daemon runs locally --',
    'no network call is made.',
    'The daemon runs locally --- no network call is made.',
    'The daemon runs locally--no network call is made.',
    'Pass --model or --tier=fast for an end-to-end check; a ---- b and a --> b stay as they are.',
    '',
    '***',
    'A setext title',
    '--',
  ].join('\n');
  assert.deepEqual(lines(text), [
    '1: double hyphen at a line break',
    '3: spaced triple hyphen',
    '4: unspaced double hyphen',
  ]);
});

test('code in a block quote, a list item, an indented block or a code span across lines is not prose', () => {
  const text = [
    '> ```bash',
    '> npm test -- --watch',
    '> ```',
    '',
    'Text:',
    '',
    '    npm test -- --watch',
    '',
    '- Run:',
    '',
    '    ```bash',
    '    npm test -- --watch',
    '    ```',
    '- Or:',
    '\t```bash',
    '\tnpm test -- --watch',
    '\t```',
    '',
    'Run `npm test',
    'x -- --watch` now.',
    'Pass ``a -- `b`` as is.',
    '',
    'after -- the code',
  ].join('\n');
  assert.deepEqual(lines(text), ['23: spaced double hyphen']);
});

test('a table delimiter row is not prose, a dash in a body row is', () => {
  assert.deepEqual(lines('| A | B |\n| -- | -- |\n| 1 | 2 |'), []);
  assert.deepEqual(lines('| A | B |\n|---|---|\n| -- | -- |'), ['3: spaced double hyphen', '3: spaced double hyphen']);
});

test('comments hide only their own text, and autolinks are not prose', () => {
  const text = [
    '<!--',
    '```',
    '-->',
    'prose -- after a comment',
    '<!-- a note -->',
    'prose -- after a one-line comment',
    'text <!-- a note --> and -- after it',
    '<mailto:docs—team@example.com>',
  ].join('\n');
  assert.deepEqual(lines(text), ['4: spaced double hyphen', '6: spaced double hyphen', '7: spaced double hyphen']);
});

test('a code fence or comment that is never closed is reported', () => {
  assert.deepEqual(lines('```bash\nnpm test\n\nprose — after the fence'), ['1: code fence not closed']);
  assert.deepEqual(lines('text\n<!-- a note\nmore — text'), ['2: HTML comment not closed']);
});

test('a heading with a long run of spaces is checked in linear time', () => {
  const started = performance.now();
  assert.deepEqual(lines(`# a${' '.repeat(5000)}b`), []);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});

test('a section named "Why this exists" or "Why this matters" is reported', () => {
  const text = [
    '## Why this exists',
    '### why this matters:',
    '**Why this exists**',
    '_Why This Matters_',
    'Why this exists',
    '===============',
    'A sentence can say why this exists without naming a section.',
    '## Why this design was chosen',
  ].join('\n');
  const section = 'section named "Why this exists" or "Why this matters"';
  assert.deepEqual(lines(text), [`1: ${section}`, `2: ${section}`, `3: ${section}`, `4: ${section}`, `5: ${section}`]);
});

test('a "Why this exists" label with text after it, in a list item or block quote, or as a link is reported', () => {
  const text = [
    '**Why this exists:** a release shipped a defect.',
    '- **Why this exists**',
    '> ## Why this exists',
    '## [Why this exists](#why)',
    '1. _Why this matters_: the rule.',
    '## Knowing why this exists',
    '*Why* this exists is a sentence.',
  ].join('\n');
  const section = 'section named "Why this exists" or "Why this matters"';
  assert.deepEqual(lines(text), [`1: ${section}`, `2: ${section}`, `3: ${section}`, `4: ${section}`, `5: ${section}`]);
});

test('the command line prints usage, a clear error for an unknown option or unreadable file, and reads absolute paths', (t) => {
  const dir = scratch(t, { 'note.md': 'The daemon runs locally -- no network call.\n' });

  const help = run(script, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: /);

  const unknown = run(script, ['--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option --bogus/);

  const missing = run(script, [join(dir, 'missing.md')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read .*missing\.md \(ENOENT\)/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);

  const absolute = run(script, [join(dir, 'note.md')]);
  assert.equal(absolute.status, 1);
  assert.match(absolute.stderr, /note\.md:1: spaced double hyphen/);

  const relative = run(script, ['note.md'], { cwd: dir });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /^note\.md:1: spaced double hyphen/);
});

test('outside a git checkout the Markdown files on disk in scope are checked', (t) => {
  const dir = scratch(t, {
    'README.md': 'The daemon runs locally -- no network call.\n',
    'docs/guide.md': 'Plain prose.\n',
    'CHANGELOG.md': 'An old -- entry.\n',
    'node_modules/pkg/README.md': 'Vendored -- text.\n',
  });
  assert.deepEqual(trackedDocs(dir), ['README.md', 'docs/guide.md']);

  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-docs-prose.mjs'));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
  const result = run(join(dir, 'scripts', 'check-docs-prose.mjs'), [], { cwd: dir, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^README\.md:1: spaced double hyphen\n\n1 finding\(s\) in 1 file\(s\)/);
  assert.doesNotMatch(result.stderr, /fatal|\n\s+at /);
});

test('a directory that cannot be read outside a git checkout is reported with exit status 2', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('the superuser reads a directory without permission');
    return;
  }
  const dir = scratch(t, {
    'README.md': 'The daemon runs locally -- no network call.\n',
    'docs/guide.md': 'Plain prose.\n',
    'private/notes.md': 'Unreadable -- text.\n',
    'build/notes.md': 'Out of scope -- text.\n',
  });
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-docs-prose.mjs'));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };

  // A directory whose files are all out of scope is not needed, so it is not
  // reported when it cannot be read.
  chmodSync(join(dir, 'private'), 0o000);
  chmodSync(join(dir, 'build'), 0o000);
  try {
    const unreadable = [];
    assert.deepEqual(trackedDocs(dir, unreadable), ['README.md', 'docs/guide.md']);
    assert.deepEqual(unreadable.map(({ path, error }) => `${path} ${error.code}`), ['private/ EACCES']);

    const result = run(join(dir, 'scripts', 'check-docs-prose.mjs'), [], { cwd: dir, env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^README\.md:1: spaced double hyphen\ncheck-docs-prose: cannot read private\/ \(EACCES\)\n$/);
  } finally {
    chmodSync(join(dir, 'private'), 0o755);
    chmodSync(join(dir, 'build'), 0o755);
  }
});

test('a repository named in GIT_DIR, as a hook in a linked worktree receives it, does not replace the directory checked', (t) => {
  const repo = scratchRepo(t, { 'tracked.md': 'Tracked prose.\n' });
  if (repo === null) {
    t.skip('git cannot be started');
    return;
  }
  const gitDir = join(repo, '.git');
  const dir = scratch(t, {
    'README.md': 'The daemon runs locally -- no network call.\n',
    'docs/guide.md': 'Plain prose.\n',
  });

  assert.deepEqual(withEnv({ GIT_DIR: gitDir }, () => trackedDocs(dir)), ['README.md', 'docs/guide.md']);

  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-docs-prose.mjs'));
  const env = { ...plain, GIT_DIR: gitDir, GIT_CEILING_DIRECTORIES: dirname(dir) };
  const result = run(join(dir, 'scripts', 'check-docs-prose.mjs'), [], { cwd: dir, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^README\.md:1: spaced double hyphen\n\n1 finding\(s\) in 1 file\(s\)/);
  assert.doesNotMatch(result.stderr, /tracked\.md|fatal|\n\s+at /);
});

test('the repository and pathspec variables that change the files git lists do not change the files listed', (t) => {
  const repo = scratchRepo(t, { 'tracked.md': 'Tracked prose.\n' });
  // The checkout lies inside the work tree of repo, so git given a
  // GIT_WORK_TREE that names that work tree lists none of the checkout's
  // files. *.md matches docs/NOTES.MD only when case is ignored. docs/draft.md
  // is on disk but not tracked, so it shows when git lists no file and the
  // files on disk are listed instead.
  const dir = repo && scratchRepo(
    t,
    {
      'README.md': 'Plain prose.\n',
      'docs/guide.md': 'Plain prose.\n',
      'docs/NOTES.MD': 'Plain prose.\n',
      'docs/draft.md': 'Untracked prose.\n',
    },
    ['README.md', 'docs/guide.md', 'docs/NOTES.MD'],
    repo,
  );
  if (repo === null || dir === null) {
    t.skip('git cannot be started');
    return;
  }
  const missing = join(repo, 'missing');
  // GIT_PREFIX and GIT_ALTERNATE_OBJECT_DIRECTORIES are not here: git lists
  // the same files with either one set, so the next test shows with a
  // stand-in for git that neither reaches it.
  const settings = {
    GIT_DIR: join(repo, '.git'),
    GIT_WORK_TREE: repo,
    GIT_INDEX_FILE: join(repo, '.git', 'index'),
    GIT_COMMON_DIR: missing,
    GIT_OBJECT_DIRECTORY: missing,
    GIT_GLOB_PATHSPECS: '1',
    GIT_NOGLOB_PATHSPECS: '1',
    GIT_ICASE_PATHSPECS: '1',
    GIT_LITERAL_PATHSPECS: '1',
  };
  const expected = ['README.md', 'docs/guide.md'];
  assert.deepEqual(gitLists(dir), expected);
  for (const [name, value] of Object.entries(settings)) {
    assert.notDeepEqual(gitLists(dir, { [name]: value }), expected, `git with ${name}`);
    assert.deepEqual(withEnv({ [name]: value }, () => trackedDocs(dir)), expected, name);
  }
});

test('a stand-in for git receives none of the repository and pathspec variables, also those that do not change the files git lists', (t) => {
  const names = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
    'GIT_LITERAL_PATHSPECS',
  ];
  const bin = gitStandIn(t, names);
  if (bin === null) {
    t.skip('a script in the temporary directory cannot be started');
    return;
  }
  // The directory is empty, so trackedDocs lists README.md and docs/guide.md
  // in it only when the stand-in is the git it runs.
  const dir = scratch(t, {});
  const searchPath = `${bin}${delimiter}${process.env.PATH}`;
  for (const name of names) {
    const env = { PATH: searchPath, [name]: '1' };
    assert.deepEqual(gitLists(dir, env), ['README.md', 'docs/guide.md', `${name}.md`], `stand-in with ${name}`);
    assert.deepEqual(withEnv(env, () => trackedDocs(dir)), ['README.md', 'docs/guide.md'], name);
  }
});

test('each pathspec variable changes the files git matches for *.md, fewer or more, and none changes the files listed', (t) => {
  const dir = scratchRepo(t, {
    'README.md': 'Plain prose.\n',
    'docs/guide.md': 'Plain prose.\n',
    'docs/NOTES.MD': 'Plain prose.\n',
  });
  if (dir === null) {
    t.skip('git cannot be started');
    return;
  }
  const matched = (env) =>
    spawnSync('git', ['ls-files', '--', '*.md'], { cwd: dir, env: { ...plain, ...env }, encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean);
  assert.deepEqual(matched({}), ['README.md', 'docs/guide.md']);
  const listed = trackedDocs(dir);
  const withVariable = {
    GIT_GLOB_PATHSPECS: ['README.md'],
    GIT_NOGLOB_PATHSPECS: [],
    GIT_LITERAL_PATHSPECS: [],
    GIT_ICASE_PATHSPECS: ['README.md', 'docs/NOTES.MD', 'docs/guide.md'],
  };
  for (const [name, files] of Object.entries(withVariable)) {
    assert.deepEqual(matched({ [name]: '1' }), files, `git with ${name}`);
    assert.deepEqual(withEnv({ [name]: '1' }, () => trackedDocs(dir)), listed, name);
  }
});

test('the command line checks the files when its directory is reached through a symlink, as under /tmp or /var on macOS', (t) => {
  const dir = scratch(t, {
    'README.md': 'The daemon runs locally -- no network call.\n',
    'docs/guide.md': 'Plain prose.\n',
  });
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-docs-prose.mjs'));
  const link = join(scratch(t, {}), 'link');
  symlinkSync(dir, link, 'dir');
  assert.deepEqual(trackedDocs(link), ['README.md', 'docs/guide.md']);

  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
  const result = run(join(link, 'scripts', 'check-docs-prose.mjs'), [], { cwd: link, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^README\.md:1: spaced double hyphen\n\n1 finding\(s\) in 1 file\(s\)/);
});

test('changelogs, licenses, vendored and test data are out of scope', () => {
  for (const path of ['README.md', 'docs/SPECIFICATION.md', 'packages/nanomind-daemon/README.md', 'site/page.mdx']) {
    assert.equal(inScope(path), true, path);
  }
  for (const path of [
    'CHANGELOG.md',
    'packages/nanomind-router/CHANGELOG.md',
    'changelog.d/123.md',
    'LICENSE.md',
    'node_modules/pkg/README.md',
    'packages/x/dist/README.md',
    'test/fixtures/readme.md',
    'packages/x/corpus/sample.md',
    'packages/x/examples/input.md',
    'packages/x/__snapshots__/out.md',
    'notes.txt',
  ]) {
    assert.equal(inScope(path), false, path);
  }
});
