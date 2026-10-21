import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const PACKAGE = 'packages/nanomind-runtime-core';
const manifest = JSON.parse(read(`${PACKAGE}/package.json`));
const readme = read(`${PACKAGE}/README.md`);
const source = read(`${PACKAGE}/src/index.ts`);

// The README's level-two sections by heading; the text above the first one is
// keyed by the empty string.
const sections = new Map(readme.split(/^(?=## )/m).map((text) => [/^## (.+)/.exec(text)?.[1].trim() ?? '', text]));

test('the description and the README do not call the scorer an LSTM, which src/index.ts does not contain', () => {
  assert.doesNotMatch(source, /\bLSTM\b/i);
  assert.doesNotMatch(manifest.description, /\bLSTM\b/i);
  assert.doesNotMatch(readme, /\bLSTM\b/i);
});

test('the README gives the number of events src/index.ts builds the baseline from', () => {
  const sizes = [...new Set([...source.matchAll(/\btotalEvents < (\d+)\b/g)].map((match) => match[1]))];
  assert.equal(sizes.length, 1, `src/index.ts compares totalEvents with one size, found: ${sizes.join(', ')}`);
  assert.match(readme, new RegExp(`\\bfirst ${sizes[0]} events\\b`));
});

test('the README names the type scoreARPEvent returns and no type src/index.ts does not export', () => {
  const exported = new Set([...source.matchAll(/^export (?:interface|type|class) (\w+)/gm)].map((match) => match[1]));
  const returned = /^\s*scoreARPEvent\([^)]*\):\s*(\w+)/m.exec(source)?.[1];
  assert.ok(exported.has(returned), `scoreARPEvent returns ${returned}, which src/index.ts does not export`);
  assert.ok(readme.includes(`\`${returned}\``), `the README does not name \`${returned}\``);
  const named = new Set([...readme.matchAll(/`([A-Z][A-Za-z0-9]*)`/g)].map((match) => match[1]));
  assert.deepEqual([...named].filter((name) => !exported.has(name)), []);
});

test('the README names drift detection only as work outside this package', () => {
  assert.doesNotMatch(source, /\bdrift\b/i);
  for (const [heading, text] of sections) {
    if (heading === 'What does NOT belong here') continue;
    assert.doesNotMatch(text, /\bdrift\b/i, `the ${heading ? `"${heading}"` : 'opening'} section names drift detection`);
  }
});

test('the files package.json lists under files cite no path in hackmyagent, which this repository cannot check', () => {
  // Tracked files only: dist/ is build output.
  const tracked = execFileSync('git', ['ls-files', '-z', '--', PACKAGE], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const listed = tracked.filter((path) =>
    manifest.files.some((entry) => (entry.endsWith('/') ? path.startsWith(`${PACKAGE}/${entry}`) : path === `${PACKAGE}/${entry}`)),
  );
  assert.ok(
    listed.includes(`${PACKAGE}/README.md`) && listed.includes(`${PACKAGE}/src/index.ts`),
    `the tracked files package.json lists under files do not include README.md and src/index.ts: ${listed.join(', ')}`,
  );
  assert.deepEqual(
    listed.filter((path) => /\bhackmyagent\/\S/.test(read(path))),
    [],
    'these files cite a path in hackmyagent: say what this repository can check instead',
  );
});

test('the README status calls the package published, as package.json and the release workflow have it', () => {
  assert.notEqual(manifest.private, true, 'package.json marks the package private');
  assert.ok(read('.github/workflows/release.yml').includes(PACKAGE), `the release workflow does not name ${PACKAGE}`);
  const status = sections.get('Status');
  assert.ok(status, 'the README has no Status section');
  assert.match(status, /\bpublished on npm\b/i);
  assert.doesNotMatch(status, /\bprivate\b|\bunpublished\b|\bpending publication\b|\bwhen the package is published\b/i);
});
