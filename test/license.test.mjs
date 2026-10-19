import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootManifest = readJson(join(root, 'package.json'));

// SPDX identifier and Python package classifier for each license text the
// repository could carry, keyed by a line that only that text contains.
const LICENSE_TEXTS = [
  {
    spdx: 'Apache-2.0',
    classifier: 'License :: OSI Approved :: Apache Software License',
    marker: /^\s*Apache License\s*$\n^\s*Version 2\.0, January 2004\s*$/m,
  },
  { spdx: 'MIT', classifier: 'License :: OSI Approved :: MIT License', marker: /^MIT License\s*$/m },
];

function licenseOf(path) {
  const text = readFileSync(path, 'utf8');
  const found = LICENSE_TEXTS.filter(({ marker }) => marker.test(text));
  assert.equal(found.length, 1, `${relative(root, path)} is not a license text this test recognises`);
  return found[0].spdx;
}

// The SPDX identifiers of the license texts above that a statement names.
function licensesNamed(statement) {
  return LICENSE_TEXTS.filter(({ spdx }) => new RegExp(`\\b${spdx.replace('.', '\\.')}\\b`).test(statement)).map(
    ({ spdx }) => spdx,
  );
}

const rootLicenseText = readFileSync(join(root, 'LICENSE'), 'utf8');
const rootLicense = licenseOf(join(root, 'LICENSE'));

// The directories the workspace patterns match that hold the given manifest.
function packageDirs(manifest) {
  return rootManifest.workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .filter((dir) => existsSync(join(dir, manifest)));
  });
}

// A package directory without its own LICENSE file is covered by the root one.
function expectedLicense(dir) {
  const own = join(dir, 'LICENSE');
  return existsSync(own) ? licenseOf(own) : licenseOf(join(root, 'LICENSE'));
}

// The first line of the README's License section, or null without one.
function readmeLicenseStatement(dir) {
  const readme = join(dir, 'README.md');
  const section = existsSync(readme)
    ? /^## License\s*\n+([^\n]+)/m.exec(readFileSync(readme, 'utf8'))
    : null;
  return section ? section[1] : null;
}

// The text under a README's "## License" heading up to the next heading, or
// null when the README has no such heading.
function licenseSection(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => /^## License\s*$/.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n').trim();
}

const packages = [root, ...packageDirs('package.json')].map((dir) => ({
  dir,
  name: relative(root, dir) || '.',
  expected: expectedLicense(dir),
}));

test('finds the root package and the workspace packages', () => {
  assert.ok(packages.length > 1);
});

for (const { dir, name, expected } of packages) {
  test(`${name}/package.json declares the license its LICENSE file grants`, () => {
    assert.equal(readJson(join(dir, 'package.json')).license, expected);
  });

  const statement = readmeLicenseStatement(dir);
  if (statement) {
    test(`${name}/README.md names the license its LICENSE file grants`, () => {
      assert.deepEqual(licensesNamed(statement), [expected], `License section reads: ${statement}`);
    });
  }

  // The test above reads the first line of a License section and is not run
  // for a README without one. Every package README needs the section, and a
  // later line of it that names another license fails as well.
  test(`${name}/README.md has a License section that names the license its LICENSE file grants`, () => {
    const section = licenseSection(readFileSync(join(dir, 'README.md'), 'utf8'));
    assert.notEqual(section, null, `${name}/README.md has no "## License" section`);
    assert.notEqual(section, '', `${name}/README.md has nothing under its "## License" heading`);
    assert.deepEqual(licensesNamed(section), [expected], `License section reads: ${section}`);
  });
}

// npm adds a LICENSE file in the package directory to the tarball although
// `files` does not list it, and does not add the repository root's LICENSE.
for (const { dir, name } of packages.filter(({ dir }) => !readJson(join(dir, 'package.json')).private)) {
  test(`${name}/LICENSE is the root LICENSE text, so the npm tarball carries it`, () => {
    const own = join(dir, 'LICENSE');
    assert.ok(existsSync(own), `${name} has no LICENSE file, so its npm tarball carries no license text`);
    assert.equal(readFileSync(own, 'utf8'), rootLicenseText, `${name}/LICENSE differs from the root LICENSE`);
  });
}

for (const dir of packageDirs('pyproject.toml')) {
  const name = relative(root, dir);
  const pyproject = readFileSync(join(dir, 'pyproject.toml'), 'utf8');

  test(`${name}/LICENSE is the root LICENSE text`, () => {
    const own = join(dir, 'LICENSE');
    assert.ok(existsSync(own), `${name} has no LICENSE file`);
    assert.equal(readFileSync(own, 'utf8'), rootLicenseText, `${name}/LICENSE differs from the root LICENSE`);
  });

  test(`${name}/pyproject.toml declares the license in the root LICENSE`, () => {
    const field = /^license\s*=\s*(.+)$/m.exec(pyproject);
    assert.ok(field, `${name}/pyproject.toml has no license field`);
    assert.deepEqual(licensesNamed(field[1]), [rootLicense], `license field reads: ${field[1]}`);
  });

  test(`${name}/pyproject.toml lists the classifier of the license in the root LICENSE`, () => {
    const { classifier } = LICENSE_TEXTS.find(({ spdx }) => spdx === rootLicense);
    assert.deepEqual(pyproject.match(/(?<=")License :: [^"]+(?=")/g) ?? [], [classifier]);
  });

  const statement = readmeLicenseStatement(dir);
  if (statement) {
    test(`${name}/README.md names the license in the root LICENSE`, () => {
      assert.deepEqual(licensesNamed(statement), [rootLicense], `License section reads: ${statement}`);
    });
  }
}

// spec/NANOMIND-SPEC.md states its license in a **License:** line and
// docs/SPECIFICATION.md in its Open Protocol section.
for (const path of ['spec/NANOMIND-SPEC.md', 'docs/SPECIFICATION.md']) {
  test(`${path} names the license in the root LICENSE and no other`, () => {
    assert.deepEqual(licensesNamed(readFileSync(join(root, path), 'utf8')), [rootLicense]);
  });
}

// The top-level Markdown files and the rest of docs/ and spec/ are covered by
// the root LICENSE as well.
test('top-level Markdown files, docs/ and spec/ name no license other than the one the root LICENSE file grants', () => {
  const docs = [
    ...readdirSync(root).filter((file) => file.endsWith('.md')),
    ...['docs', 'spec'].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true })
        .filter((file) => file.endsWith('.md'))
        .map((file) => join(dir, file))),
  ];
  assert.ok(
    docs.includes('README.md') && docs.includes(join('spec', 'NANOMIND-SPEC.md')),
    'README.md or spec/NANOMIND-SPEC.md is not among the files checked',
  );
  const others = docs.flatMap((file) =>
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        licensesNamed(line)
          .filter((spdx) => spdx !== rootLicense)
          .map((spdx) => `${file}:${index + 1} names ${spdx}: ${line.trim()}`)));
  assert.deepEqual(others, []);
});

test('package-lock.json records the license each workspace package declares', () => {
  const lock = readJson(join(root, 'package-lock.json'));
  for (const { dir, name } of packages) {
    const key = relative(root, dir);
    const entry = lock.packages?.[key];
    assert.ok(entry, `package-lock.json has no entry for ${name}`);
    assert.equal(entry.license, readJson(join(dir, 'package.json')).license, `package-lock.json entry for ${name}`);
  }
});
