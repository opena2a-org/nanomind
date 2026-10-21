import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// The unit tests of @nanomind/runtime-core. They ship in its npm package, as
// its package.json lists src/ under files.
const TWIN_TESTS = 'packages/nanomind-runtime-core/src/runtime-twin.test.ts';

// This file, which names RuntimeTwin without loading it.
const THIS_FILE = relative(root, fileURLToPath(import.meta.url));

// Test files by name: JavaScript and TypeScript *.test.* and *.spec.* files,
// test_*.py, *_test.go and *_test.py.
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.(?:go|py))$/;

const NO_INTEGRATION_TESTS = 'No test in this repository runs the twin inside a real ARP EventEngine.';

test(`the header of ${TWIN_TESTS} says no test in this repository runs the twin inside a real ARP EventEngine, as none does`, () => {
  const others = tracked.filter(
    (path) => TEST_FILE.test(path) && path !== TWIN_TESTS && path !== THIS_FILE && /\bRuntimeTwin\b/.test(read(path)),
  );
  assert.deepEqual(others, [], `these tests name RuntimeTwin: say what they cover in the header of ${TWIN_TESTS} and update this test`);

  // What the twin's tests load: the package source and Node built-ins, so the
  // engine they attach the twin to is a stub they define.
  const loaded = [...read(TWIN_TESTS).matchAll(/\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(
    loaded.filter((specifier) => !specifier.startsWith('node:') && specifier !== './index.ts'),
    [],
    `${TWIN_TESTS} loads a module beside the package source and Node built-ins: if it gives the twin a real ARP EventEngine, say so in its header and update this test`,
  );

  // The header, with its comment prefixes dropped and each run of whitespace
  // made one space, so a sentence reads the same wherever its lines break.
  const header = /^\/\*\*((?:(?!\*\/)[\s\S])*)\*\//.exec(read(TWIN_TESTS))?.[1];
  assert.ok(header, `${TWIN_TESTS} does not start with a doc comment`);
  const text = header.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim();
  assert.ok(text.includes(NO_INTEGRATION_TESTS), `the header of ${TWIN_TESTS} does not say: ${NO_INTEGRATION_TESTS}`);
  assert.doesNotMatch(text, /\bhackmyagent\/\S/, `the header of ${TWIN_TESTS} cites a path in hackmyagent, which this repository cannot check`);
});
