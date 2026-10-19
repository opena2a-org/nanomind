import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// The names in the router's IntentType union, read from its source as
// packages/nanomind-router/src/router.test.ts reads them. classifyIntent
// returns one of these, and UNKNOWN when no pattern matches the input.
const ROUTER_SOURCE = 'packages/nanomind-router/src/index.ts';
const union = read(ROUTER_SOURCE).match(/export type IntentType =([\s\S]*?);/)?.[1] ?? '';
const names = [...union.matchAll(/\|\s*'([A-Z_]+)'/g)].map((match) => match[1]);
const intents = names.filter((name) => name !== 'UNKNOWN');

// The pages that say how many intent types natural language is classified
// into. The router's module comment is emitted into dist/index.js and
// dist/index.d.ts by its build.
const PAGES = ['README.md', 'docs/cli-mode.md', ROUTER_SOURCE];

// The text with comment prefixes dropped and each run of whitespace made one
// space, so a sentence reads the same wherever its lines break.
const prose = (text) => text.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ');

test('IntentType is read from the router source', () => {
  assert.ok(names.includes('UNKNOWN'), `${ROUTER_SOURCE} has an IntentType union that names UNKNOWN`);
  assert.ok(intents.length > 0, `${ROUTER_SOURCE} names intents in IntentType`);
});

for (const page of PAGES) {
  test(`${page} says natural language is classified into one of the intents IntentType names or UNKNOWN`, () => {
    const text = prose(read(page));
    const stated = [...text.matchAll(/\b(\d+) intent types\b/gi)].map((match) => Number(match[1]));
    assert.ok(stated.length > 0, `${page} states a number of intent types`);
    assert.deepEqual(
      stated.filter((count) => count !== intents.length),
      [],
      `${page} states ${stated.join(', ')} intent types; IntentType names ${intents.length} intents plus UNKNOWN`,
    );
    const sentence = text.match(/classifies natural language (?:input )?into one of [^.]*/i)?.[0];
    assert.ok(sentence, `${page} says what natural language is classified into`);
    assert.match(sentence, new RegExp('^classifies natural language (?:input )?into one of ' + intents.length + ' intent types or `?UNKNOWN\\b', 'i'));
  });
}

test('the README intent table lists each intent IntentType names', () => {
  const readme = read('README.md');
  const heading = readme.match(/^### (?:\d+ )?Intent Types$/m);
  assert.ok(heading, 'README.md has an Intent Types section');
  const end = readme.indexOf('\n### ', heading.index + 1);
  const section = readme.slice(heading.index, end === -1 ? undefined : end);
  const listed = [...section.matchAll(/^\| [^|]+ \| ([^|]+) \|$/gm)]
    .flatMap((row) => row[1].replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/\([^)]*\)/g, '').split(','))
    .map((cell) => cell.trim())
    .filter((cell) => /^[A-Z_]+$/.test(cell));
  assert.deepEqual([...listed].sort(), [...intents].sort());
});
