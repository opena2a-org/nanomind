import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(join(root, 'packages/nanomind-router/CHANGELOG.md'), 'utf8');

// The text under one `## <version>` heading, up to the next `## ` heading.
function entry(version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${version}`));
  assert.notEqual(start, -1, `CHANGELOG.md has no ## ${version} heading`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// What the published 0.1.3 type declarations export that 0.1.1's do not. The
// two releases are frozen on npm, so this list does not follow the source.
const ADDED_IN_0_1_3 = [
  'SCAN_SKILL_INTENT',
  'SCAN_SOUL_COMPLETENESS',
  'SCAN_MCP_SCOPE',
  'SCAN_PROMPT_INTENT',
  'SCAN_VERSION_DELTA',
  'SCAN_EXPLAIN',
  'isScanIntent',
  'ScanSkillResult',
  'ScanSoulResult',
  'ScanMCPResult',
  'ScanPromptResult',
  'ScanVersionDeltaResult',
  'ScanExplainResult',
];

test('the router 0.1.3 changelog entry names every intent, function and type added since 0.1.1', () => {
  const spans = entry('0.1.3').match(/`[^`\n]+`/g) ?? [];
  const missing = ADDED_IN_0_1_3.filter(
    (name) => !spans.some((span) => new RegExp(`\\b${name}\\b`).test(span)),
  );
  assert.deepEqual(missing, []);
});

test('the router 0.1.3 changelog entry does not say it has the same code as 0.1.1', () => {
  const text = entry('0.1.3');
  assert.doesNotMatch(text, /no code or API changes/i);
  assert.doesNotMatch(text, /same source as 0\.1\.1/i);
});
