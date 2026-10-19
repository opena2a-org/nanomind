import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'nanomind-models.json'), 'utf8'));

const HF_ORG = 'opena2a';
const HF_API = 'https://huggingface.co/api/models';
// Repositories per page of a listing request; hfList reads every page either way.
const PAGE_SIZE = 100;

// The tests that take this skip option read the Hugging Face API, so the default
// run skips them. With the variable set they never skip: an unreachable API fails
// the run, because a skip would read as "every published repository is in the
// manifest". The tests at the end of this file run the quantization and revision
// checks against a stub of the API in every run.
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

async function hfText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `GET ${url} returned HTTP ${response.status}`);
  return response.text();
}

// The URL a Link header names with rel="next", resolved against the page that sent it.
function nextPage(link, base) {
  for (const [, target, params] of (link ?? '').matchAll(/<([^>]*)>([^,]*)/g)) {
    const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(params)?.[1] ?? '';
    if (rel.split(/\s+/).includes('next')) return new URL(target, base).href;
  }
  return null;
}

// The API answers a listing one page per request and names the next page in a
// Link header with rel="next", so reading only the first answer misses every
// repository past the first page.
async function hfList(url) {
  const items = [];
  const read = new Set();
  for (let page = new URL(url).href; page !== null; ) {
    assert.ok(!read.has(page), `the listing links ${page} a second time`);
    read.add(page);
    const response = await fetch(page, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `GET ${page} returned HTTP ${response.status}`);
    const body = await response.json();
    assert.ok(Array.isArray(body), `GET ${page} did not return a list`);
    items.push(...body);
    page = nextPage(response.headers.get('link'), page);
  }
  return items;
}

// Every place the manifest names a Hugging Face repository: one per model line,
// plus each format of a version that is published in a repository of its own.
// With no argument it reads nanomind-models.json.
function repoEntries(source = manifest) {
  const entries = [];
  for (const [modelName, model] of Object.entries(source.models)) {
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

// The API as the checks below read it. The tests at the end of this file pass a
// stub with the same two methods.
const live = { json: hfJson, text: hfText };

test('manifest names at least one Hugging Face repository', () => {
  assert.ok(repoEntries().length > 0, 'nanomind-models.json names no Hugging Face repository');
});

// The README sends a reader to the models page for the model lines, so that
// page links each repository the manifest names.
test('the models page links every Hugging Face repository the manifest names', () => {
  const page = readFileSync(join(root, 'docs/models.md'), 'utf8');
  const unlinked = [...new Set(repoEntries().map(({ entry }) => entry.repoId))].filter(
    (repoId) => !page.includes(`](https://huggingface.co/${repoId})`),
  );
  assert.deepEqual(unlinked, [], 'docs/models.md links no Hugging Face page for these repositories');
});

// The formats of one version carry the same set of the fields files, sha256,
// bytes and size, so a reader of those formats meets one shape.
test('the formats of one version describe their files with the same fields', () => {
  const FIELDS = ['files', 'sha256', 'bytes', 'size'];
  const fieldsOf = (format) => FIELDS.filter((field) => Object.hasOwn(format, field)).join(', ') || 'none';
  for (const [modelName, model] of Object.entries(manifest.models)) {
    for (const [version, release] of Object.entries(model.versions ?? {})) {
      const formats = Object.entries(release.formats ?? {});
      assert.ok(
        new Set(formats.map(([, format]) => fieldsOf(format))).size <= 1,
        `${modelName}.versions["${version}"].formats: ` +
          formats.map(([name, format]) => `${name} has ${fieldsOf(format)}`).join('; '),
      );
    }
  }
});

// Serves a model listing whose pages link the next one the way the Hugging Face
// API does, on the loopback interface. Returns the URL of the first page.
async function serveListing(t, pages) {
  const server = createServer((request, response) => {
    const { items, next } = pages[Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('page'))];
    const headers = { 'content-type': 'application/json' };
    if (next !== undefined) headers.link = `<http://${request.headers.host}/api/models?page=${next}>; rel="next"`;
    response.writeHead(200, headers).end(JSON.stringify(items));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/api/models?page=0`;
}

test('a listing read follows the next-page link of every page', async (t) => {
  const ids = [`${HF_ORG}/nanomind-first`, `${HF_ORG}/nanomind-second`, `${HF_ORG}/nanomind-third`];
  const url = await serveListing(t, [
    { items: [{ id: ids[0] }], next: 1 },
    { items: [{ id: ids[1] }], next: 2 },
    { items: [{ id: ids[2] }] },
  ]);
  assert.deepEqual((await hfList(url)).map((repo) => repo.id), ids);
});

test('a listing read fails when a page links a page it has already read', async (t) => {
  const url = await serveListing(t, [{ items: [], next: 1 }, { items: [], next: 0 }]);
  await assert.rejects(hfList(url), /a second time/);
});

// The manifest names model repositories only, so this reads the model listing
// and not the Spaces or datasets of the organization.
test('every nanomind model repository in the Hugging Face organization is in the manifest', { skip }, async () => {
  const listing = await hfList(`${HF_API}?author=${HF_ORG}&limit=${PAGE_SIZE}`);

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

// With one repository per page, every repository after the first is reachable
// only through the next-page links, so this fails when the API pages a listing
// without naming the next page in a Link header.
test('the organization listing reads every page the API links', { skip }, async () => {
  const ids = (listing) => listing.map((repo) => repo.id).sort();
  const listing = await hfList(`${HF_API}?author=${HF_ORG}&limit=${PAGE_SIZE}`);
  assert.ok(listing.length > 1, `the ${HF_ORG} listing holds fewer than two repositories, so one per page reads a single page`);
  assert.deepEqual(ids(await hfList(`${HF_API}?author=${HF_ORG}&limit=1`)), ids(listing));
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

// publishedAt on a format in its own repository is the time of the commit its
// hfRevision names. For a revision, the API reports that time as lastModified.
test('a format published in its own repository states the time of its hfRevision commit as publishedAt', { skip }, async () => {
  for (const { where, entry } of repoEntries().filter(({ isFormat }) => isFormat)) {
    assert.ok(entry.hfRevision, `${where} has a repoId and no hfRevision`);
    const commit = await hfJson(`${HF_API}/${entry.repoId}/revision/${entry.hfRevision}`);
    assert.equal(
      entry.publishedAt,
      commit.lastModified,
      `${where}.publishedAt is ${JSON.stringify(entry.publishedAt)}, ` +
        `commit ${entry.hfRevision} of ${entry.repoId} is from ${commit.lastModified}`,
    );
  }
});

// A format stored in the repository of its model line is read at the revision
// of its version, or at its own hfRevision when it names one.
test('a format in its version\'s repository has its files, digests and sizes in that revision', { skip }, async () => {
  for (const [modelName, model] of Object.entries(manifest.models)) {
    const repoId = model.huggingface?.repoId;
    for (const [version, sha] of Object.entries(model.huggingface?.revisions ?? {})) {
      for (const [formatName, format] of Object.entries(model.versions?.[version]?.formats ?? {})) {
        if (format.repoId || !format.files) continue;
        const where = `${modelName}.versions["${version}"].formats["${formatName}"]`;
        const revision = Object.hasOwn(format, 'hfRevision') ? format.hfRevision : sha;
        assert.ok(revision, `${where} lists files and its hfRevision is null`);

        const repo = await hfJson(`${HF_API}/${repoId}/revision/${revision}?blobs=true`);
        const held = new Map(repo.siblings.map((file) => [file.rfilename, file]));
        assert.deepEqual(
          format.files.filter((file) => !held.has(file)),
          [],
          `${where}.files names files that are not in ${repoId} at ${revision}`,
        );
        const large = format.files.filter((file) => held.get(file).lfs);
        assert.deepEqual(
          format.sha256,
          Object.fromEntries(large.map((file) => [file, held.get(file).lfs.sha256])),
          `${where}.sha256 differs from the LFS digests in ${repoId} at ${revision}`,
        );
        assert.deepEqual(
          format.bytes,
          Object.fromEntries(large.map((file) => [file, held.get(file).lfs.size])),
          `${where}.bytes differs from the LFS sizes in ${repoId} at ${revision}`,
        );
      }
    }
  }
});

test('a quantized format states the bits and group size of its repository', { skip }, async () => {
  const checked = await checkQuantization(manifest, live);
  assert.ok(checked > 0, 'no format with a repoId reports quantization bits, so the check would pass on nothing');
});

// Returns the number of formats whose bits and group size it compared.
async function checkQuantization(manifest, hf) {
  let checked = 0;
  for (const { where, entry } of repoEntries(manifest).filter(({ isFormat }) => isFormat)) {
    assert.ok(entry.hfRevision, `${where} has a repoId and no hfRevision`);
    const repo = await hf.json(`${HF_API}/${entry.repoId}/revision/${entry.hfRevision}`);
    const bits = repo.config?.quantization_config?.bits;
    if (bits === undefined) {
      // A format that states its bits fails here instead of passing unchecked.
      const claimed = /\b(\d+)-bit\b/.exec(entry.quantization ?? '')?.[1];
      assert.equal(
        claimed,
        undefined,
        `${where}.quantization states ${claimed} bits, ${entry.repoId} at ${entry.hfRevision} reports no quantization_config.bits`,
      );
      continue;
    }

    const stated = /^(\d+)-bit, group size (\d+)$/.exec(entry.quantization ?? '');
    assert.ok(
      stated,
      `${where}.quantization is ${JSON.stringify(entry.quantization)}; ` +
        `${entry.repoId} is quantized, so it needs "<bits>-bit, group size <n>"`,
    );
    assert.equal(Number(stated[1]), bits, `${where}.quantization states ${stated[1]} bits, ${entry.repoId} reports ${bits}`);

    // The API reports the bits but not the group size, and config.json is behind
    // the access gate. The model card stays readable and names the conversion flags.
    const card = await hf.text(`https://huggingface.co/${entry.repoId}/resolve/${entry.hfRevision}/README.md`);
    const groupSize = /--q-group-size (\d+)/.exec(card)?.[1];
    assert.ok(groupSize, `the ${entry.repoId} model card at ${entry.hfRevision} names no --q-group-size`);
    assert.equal(
      stated[2],
      groupSize,
      `${where}.quantization states group size ${stated[2]}, the ${entry.repoId} model card states ${groupSize}`,
    );
    checked += 1;
  }
  return checked;
}

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

// Files a revision holds that no version lists: .gitattributes is the repository's
// git configuration, not a file of the model.
const REPOSITORY_FILES = new Set(['.gitattributes']);

async function checkVersionRevisions(manifest, hf, note = () => {}) {
  for (const [modelName, model] of Object.entries(manifest.models)) {
    const repoId = model.huggingface?.repoId;
    for (const [version, sha] of Object.entries(model.huggingface?.revisions ?? {})) {
      const where = `${modelName}.versions["${version}"]`;
      const release = model.versions?.[version];
      assert.ok(release, `${modelName}.huggingface.revisions names ${version}, which is not in versions`);

      // A format stored in this repository names its own hfRevision when the version's
      // revision does not hold its file. null states that the commit is not recorded.
      const own = new Map();
      for (const [formatName, format] of Object.entries(release.formats ?? {})) {
        if (format.repoId || !format.filename || !Object.hasOwn(format, 'hfRevision')) continue;
        own.set(format.filename, { field: `${where}.formats["${formatName}"].hfRevision`, revision: format.hfRevision });
      }

      const filesAt = async (revision) => {
        const repo = await hf.json(`${HF_API}/${repoId}/revision/${revision}?blobs=true`);
        return new Map(repo.siblings.map((file) => [file.rfilename, file]));
      };
      const atVersion = await filesAt(sha);
      const listed = new Set([...(release.files ?? []), ...Object.keys(release.sha256 ?? {})]);

      for (const file of listed) {
        const pinned = own.get(file);
        if (pinned?.revision === null) {
          assert.ok(
            !atVersion.has(file),
            `${pinned.field} is null, yet ${file} is in ${repoId} at ${sha}; remove the null`,
          );
          assert.ok(!release.sha256?.[file], `${where}.sha256 states a digest for ${file}, which no recorded revision holds`);
          note(`${where}: ${file} is in no recorded revision of ${repoId}`);
          continue;
        }

        if (pinned) {
          // At a later commit the path can hold the file of another version, so only
          // the recorded digest shows that the file at the pinned revision is this one.
          assert.ok(
            release.sha256?.[file] !== undefined,
            `${pinned.field} names ${pinned.revision} for ${file}, and ${where}.sha256 states no digest ` +
              'to show that the file there belongs to this version',
          );
        }

        const revision = pinned?.revision ?? sha;
        const held = pinned ? await filesAt(revision) : atVersion;
        assert.ok(held.has(file), `${where} names ${file}, which is not in ${repoId} at ${revision}`);

        const digest = release.sha256?.[file];
        if (digest !== undefined) {
          assert.equal(
            digest,
            held.get(file).lfs?.sha256,
            `${where}.sha256["${file}"] differs from the LFS digest in ${repoId} at ${revision}`,
          );
        }
      }

      const unlisted = [...atVersion.keys()].filter((file) => !listed.has(file) && !REPOSITORY_FILES.has(file));
      assert.deepEqual(unlisted, [], `${repoId} at ${sha} holds ${unlisted.join(', ')}, which ${where}.files does not list`);
    }
  }
}

test('a version with a recorded revision has its files and digests in that revision', { skip }, (t) =>
  checkVersionRevisions(manifest, live, (message) => t.diagnostic(message)));

async function checkRecordedRevisions(manifest, hf) {
  const recorded = [];
  for (const { where, entry } of repoEntries(manifest)) {
    for (const [version, sha] of Object.entries(entry.revisions ?? {})) {
      recorded.push({ field: `${where}.revisions["${version}"]`, repoId: entry.repoId, sha });
    }
    if (entry.hfRevision !== undefined) {
      recorded.push({ field: `${where}.hfRevision`, repoId: entry.repoId, sha: entry.hfRevision });
    }
  }
  // A format stored in its model's repository names a commit of that repository in
  // hfRevision, where null states that the commit is not recorded.
  for (const [modelName, model] of Object.entries(manifest.models)) {
    for (const [version, release] of Object.entries(model.versions ?? {})) {
      for (const [formatName, format] of Object.entries(release.formats ?? {})) {
        if (format.repoId || format.hfRevision === undefined || format.hfRevision === null) continue;
        recorded.push({
          field: `${modelName}.versions["${version}"].formats["${formatName}"].hfRevision`,
          repoId: model.huggingface?.repoId,
          sha: format.hfRevision,
        });
      }
    }
  }

  for (const { field, repoId, sha } of recorded) {
    assert.match(String(sha), /^[0-9a-f]{40}$/, `${field} is not a full commit sha`);
    const commit = await hf.json(`${HF_API}/${repoId}/revision/${sha}`);
    assert.equal(commit.sha, sha, `${field} does not resolve in ${repoId}`);
  }
}

test('every recorded revision is a commit of its repository', { skip }, () => checkRecordedRevisions(manifest, live));

// The checks above, run against a stub of the API. The fixture model records two
// versions in one repository, the way the analyst line does: OLD is the revision of
// 0.1.0, which does not hold its model.gguf, NEW is the revision of 1.0.0, which
// holds its own, and MID is a commit between them that holds the 0.1.0 model.gguf.
// Each test changes the fixture manifest in one place.

const REPO = 'opena2a/nanomind-fixture';
const QUANTIZED_REPO = 'opena2a/nanomind-fixture-mlx';
const OLD = '1'.repeat(40);
const MID = '2'.repeat(40);
const NEW = '3'.repeat(40);

// A stub of the API that answers from a table of URL to body. A URL the table does
// not hold fails the check that asked for it.
function stubApi(bodies) {
  const get = async (url) => {
    assert.ok(Object.hasOwn(bodies, url), `the stub holds no answer for GET ${url}`);
    return bodies[url];
  };
  return { json: get, text: get };
}

// The API's answer for a revision: its commit sha and its files, with an LFS digest
// for each file that digests names.
function revisionOf(sha, files, digests = {}) {
  return {
    sha,
    siblings: files.map((rfilename) =>
      (Object.hasOwn(digests, rfilename) ? { rfilename, lfs: { sha256: digests[rfilename] } } : { rfilename })),
  };
}

const fixtureApi = stubApi(Object.fromEntries([
  revisionOf(OLD, ['.gitattributes', 'config.json']),
  revisionOf(MID, ['.gitattributes', 'config.json', 'model.gguf'], { 'model.gguf': 'digest-of-0.1.0-model' }),
  revisionOf(NEW, ['.gitattributes', 'config.json', 'model.gguf'], { 'model.gguf': 'digest-of-1.0.0-model' }),
].flatMap((body) => [
  [`${HF_API}/${REPO}/revision/${body.sha}`, body],
  [`${HF_API}/${REPO}/revision/${body.sha}?blobs=true`, body],
])));

function fixtureManifest() {
  return {
    models: {
      fixture: {
        huggingface: { repoId: REPO, revisions: { '0.1.0': OLD, '1.0.0': NEW } },
        versions: {
          '0.1.0': {
            files: ['config.json', 'model.gguf'],
            formats: { gguf: { filename: 'model.gguf', hfRevision: null } },
          },
          '1.0.0': {
            files: ['config.json', 'model.gguf'],
            sha256: { 'model.gguf': 'digest-of-1.0.0-model' },
          },
        },
      },
    },
  };
}

// A model whose 1.0.0 has one format in a repository of its own, stated as 8-bit.
function quantizedManifest() {
  return {
    models: {
      fixture: {
        versions: {
          '1.0.0': {
            formats: { quantized: { repoId: QUANTIZED_REPO, hfRevision: NEW, quantization: '8-bit, group size 64' } },
          },
        },
      },
    },
  };
}

test('the fixture manifest passes the revision checks', async () => {
  await checkVersionRevisions(fixtureManifest(), fixtureApi);
  await checkRecordedRevisions(fixtureManifest(), fixtureApi);
});

test('a file pinned to a revision of its own passes when the version records its digest', async () => {
  const fixture = fixtureManifest();
  const release = fixture.models.fixture.versions['0.1.0'];
  release.formats.gguf.hfRevision = MID;
  release.sha256 = { 'model.gguf': 'digest-of-0.1.0-model' };
  await checkVersionRevisions(fixture, fixtureApi);
  await checkRecordedRevisions(fixture, fixtureApi);
});

test('a file pinned to the revision of a later version fails when the version records no digest', async () => {
  const fixture = fixtureManifest();
  fixture.models.fixture.versions['0.1.0'].formats.gguf.hfRevision = NEW;
  await assert.rejects(checkVersionRevisions(fixture, fixtureApi), /states no digest/);
});

test('the hfRevision of a format in its model repository must be a full commit sha', async () => {
  const fixture = fixtureManifest();
  fixture.models.fixture.versions['0.1.0'].formats.gguf.hfRevision = 'main';
  await assert.rejects(
    checkRecordedRevisions(fixture, fixtureApi),
    /fixture\.versions\["0\.1\.0"\]\.formats\["gguf"\]\.hfRevision is not a full commit sha/,
  );
});

test('a file in a recorded revision that the version does not list fails', async () => {
  const fixture = fixtureManifest();
  fixture.models.fixture.versions['1.0.0'].files = ['model.gguf'];
  await assert.rejects(checkVersionRevisions(fixture, fixtureApi), /holds config\.json, which .* does not list/);
});

test('a quantized format is counted as checked when its repository reports the stated bits and group size', async () => {
  const api = stubApi({
    [`${HF_API}/${QUANTIZED_REPO}/revision/${NEW}`]: { sha: NEW, config: { quantization_config: { bits: 8 } } },
    [`https://huggingface.co/${QUANTIZED_REPO}/resolve/${NEW}/README.md`]: '--q-bits 8 --q-group-size 64',
  });
  assert.equal(await checkQuantization(quantizedManifest(), api), 1);
});

test('a format that states its bits fails when its repository reports none', async () => {
  const api = stubApi({ [`${HF_API}/${QUANTIZED_REPO}/revision/${NEW}`]: { sha: NEW, config: {} } });
  await assert.rejects(
    checkQuantization(quantizedManifest(), api),
    /states 8 bits, .* reports no quantization_config\.bits/,
  );
});

test('a format that states no bits is not counted as checked when its repository reports none', async () => {
  const fixture = quantizedManifest();
  fixture.models.fixture.versions['1.0.0'].formats.quantized.quantization = 'Q4_K_M';
  const api = stubApi({ [`${HF_API}/${QUANTIZED_REPO}/revision/${NEW}`]: { sha: NEW, config: {} } });
  assert.equal(await checkQuantization(fixture, api), 0);
});
