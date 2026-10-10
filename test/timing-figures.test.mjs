import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('nanomind-models.json'));

// How long a model or a scorer takes on one request depends on the machine and
// the backend it runs on, and nothing in this repository records a measurement
// (host, backend, date and the run it came from) that would make a fixed
// figure in the README, a model card or the model manifest true on a reader's
// machine. These are the shapes such a figure takes in prose: a duration, a
// per-token time, a token or inference rate, and "sub-millisecond".
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

// Read from the manifest, so the card of a new analyst version is checked too.
function analystModelCards() {
  const versions = manifest.models['nanomind-security-analyst'].versions;
  return [...new Set(Object.values(versions).map((record) => record.modelCard).filter(Boolean))];
}

test('the analyst model card states no timing figure', () => {
  const cards = analystModelCards();
  assert.ok(cards.length > 0, 'the manifest lists no model card for the analyst');
  assert.deepEqual(cards.flatMap(timingHits), []);
});

test('the analyst model card names the reply fields that carry the measured time', () => {
  const nlm = read('packages/nanomind-analyst/src/nanomind_analyst/daemon/_nlm.py');
  for (const path of analystModelCards()) {
    const card = read(path);
    assert.ok(card.includes('`nanomind-analyst`'), `${path} does not name nanomind-analyst`);
    for (const field of ['nlmLatencyMs', 'nlmTokenCount']) {
      assert.ok(card.includes(`\`${field}\``), `${path} does not name ${field}`);
      assert.ok(nlm.includes(`"${field}":`), `the analyst daemon reply carries no ${field}`);
    }
  }
});

// The manifest records no model card for the classifier; its cards are the
// files under docs/model-cards, one per version, so a new card is checked too.
function classifierModelCards() {
  return readdirSync(join(root, 'docs/model-cards'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/model-cards/${name}`);
}

test('no classifier model card states a timing figure', () => {
  const cards = classifierModelCards();
  assert.ok(cards.length > 0, 'docs/model-cards holds no model card');
  assert.deepEqual(cards.flatMap(timingHits), []);
});

test('the card of the classifier version the daemon serves names latencyMs as the measured time', () => {
  const engine = read('packages/nanomind-daemon/src/onnx-engine.ts');
  const served = engine.match(/readonly modelVersion = 'nanomind-tme-v(\d+\.\d+\.\d+)';/);
  assert.ok(served, 'onnx-engine.ts declares no modelVersion');
  const path = `docs/model-cards/v${served[1]}.md`;
  const card = read(path);
  const name = JSON.parse(read('packages/nanomind-daemon/package.json')).name;
  assert.ok(card.includes(`\`${name}\``), `${path} does not name ${name}`);
  assert.ok(card.includes('`latencyMs`'), `${path} does not name latencyMs`);
});

// @nanomind/engine runs a model through llamafile on the reader's machine, so
// the time a call takes is that machine's, and infer() measures it per call.
const ENGINE_FILES = ['packages/nanomind-engine/README.md', 'packages/nanomind-engine/src/index.ts'];

test('the engine README and source state no timing figure', () => {
  assert.deepEqual(ENGINE_FILES.flatMap(timingHits), []);
});

test('the engine README names latencyMs as the time infer measures for each call', () => {
  const readme = read('packages/nanomind-engine/README.md');
  assert.ok(readme.includes('`latencyMs`'), 'the engine README does not name latencyMs');

  const source = read('packages/nanomind-engine/src/index.ts');
  const result = source.match(/export interface InferenceResult \{[\s\S]*?\n\}/);
  assert.ok(result, 'index.ts declares no InferenceResult');
  assert.match(result[0], /\n\s*latencyMs: number;/);
  assert.match(source, /const latencyMs = Date\.now\(\) - start;/);
});

// A metric in the manifest reads as a measurement, and the manifest has no
// place beside it for the host, backend, date and run, so it records no timing
// metric (a latency, a per-token time or a rate) for any model version.
const TIMING_METRIC = /[Ll]atenc|PerSec|PerToken|Ms(?:[A-Z]|$)|Seconds?(?:[A-Z]|$)/;

test('no model version in the manifest records a timing metric', () => {
  const hits = [];
  for (const [model, entry] of Object.entries(manifest.models)) {
    for (const [version, record] of Object.entries(entry.versions ?? {})) {
      for (const key of Object.keys(record.metrics ?? {})) {
        if (TIMING_METRIC.test(key)) hits.push(`${model} ${version} metrics.${key}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
