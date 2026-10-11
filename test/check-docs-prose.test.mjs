import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkText, inScope, trackedDocs } from '../scripts/check-docs-prose.mjs';

const lines = (text) => checkText(text).map(({ line, rule }) => `${line}: ${rule}`);

const script = fileURLToPath(new URL('../scripts/check-docs-prose.mjs', import.meta.url));
const run = (path, args, options = {}) => spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', ...options });

function scratch(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-prose-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
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

test('a repository named in GIT_DIR, as a git hook sets it, does not replace the directory checked', (t) => {
  // The scratch repository is set up without the variables under test, so a
  // run from a git hook cannot reach the checkout the hook belongs to.
  const plain = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, env: plain, encoding: 'utf8' });

  const repo = scratch(t, { 'tracked.md': 'Tracked prose.\n' });
  if (git(repo, 'init', '-q').status !== 0 || git(repo, 'add', 'tracked.md').status !== 0) {
    t.skip('git is not available');
    return;
  }
  const gitDir = join(repo, '.git');
  const dir = scratch(t, {
    'README.md': 'The daemon runs locally -- no network call.\n',
    'docs/guide.md': 'Plain prose.\n',
  });

  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = gitDir;
  try {
    assert.deepEqual(trackedDocs(dir), ['README.md', 'docs/guide.md']);
  } finally {
    if (before === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before;
  }

  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-docs-prose.mjs'));
  const env = { ...plain, GIT_DIR: gitDir, GIT_CEILING_DIRECTORIES: dirname(dir) };
  const result = run(join(dir, 'scripts', 'check-docs-prose.mjs'), [], { cwd: dir, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^README\.md:1: spaced double hyphen\n\n1 finding\(s\) in 1 file\(s\)/);
  assert.doesNotMatch(result.stderr, /tracked\.md|fatal|\n\s+at /);
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
