import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// Each adapter's entry point, tracked by git.
const adapters = execFileSync('git', ['ls-files', '-z', '--', 'integrations/*/index.ts'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// The Registry address an adapter's session uses when OPENA2A_REGISTRY_URL is not set.
const FALLBACK = /registryUrl:\s*process\.env\.OPENA2A_REGISTRY_URL\s*\|\|\s*'([^']+)'/;

function fallbackAddress() {
  assert.ok(adapters.length > 0, 'no adapter entry point under integrations/');
  const addresses = adapters.map((file) => [file, read(file).match(FALLBACK)?.[1]]);
  assert.deepEqual(addresses.filter(([, address]) => !address).map(([file]) => file), []);
  const distinct = [...new Set(addresses.map(([, address]) => address))];
  assert.equal(distinct.length, 1, `adapters fall back to different addresses: ${distinct.join(', ')}`);
  return distinct[0];
}

function registryEntry() {
  const entries = read('docs/integrations.md')
    .split('\n')
    .filter((line) => line.startsWith('- ') && line.includes('OpenA2A Registry'));
  assert.equal(entries.length, 1, 'docs/integrations.md has no single OpenA2A Registry entry');
  return entries[0];
}

test('the Registry entry gives the address the adapters use by default', () => {
  assert.ok(registryEntry().includes(`\`${fallbackAddress()}\``));
});

// The Registry's source repository is not public, so a link to it answers 404
// to a reader.
test('the Registry entry links no GitHub repository', () => {
  assert.doesNotMatch(registryEntry(), /\]\(https:\/\/github\.com\//);
});
