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
