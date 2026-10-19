import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// Repositories that answer 404 to a reader without a GitHub session.
const PRIVATE_REPOSITORIES = ['opena2a-org/opena2a-registry'];

test('docs/integrations.md names only adapter directories this repository has', () => {
  const named = [...read('docs/integrations.md').matchAll(/`(integrations\/[\w.-]+)\/`/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'docs/integrations.md names adapter directories');
  for (const dir of named) {
    assert.ok(tracked.some((file) => file.startsWith(`${dir}/`)), `${dir}/ is named in docs/integrations.md but holds no tracked file`);
  }
});

test('no Markdown file links a private repository', () => {
  for (const file of tracked.filter((path) => /\.mdx?$/i.test(path))) {
    for (const repository of PRIVATE_REPOSITORIES) {
      assert.ok(
        !read(file).includes(`](https://github.com/${repository}`),
        `${file} links https://github.com/${repository}, which signed-out readers cannot open`,
      );
    }
  }
});

test('docs/models.md describes model publishing as the manifest workflow does', () => {
  assert.match(read('.github/workflows/publish-models.yml'), /it does not publish/, 'the workflow header says it does not publish');
  const models = read('docs/models.md');
  assert.doesNotMatch(models, /publishing automated|automated publish/i);
  assert.match(models, /uploaded to Hugging Face by hand/);
});

// What the workflows in this repository run is what the docs may say CI does
// with a model version.
const workflowText = tracked
  .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
  .map(read)
  .join('\n');

// The pages that describe how a model version is released.
const RELEASE_DOCS = [
  'README.md',
  'docs/models.md',
  'docs/SPECIFICATION.md',
  'docs/EVALUATION-STANDARD.md',
  'docs/TRAINING-PLAYBOOK.md',
];

test('the release docs say models are uploaded to Hugging Face by hand, as no workflow publishes one', () => {
  assert.match(read('.github/workflows/publish-models.yml'), /it does not publish/, 'the workflow header says it does not publish');
  for (const doc of RELEASE_DOCS) {
    assert.doesNotMatch(read(doc), /auto-?publish|publishing automated|publishes to hugging ?face/i, `${doc} says CI publishes models`);
  }
  for (const doc of ['docs/SPECIFICATION.md', 'docs/EVALUATION-STANDARD.md']) {
    assert.match(read(doc), /uploaded to Hugging Face by hand/, `${doc} does not say how models reach Hugging Face`);
  }
});

test('the release docs say no workflow runs a benchmark, as none does', () => {
  assert.doesNotMatch(workflowText, /benchmark/i, 'a workflow names a benchmark: describe it in the release docs and update this test');
  for (const doc of RELEASE_DOCS) {
    assert.doesNotMatch(
      read(doc),
      /benchmarks? (?:are )?run automatically|runs (?:the )?accuracy benchmark|isn.t benchmarked/i,
      `${doc} says benchmarks run automatically`,
    );
  }
  for (const doc of ['docs/SPECIFICATION.md', 'docs/EVALUATION-STANDARD.md']) {
    assert.match(read(doc), /no workflow in this repository runs a benchmark/i, `${doc} does not say that no workflow runs a benchmark`);
  }
});

test('no Markdown file names repository_dispatch while no workflow sends one', () => {
  assert.doesNotMatch(workflowText, /repository_dispatch|\/dispatches\b/, 'a workflow sends repository_dispatch: describe it in the docs and update this test');
  for (const file of tracked.filter((path) => /\.mdx?$/i.test(path))) {
    assert.ok(!read(file).includes('repository_dispatch'), `${file} names repository_dispatch, which no workflow in this repository sends`);
  }
});
