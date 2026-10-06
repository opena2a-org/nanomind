import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readManifest = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootManifest = readManifest(join(root, 'package.json'));

// --experimental-strip-types first shipped in Node.js 22.6.0; older releases
// exit 9 with "bad option" before any test runs.
const STRIP_TYPES_MIN = [22, 6, 0];

function workspaceManifests() {
  return rootManifest.workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const dir = join(root, pattern.slice(0, -2));
    return readdirSync(dir)
      .map((name) => join(dir, name, 'package.json'))
      .filter((path) => existsSync(path))
      .map((path) => ({ path, manifest: readManifest(path) }));
  });
}

function lowerBound(range) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

test('workspace test scripts that strip types are found', () => {
  const stripping = workspaceManifests().filter(({ manifest }) =>
    (manifest.scripts?.test ?? '').includes('--experimental-strip-types'),
  );
  assert.ok(stripping.length > 0, 'expected at least one workspace test script to pass --experimental-strip-types');
});

test('root manifest declares the Node.js minimum the workspace test scripts need', () => {
  const stripping = workspaceManifests().filter(({ manifest }) =>
    (manifest.scripts?.test ?? '').includes('--experimental-strip-types'),
  );
  if (stripping.length === 0) return;

  const range = rootManifest.engines?.node;
  assert.equal(typeof range, 'string', 'package.json must declare engines.node');
  const bound = lowerBound(range);
  assert.ok(bound, `engines.node must be a ">=X.Y.Z" range, found "${range}"`);
  assert.ok(
    compareVersions(bound, STRIP_TYPES_MIN) >= 0,
    `engines.node "${range}" admits Node.js releases without --experimental-strip-types, ` +
      `which ${stripping.map(({ manifest }) => manifest.name).join(', ')} pass in their test scripts; ` +
      `the minimum is >=${STRIP_TYPES_MIN.join('.')}`,
  );
});
