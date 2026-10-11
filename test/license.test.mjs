import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootManifest = readJson(join(root, 'package.json'));

// SPDX identifier for each license text the repository could carry, keyed by
// a line that only that text contains.
const LICENSE_TEXTS = [
  { spdx: 'Apache-2.0', marker: /^\s*Apache License\s*$\n^\s*Version 2\.0, January 2004\s*$/m },
  { spdx: 'MIT', marker: /^MIT License\s*$/m },
];

function licenseOf(path) {
  const text = readFileSync(path, 'utf8');
  const found = LICENSE_TEXTS.filter(({ marker }) => marker.test(text));
  assert.equal(found.length, 1, `${relative(root, path)} is not a license text this test recognises`);
  return found[0].spdx;
}

function workspaceDirs() {
  return rootManifest.workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .filter((dir) => existsSync(join(dir, 'package.json')));
  });
}

// A package directory without its own LICENSE file is covered by the root one.
function expectedLicense(dir) {
  const own = join(dir, 'LICENSE');
  return existsSync(own) ? licenseOf(own) : licenseOf(join(root, 'LICENSE'));
}

const packages = [root, ...workspaceDirs()].map((dir) => ({
  dir,
  name: relative(root, dir) || '.',
  expected: expectedLicense(dir),
}));

test('finds the root package and the workspace packages', () => {
  assert.ok(packages.length > 1);
});

for (const { dir, name, expected } of packages) {
  test(`${name}/package.json declares the license its LICENSE file grants`, () => {
    assert.equal(readJson(join(dir, 'package.json')).license, expected);
  });

  const readme = join(dir, 'README.md');
  const section = existsSync(readme)
    ? /^## License\s*\n+([^\n]+)/m.exec(readFileSync(readme, 'utf8'))
    : null;
  if (section) {
    test(`${name}/README.md names the license its LICENSE file grants`, () => {
      const statement = section[1];
      const named = LICENSE_TEXTS.filter(({ spdx }) => new RegExp(`\\b${spdx.replace('.', '\\.')}\\b`).test(statement));
      assert.deepEqual(named.map(({ spdx }) => spdx), [expected], `License section reads: ${statement}`);
    });
  }
}

test('package-lock.json records the license each workspace package declares', () => {
  const lock = readJson(join(root, 'package-lock.json'));
  for (const { dir, name } of packages) {
    const key = relative(root, dir);
    const entry = lock.packages?.[key];
    assert.ok(entry, `package-lock.json has no entry for ${name}`);
    assert.equal(entry.license, readJson(join(dir, 'package.json')).license, `package-lock.json entry for ${name}`);
  }
});
