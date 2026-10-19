import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const lock = readJson(join(root, 'package-lock.json'));

function workspaceDirs() {
  return readJson(join(root, 'package.json')).workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .filter((dir) => existsSync(join(dir, 'package.json')));
  });
}

// Changing a version in package.json alone leaves the old version recorded in
// package-lock.json; `npm install --package-lock-only` records the new one.
for (const dir of [root, ...workspaceDirs()]) {
  const key = relative(root, dir);
  const name = key || '.';
  test(`package-lock.json records the name and version ${name}/package.json declares`, () => {
    const manifest = readJson(join(dir, 'package.json'));
    const entry = lock.packages?.[key];
    assert.ok(entry, `package-lock.json has no entry for ${name}`);
    assert.deepEqual(
      { name: entry.name, version: entry.version },
      { name: manifest.name, version: manifest.version },
      `package-lock.json entry for ${name}; run npm install --package-lock-only`,
    );
  });
}
