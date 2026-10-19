import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('nanomind-models.json'));

// The manifest decides which classifier version is current, so the checks
// below follow it to the next version without an edit.
const CLASSIFIER = 'nanomind-security-classifier';
const classifier = manifest.models[CLASSIFIER];
const latest = classifier.latestVersion;
const SPEC = 'docs/SPECIFICATION.md';
const CARDS = 'docs/model-cards';

// The lines under the first heading that `heading` matches, up to the next
// heading of the same or a higher level. A line in a code fence is no heading.
function sectionLines(path, heading) {
  const lines = read(path).split('\n');
  let fenced = false;
  const levels = lines.map((line) => {
    if (line.startsWith('```')) fenced = !fenced;
    return fenced ? 0 : (/^(#{1,6}) /.exec(line)?.[1].length ?? 0);
  });
  const start = lines.findIndex((line, index) => levels[index] > 0 && heading.test(line));
  assert.ok(start >= 0, `${path} has no heading matching ${heading}`);
  const end = levels.findIndex((level, index) => index > start && level > 0 && level <= levels[start]);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

const specSection = (number) => sectionLines(SPEC, new RegExp(`^#+ ${number.replaceAll('.', '\\.')}\\.? `));

// The first table in `lines`: its header cells, and its rows keyed by them.
function firstTable(lines) {
  const start = lines.findIndex((line) => line.startsWith('|'));
  assert.ok(start >= 0, 'the section has no table');
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('|'));
  const [header, , ...body] = lines
    .slice(start, end < 0 ? undefined : end)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  return { header, rows: body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]]))) };
}

// Each card under docs/model-cards, with the model and version its title names.
function modelCards() {
  return readdirSync(join(root, CARDS))
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const path = `${CARDS}/${name}`;
      const title = read(path).match(/^# Model Card: (\S+) v(\d+\.\d+\.\d+)$/m);
      assert.ok(title, `${path} has no "# Model Card: <model> v<version>" title`);
      return { path, model: title[1], version: title[2] };
    });
}

function latestCard() {
  const card = modelCards().find(({ model, version }) => model === CLASSIFIER && version === latest);
  assert.ok(card, `${CARDS} has no card for ${CLASSIFIER} v${latest}`);
  return card;
}

test('each classifier model card states the status the manifest records for its version', () => {
  const cards = modelCards();
  assert.ok(cards.length > 0, `${CARDS} holds no model card`);
  for (const { path, model, version } of cards) {
    const record = manifest.models[model]?.versions?.[version];
    assert.ok(record, `${path} is for a version the manifest does not list`);
    const status = read(path).match(/^\*\*Status:\*\* (.+)$/m);
    assert.ok(status, `${path} has no Status line`);
    assert.equal(status[1].trim(), record.status, path);
  }
});

test('the specification calls only the latest classifier version current and latest', () => {
  const current = [...read(SPEC).matchAll(/Current \(v(\d+\.\d+\.\d+)\)/g)].map((match) => match[1]);
  assert.ok(current.length > 0, `${SPEC} labels no version as current`);
  assert.deepEqual([...new Set(current)], [latest]);

  const row = firstTable(specSection('4.1')).rows.find((entry) => entry.Model === CLASSIFIER);
  assert.ok(row, `section 4.1 has no ${CLASSIFIER} row`);
  assert.equal(row.Status, `v${latest} (latest)`);
});

test('section 2.1 gives the figures recorded for the latest classifier version', () => {
  const { header, rows } = firstTable(specSection('2.1'));
  const column = `Current (v${latest})`;
  assert.equal(header[1], column);
  const value = (metric) => rows.find((row) => row.Metric === metric)?.[column];

  const { metrics } = classifier.versions[latest];
  assert.equal(value('Overall accuracy'), `${(metrics.evalAccuracy * 100).toFixed(2)}%`);
  assert.equal(value('Macro F1'), metrics.macroF1.toFixed(3));
  assert.equal(value('Training samples'), metrics.trainSamples.toLocaleString('en-US'));
  assert.equal(value('Eval samples'), metrics.evalSamples.toLocaleString('en-US'));

  // The weakest and strongest classes are those of the card's per-class table;
  // a row names every class that ties for the lowest or highest F1.
  const perClass = firstTable(sectionLines(latestCard().path, /^### Per-Class$/)).rows;
  const scores = perClass.map((row) => Number(row.F1));
  for (const [label, f1] of [['Weakest class', Math.min(...scores)], ['Strongest class', Math.max(...scores)]]) {
    const row = rows.find((entry) => entry.Metric.startsWith(label));
    assert.ok(row, `section 2.1 has no ${label} row`);
    assert.equal(row[column], `${f1.toFixed(3)} F1`, row.Metric);
    for (const entry of perClass.filter((candidate) => Number(candidate.F1) === f1)) {
      assert.ok(row.Metric.includes(entry.Class), `"${row.Metric}" does not name ${entry.Class}`);
    }
  }
});

// Section 2.1 explains the figures of its table, which shows the latest
// version only, so a figure it explains for another version is not one it
// shows.
test('section 2.1 names no classifier version but the latest, the one its table shows', () => {
  const named = [...specSection('2.1').join('\n').matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((match) => match[1]);
  assert.ok(named.length > 0, 'section 2.1 names no version');
  assert.deepEqual([...new Set(named)], [latest]);
});

// A card can report more than one checkpoint of a training run, so section 2.1
// says which one its F1 figures belong to. Each class answers recall x support
// of its eval samples correctly, so the per-class table of the latest card
// counts the samples its checkpoint answered correctly: that count has to make
// up the overall accuracy the section gives, the section has to state it, and
// the macro F1 has to be the mean of the table's F1 column.
test('section 2.1 takes its F1 figures from a per-class table that counts its overall accuracy, and gives that count', () => {
  const lines = specSection('2.1');
  const { rows } = firstTable(lines);
  const value = (metric) => rows.find((row) => row.Metric === metric)?.[`Current (v${latest})`];

  const perClass = firstTable(sectionLines(latestCard().path, /^### Per-Class$/)).rows;
  const total = perClass.reduce((sum, row) => sum + Number(row.Support), 0);
  const correct = perClass.reduce((sum, row) => sum + Math.round(Number(row.Recall) * Number(row.Support)), 0);
  assert.equal(`${((100 * correct) / total).toFixed(2)}%`, value('Overall accuracy'), 'the per-class table does not count the overall accuracy');
  const meanF1 = perClass.reduce((sum, row) => sum + Number(row.F1), 0) / perClass.length;
  assert.equal(meanF1.toFixed(3), value('Macro F1'), 'the macro F1 is not the mean of the per-class F1 column');

  const prose = lines.filter((line) => !line.startsWith('|')).join(' ');
  assert.ok(prose.includes(`${correct} of the ${total} eval samples`), `section 2.1 does not say its per-class table counts ${correct} of the ${total} eval samples correct`);
});

test('sections 7.2 and 10.2 give the size the latest classifier card records', () => {
  const architecture = firstTable(sectionLines(latestCard().path, /^## Architecture$/)).rows;
  const size = (parameter) => architecture.find((row) => row.Parameter === parameter)?.Value;

  const sizes = firstTable(specSection('7.2')).rows.filter((row) => row.Model === 'security-classifier');
  for (const row of sizes) {
    const version = row.Version.match(/^v(\d+\.\d+\.\d+) \(([\w-]+)\)$/);
    assert.ok(version, `section 7.2 version "${row.Version}" does not read v<version> (<status>)`);
    assert.equal(version[2], classifier.versions[version[1]]?.status, `section 7.2 row ${row.Version}`);
  }
  const current = sizes.find((row) => row.Version === `v${latest} (latest)`);
  assert.ok(current, `section 7.2 has no row for v${latest}`);
  assert.equal(current['ONNX Size'], size('ONNX model size'));
  assert.equal(current['Data Size'], size('ONNX data size'));
  assert.equal(current.Tokenizer, size('Tokenizer size'));
  assert.equal(current.Total, size('Total size'));

  const evolution = firstTable(specSection('10.2')).rows.find((row) => row.Phase === 'Current');
  assert.ok(evolution, 'section 10.2 has no Current row');
  assert.equal(evolution['Size Budget'], `${size('Total size')} (v${latest})`);
});

test('section 3.8 names the daemon OnnxEngine, not the llamafile engine, for threat classification', () => {
  assert.match(read('packages/nanomind-daemon/src/onnx-engine.ts'), /\nexport class OnnxEngine \{/);
  const daemon = JSON.parse(read('packages/nanomind-daemon/package.json')).name;
  const engine = JSON.parse(read('packages/nanomind-engine/package.json')).name;
  assert.match(read('packages/nanomind-engine/src/index.ts'), /Wraps llamafile/);

  const row = firstTable(specSection('3.8')).rows.find((entry) => /threat classification/i.test(entry.Mode));
  assert.ok(row, 'section 3.8 has no threat classification row');
  assert.ok(row.Package.includes(daemon), `"${row.Package}" does not name ${daemon}`);
  assert.ok(row.Package.includes('`OnnxEngine`'), `"${row.Package}" does not name OnnxEngine`);
  assert.ok(!row.Package.includes(engine), `"${row.Package}" names ${engine}`);
});

test('section 1 names the commands users run and does not say they never use NanoMind directly', () => {
  const text = specSection('1').join(' ');
  assert.doesNotMatch(text, /never interact/i);

  const bins = readdirSync(join(root, 'packages')).flatMap((dir) => {
    const path = join(root, 'packages', dir, 'package.json');
    return existsSync(path) ? Object.keys(JSON.parse(readFileSync(path, 'utf8')).bin ?? {}) : [];
  });
  assert.ok(bins.length > 0, 'no package declares a bin');
  assert.match(read('packages/nanomind-analyst/pyproject.toml'), /^nanomind-analyst = /m);
  for (const command of [...bins, 'nanomind-analyst']) {
    assert.ok(text.includes(`\`${command}\``), `section 1 does not name ${command}`);
  }
});
