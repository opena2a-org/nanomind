import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// How long a model or a scorer takes on one request depends on the machine and
// the backend it runs on, and nothing in this repository records a measurement
// (host, backend, date and the run it came from) that would make a fixed
// figure in the README true on a reader's machine. These are the shapes such a
// figure takes: a duration, a per-token time, a token or inference rate, and
// "sub-millisecond".
const TIMING_PATTERNS = [
  /\d[\d,.]*\s*(?:ms|µs|μs|milliseconds?|microseconds?)\b/gi,
  /ms\s*(?:\/|per)\s*token/gi,
  /\btok(?:en)?s?\s*(?:\/|per)\s*s(?:ec(?:ond)?)?\b/gi,
  /\binf(?:erences?)?\s*(?:\/|per)\s*s(?:ec(?:ond)?)?\b/gi,
  /\bsub-?\s*milli(?:second)?/gi,
  /\d[\d.]*\s*(?:s|sec|seconds?)\s+(?:per|\/)\s*(?:finding|request|token|event|inference)\b/gi,
];

// Every figure on every line, so a line that states two is reported twice.
function timingHits(path) {
  const hits = [];
  read(path).split('\n').forEach((line, index) => {
    for (const pattern of TIMING_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        hits.push(`${path}:${index + 1}: ${JSON.stringify(match[0])}`);
      }
    }
  });
  return hits;
}

test('the README states no timing figure for a model or the runtime scorer', () => {
  assert.deepEqual(timingHits('README.md'), []);
});

test('the classifier daemon the README names measures each request as latencyMs', () => {
  const readme = read('README.md');
  const name = JSON.parse(read('packages/nanomind-daemon/package.json')).name;
  assert.ok(readme.includes(`\`${name}\``), `README does not name ${name}`);
  assert.ok(readme.includes('`latencyMs`'), 'README does not name latencyMs');

  const server = read('packages/nanomind-daemon/src/server.ts');
  const reply = server.match(/export interface InferResponse \{[\s\S]*?\n\}/);
  assert.ok(reply, 'server.ts declares no InferResponse');
  assert.match(reply[0], /\n\s*latencyMs: number;/);
  assert.match(server, /latencyMs: Date\.now\(\) - startMs,/);
});

test('the analyst daemon the README names reports nlmLatencyMs and nlmTokenCount', () => {
  const readme = read('README.md');
  const name = read('packages/nanomind-analyst/pyproject.toml').match(/^name = "([^"]+)"/m)[1];
  assert.ok(readme.includes(`\`${name}\``), `README does not name ${name}`);

  const nlm = read('packages/nanomind-analyst/src/nanomind_analyst/daemon/_nlm.py');
  for (const field of ['nlmLatencyMs', 'nlmTokenCount']) {
    assert.ok(readme.includes(`\`${field}\``), `README does not name ${field}`);
    assert.ok(nlm.includes(`"${field}":`), `the analyst daemon reply carries no ${field}`);
  }
});
