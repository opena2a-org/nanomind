import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// @nanomind/cli depends on a published @nanomind/engine, so `nanomind setup`
// has its own copy of the engine's download code: the pinned URLs, sizes and
// SHA-256 sums, the default paths, and the checks a download passes before it
// is moved into place. The two copies have to stay the same file.
test('nanomind setup and the engine download with the same code and pins', () => {
  assert.equal(read('packages/nanomind-cli/src/download.ts'), read('packages/nanomind-engine/src/download.ts'));
});
