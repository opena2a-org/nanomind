import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkText, inScope } from '../scripts/check-docs-prose.mjs';

const lines = (text) => checkText(text).map(({ line, rule }) => `${line}: ${rule}`);

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
