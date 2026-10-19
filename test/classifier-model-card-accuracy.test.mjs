import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('nanomind-models.json'));

// The manifest records no model card for the classifier; its cards are the
// files under docs/model-cards, one per version, so a new card is checked too.
function classifierModelCards() {
  return readdirSync(join(root, 'docs/model-cards'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/model-cards/${name}`);
}

// The heading at this level that starts with title, and the text under it up
// to the next heading at that level or above. The rest of the heading is where
// a section names its checkpoint, as in "### Per-Class (final checkpoint)".
function section(card, level, title) {
  const lines = card.split('\n');
  const marks = '#'.repeat(level);
  const start = lines.findIndex((line) => line.startsWith(`${marks} ${title}`));
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line));
  return {
    heading: lines[start].slice(marks.length + 1 + title.length).trim(),
    body: lines.slice(start + 1, next === -1 ? undefined : next).join('\n'),
  };
}

// The rows of the first Markdown table in text, keyed by its header cells.
function tableRows(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('|'));
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('|'));
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const [header, , ...rows] = lines.slice(start, end === -1 ? undefined : end).map(cells);
  return rows.map((row) => Object.fromEntries(header.map((name, column) => [name, row[column]])));
}

const percent = (correct, total) => `${((100 * correct) / total).toFixed(2)}%`;

// Each class answers recall x support of its eval samples correctly.
function perClassAccuracy(rows) {
  const total = rows.reduce((sum, row) => sum + Number(row.Support), 0);
  const correct = rows.reduce((sum, row) => sum + Math.round(Number(row.Recall) * Number(row.Support)), 0);
  return percent(correct, total);
}

// The first line of the matrix names the predicted classes; each other line
// starts with a true class and counts its samples by predicted class.
function matrixAccuracy(body, path) {
  const block = body.match(/```\n([\s\S]*?)\n```/);
  assert.ok(block, `${path}: the confusion matrix section has no code block`);
  const rows = block[1].split('\n').slice(1).map((line) => line.trim().split(/\s+/).slice(1).map(Number));
  for (const row of rows) {
    assert.ok(row.length === rows.length && row.every(Number.isInteger), `${path}: the confusion matrix is not a square of counts`);
  }
  const total = rows.flat().reduce((sum, count) => sum + count, 0);
  const correct = rows.reduce((sum, row, index) => sum + row[index], 0);
  return percent(correct, total);
}

function cardVersion(card, path) {
  const title = card.match(/^# Model Card: (\S+) v(\d+\.\d+\.\d+)$/m);
  assert.ok(title, `${path} has no "# Model Card: <model> v<version>" title`);
  return { model: title[1], version: title[2] };
}

// The Accuracy row of Benchmark Results: the accuracy a card leads with.
function headlineAccuracy(card, path) {
  const benchmarks = section(card, 2, 'Benchmark Results');
  assert.ok(benchmarks, `${path} has no Benchmark Results section`);
  const accuracy = tableRows(benchmarks.body).find((row) => row.Benchmark === 'Accuracy')?.Result;
  assert.ok(accuracy, `${path} has no Accuracy row in Benchmark Results`);
  return accuracy;
}

function perClassSection(card, path) {
  const perClass = section(card, 3, 'Per-Class');
  assert.ok(perClass, `${path} has no Per-Class section`);
  return perClass;
}

const checkpointOf = (row) => row.Checkpoint.replace(/\s*\(released\)$/, '');
const isReleased = (row) => /\(released\)$/.test(row.Checkpoint ?? '');

test('the confusion matrix of a classifier model card sums to the accuracy of its per-class table', () => {
  for (const path of classifierModelCards()) {
    const card = read(path);
    const matrix = section(card, 3, 'Confusion Matrix');
    if (!matrix) continue;
    const perClass = perClassSection(card, path);
    assert.equal(matrixAccuracy(matrix.body, path), perClassAccuracy(tableRows(perClass.body)), path);
    assert.equal(matrix.heading, perClass.heading, `${path}: the confusion matrix and the per-class table name different checkpoints`);
  }
});

// A card can report more than one checkpoint of a training run, and its
// headline accuracy is the released checkpoint's. A per-class table that sums
// to another accuracy comes from another checkpoint, so the card names the
// checkpoint of each figure: the Overall table has a Checkpoint column with the
// released row marked "(released)", and the per-class heading names its
// checkpoint.
test('a classifier model card gives its headline accuracy and per-class table for one checkpoint, or names the checkpoint of each', () => {
  for (const path of classifierModelCards()) {
    const card = read(path);
    const headline = headlineAccuracy(card, path);
    const perClass = perClassSection(card, path);
    const accuracy = perClassAccuracy(tableRows(perClass.body));
    if (accuracy === headline) continue;

    const differs = `${path}: the per-class table sums to ${accuracy}, not the headline ${headline},`;
    const overall = section(card, 3, 'Overall');
    assert.ok(overall, `${path} has no Overall section`);
    const rows = tableRows(overall.body);
    assert.ok(rows.length > 0 && rows.every((row) => row.Checkpoint), `${differs} and the Overall table does not name the checkpoint of each figure`);
    const named = perClass.heading.match(/^\((\w+) checkpoint\)$/)?.[1];
    assert.ok(named, `${differs} and its heading names no checkpoint`);

    const accuracyRows = rows.filter((row) => row.Metric === 'Eval accuracy');
    assert.equal(accuracyRows.find((row) => checkpointOf(row) === named)?.Value, accuracy, `${path}: the Overall table does not give the ${named} checkpoint the ${accuracy} its per-class table sums to`);
    const macroF1 = rows.find((row) => row.Metric === 'Macro F1');
    assert.ok(macroF1, `${path}: the Overall table has no Macro F1 row`);
    assert.equal(checkpointOf(macroF1), named, `${path}: the macro F1 is not given for the checkpoint of the per-class table`);
    const released = accuracyRows.filter(isReleased);
    assert.equal(released.length, 1, `${path}: the Overall table marks ${released.length} accuracy rows "(released)"`);
    assert.equal(released[0].Value, headline, `${path}: the headline accuracy is not the released checkpoint's`);
  }
});

test('the headline accuracy of a classifier model card is the evalAccuracy the manifest records for its version', () => {
  for (const path of classifierModelCards()) {
    const card = read(path);
    const { model, version } = cardVersion(card, path);
    const record = manifest.models[model]?.versions?.[version];
    assert.ok(record, `${path}: the manifest has no ${model} ${version}`);
    assert.equal(headlineAccuracy(card, path), `${(100 * record.metrics.evalAccuracy).toFixed(2)}%`, path);
  }
});

// The training playbook lists the weights file the training script writes for
// each checkpoint, so the file a card names for its released checkpoint has to
// be that checkpoint's there and has to be in the manifest's list of files.
test('a classifier model card names the weights file of its released checkpoint, and the manifest lists it', () => {
  const playbook = read('docs/TRAINING-PLAYBOOK.md');
  const describes = (file) => playbook.match(new RegExp(`^- \`${file.replaceAll('.', '\\.')}\`: (.*)$`, 'm'))?.[1] ?? '';
  for (const path of classifierModelCards()) {
    const card = read(path);
    const overall = section(card, 3, 'Overall');
    const released = overall && tableRows(overall.body).find(isReleased);
    if (!released) continue;

    const checkpoint = checkpointOf(released);
    const { model, version } = cardVersion(card, path);
    const files = manifest.models[model].versions[version].files;
    const intro = section(card, 2, 'Evaluation Metrics').body.split('\n### ')[0];
    const named = [...intro.matchAll(/`([\w.-]+\.npz)`/g)].map((match) => match[1]);
    assert.ok(
      named.some((file) => files.includes(file) && describes(file).toLowerCase().startsWith(`${checkpoint} `)),
      `${path} names no weights file that the manifest lists for ${version} and the training playbook names as the ${checkpoint} checkpoint`,
    );
  }
});
