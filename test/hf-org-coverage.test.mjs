import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'nanomind-models.json'), 'utf8'));

const HF_ORG = 'opena2a';
const HF_API = 'https://huggingface.co/api/models';

// These tests read the Hugging Face API, so the default run skips them. With the
// variable set they never skip: an unreachable API fails the run, because a skip
// would read as "every published repository is in the manifest".
const skip = process.env.NANOMIND_VERIFY_HF_ORG === '1'
  ? false
  : 'reads the Hugging Face API; set NANOMIND_VERIFY_HF_ORG=1 to run';

const responses = new Map();

function hfJson(url) {
  if (!responses.has(url)) {
    responses.set(url, (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200, `GET ${url} returned HTTP ${response.status}`);
      return response.json();
    })());
  }
  return responses.get(url);
}

// Every place the manifest names a Hugging Face repository: one per model line,
// plus each format of a version that is published in a repository of its own.
function repoEntries() {
  const entries = [];
  for (const [modelName, model] of Object.entries(manifest.models)) {
    if (model.huggingface?.repoId) {
      entries.push({ where: `${modelName}.huggingface`, entry: model.huggingface, isFormat: false });
    }
    for (const [version, release] of Object.entries(model.versions ?? {})) {
      for (const [formatName, format] of Object.entries(release.formats ?? {})) {
        if (format.repoId) {
          entries.push({
            where: `${modelName}.versions["${version}"].formats["${formatName}"]`,
            entry: format,
            isFormat: true,
          });
        }
      }
    }
  }
  return entries;
}

test('manifest names at least one Hugging Face repository', () => {
  assert.ok(repoEntries().length > 0, 'nanomind-models.json names no Hugging Face repository');
});

test('every nanomind repository in the Hugging Face organization is in the manifest', { skip }, async () => {
  const listing = await hfJson(`${HF_API}?author=${HF_ORG}`);
  assert.ok(Array.isArray(listing), 'the organization listing is not a list');

  const published = listing.map((repo) => repo.id).filter((id) => id.toLowerCase().includes('nanomind'));
  assert.ok(published.length > 0, `the ${HF_ORG} listing holds no nanomind repository, so the check would pass on nothing`);

  const named = new Set(repoEntries().map(({ entry }) => entry.repoId));
  const absent = published.filter((id) => !named.has(id));
  assert.deepEqual(
    absent,
    [],
    `published under ${HF_ORG} and absent from nanomind-models.json: ${absent.join(', ')}; ` +
      'add each as a huggingface.repoId or as a formats entry with a repoId',
  );
});

test('a format published in its own repository matches the files in that repository', { skip }, async () => {
  for (const { where, entry } of repoEntries().filter(({ isFormat }) => isFormat)) {
    const repo = await hfJson(`${HF_API}/${entry.repoId}?blobs=true`);
    const large = repo.siblings.filter((file) => file.lfs);

    assert.deepEqual(
      [...(entry.files ?? [])].sort(),
      repo.siblings.map((file) => file.rfilename).sort(),
      `${where}.files differs from the files in ${entry.repoId}`,
    );
    assert.deepEqual(
      entry.sha256,
      Object.fromEntries(large.map((file) => [file.rfilename, file.lfs.sha256])),
      `${where}.sha256 differs from the LFS digests in ${entry.repoId}`,
    );
    assert.deepEqual(
      entry.bytes,
      Object.fromEntries(large.map((file) => [file.rfilename, file.lfs.size])),
      `${where}.bytes differs from the LFS sizes in ${entry.repoId}`,
    );
  }
});

test('every repository entry states the access gate the repository has', { skip }, async () => {
  for (const { where, entry } of repoEntries()) {
    const repo = await hfJson(`${HF_API}/${entry.repoId}?blobs=true`);
    // The API reports false for an open repository and a string for a gated one.
    // An entry with no gated field reads as open, so a gated repository needs the string.
    assert.equal(
      entry.gated ?? false,
      repo.gated,
      `${where}.gated is ${JSON.stringify(entry.gated)}, ${entry.repoId} reports ${JSON.stringify(repo.gated)}`,
    );
  }
});

test('every recorded revision is a commit of its repository', { skip }, async () => {
  for (const { where, entry } of repoEntries()) {
    const recorded = Object.entries(entry.revisions ?? {}).map(([version, sha]) => [`revisions["${version}"]`, sha]);
    if (entry.hfRevision !== undefined) recorded.push(['hfRevision', entry.hfRevision]);

    for (const [field, sha] of recorded) {
      assert.match(String(sha), /^[0-9a-f]{40}$/, `${where}.${field} is not a full commit sha`);
      const commit = await hfJson(`${HF_API}/${entry.repoId}/revision/${sha}`);
      assert.equal(commit.sha, sha, `${where}.${field} does not resolve in ${entry.repoId}`);
    }
  }
});
