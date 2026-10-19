import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

// The README and the pages that hold the text moved out of it.
const PAGES = ['README.md', 'CONTRIBUTING.md', 'docs/integrations.md', 'docs/cli-mode.md', 'docs/models.md', 'docs/how-it-works.md'];

// "In this repository" means tracked by git, as in training-playbook-paths.test.mjs.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const trim = (path) => path.replace(/\.+$/, '').replace(/\/+$/, '');
const inRepository = (path) =>
  trim(path) === '' || tracked.some((file) => file === trim(path) || file.startsWith(`${trim(path)}/`));

const LINK_TARGET = /\]\(([^)\s]+)\)/g;
const isExternal = (target) => /^(https?|mailto):/.test(target) || target.startsWith('#');

// A tracked top-level directory followed by a slash, with no path character
// before it, so nanomind/packages/x and a link to ../packages/x from docs/ are
// not read as paths from the repository root.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOP_DIRS = [...new Set(tracked.filter((file) => file.includes('/')).map((file) => file.split('/')[0]))];
const ROOT_PATH = new RegExp(`(?<![\\w./~-])(?:${TOP_DIRS.map(escape).join('|')})/[\\w.@/-]*`, 'g');

function namedPaths(text) {
  return [...new Set(text.replace(LINK_TARGET, ']()').match(ROOT_PATH) ?? [])];
}

function linkedPaths(page, text) {
  return [...text.matchAll(LINK_TARGET)]
    .map((match) => match[1])
    .filter((target) => !isExternal(target))
    .map((target) => normalize(join(dirname(page), target.split('#')[0])));
}

// A pull request or issue cited by a number after #, or a commit cited by its
// hash, in the text of a page rather than in a link target. Written as text, a
// citation names no repository, and a hash resolves only in a clone that holds
// the commit. A hash here is 7 to 40 lowercase hex characters with at least
// one digit and one letter, standing alone, so a SHA-256 digest (64
// characters), a date, a UUID and a word such as "defaced" are not read as one.
const PULL_REQUEST_NUMBER = /(?<![\w&#/])#\d+\b/g;
const COMMIT_HASH = /(?<![\w./-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w/-])/g;

function citations(text) {
  const prose = text.replace(LINK_TARGET, ']()');
  return [...new Set([...(prose.match(PULL_REQUEST_NUMBER) ?? []), ...(prose.match(COMMIT_HASH) ?? [])])];
}

// Every command line in a fenced block, with its continuation lines joined.
function fencedCommands(text) {
  const blocks = text.match(/^```[^\n]*\n[\s\S]*?^```/gm) ?? [];
  return blocks
    .flatMap((block) => block.replace(/\\\n\s*/g, ' ').split('\n').slice(1, -1))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// Each workspace as its directory and its manifest.
function workspacePackages() {
  return readJson('package.json').workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    return [...new Set(tracked.filter((file) => file.startsWith(`${parent}/`)).map((file) => file.split('/')[1]))]
      .map((name) => `${parent}/${name}`)
      .filter((dir) => existsSync(join(root, dir, 'package.json')))
      .map((dir) => ({ dir, manifest: readJson(`${dir}/package.json`) }));
  });
}

const workspaces = () => workspacePackages().map(({ manifest }) => manifest);

// A package an import or an npm install line names, split into the package
// name and the subpath after it.
const IMPORT = /\bfrom\s+['"](@nanomind\/[^'"]+)['"]/g;
const INSTALL = /\bnpm\s+(?:i|install)\s+(@nanomind\/[^\s`'"@]+)/g;

function packageSpecifiers(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].map((specifier) => {
    const [scope, name, ...subpath] = specifier.split('/');
    return { specifier, name: `${scope}/${name}`, subpath: subpath.join('/') };
  });
}

// Node refuses to strip types from a file under node_modules, so an entry
// point a reader imports from an installed package has to be JavaScript.
const TYPESCRIPT = /\.[cm]?ts$/;

// The tracked file a published subpath is built from: a .js file under the
// package's tsconfig outDir comes from the .ts file at the same place under
// rootDir. Any other subpath is published as it is tracked.
function sourceOf(dir, subpath) {
  const tsconfig = `${dir}/tsconfig.json`;
  const { outDir, rootDir } = existsSync(join(root, tsconfig)) ? (readJson(tsconfig).compilerOptions ?? {}) : {};
  const out = outDir && normalize(outDir).replace(/\/+$/, '');
  if (out && rootDir && subpath.startsWith(`${out}/`) && subpath.endsWith('.js')) {
    return `${dir}/${normalize(rootDir).replace(/\/+$/, '')}/${subpath.slice(out.length + 1, -'.js'.length)}.ts`;
  }
  return `${dir}/${subpath}`;
}

test('the pages name repository paths', () => {
  assert.ok(PAGES.flatMap((page) => namedPaths(read(page))).length > 0);
});

for (const page of PAGES) {
  test(`every repository path ${page} names is in this repository`, () => {
    assert.deepEqual(namedPaths(read(page)).filter((path) => !inRepository(path)), []);
  });

  test(`every relative link in ${page} resolves to a path in this repository`, () => {
    assert.deepEqual(linkedPaths(page, read(page)).filter((path) => !inRepository(path)), []);
  });

  test(`${page} cites no pull request or commit as a bare number or hash`, () => {
    assert.deepEqual(citations(read(page)), []);
  });

  test(`every @nanomind package ${page} imports or installs is a workspace of this repository`, () => {
    const names = new Set(workspaces().map((manifest) => manifest.name));
    const specifiers = [IMPORT, INSTALL].flatMap((pattern) => packageSpecifiers(read(page), pattern));
    const outside = specifiers.filter(({ name }) => !names.has(name)).map(({ specifier }) => specifier);
    assert.deepEqual([...new Set(outside)], []);
  });

  test(`every @nanomind import in ${page} names a JavaScript file the package publishes`, () => {
    const packages = new Map(workspacePackages().map((pkg) => [pkg.manifest.name, pkg]));
    const problems = [];
    for (const { specifier, name, subpath } of packageSpecifiers(read(page), IMPORT)) {
      if (!packages.has(name)) continue;
      const { dir, manifest } = packages.get(name);
      if (!subpath) {
        if (TYPESCRIPT.test(manifest.main ?? '')) problems.push(`${specifier}: main is TypeScript source ${manifest.main}`);
        continue;
      }
      if (manifest.exports) {
        if (!(`./${subpath}` in manifest.exports)) problems.push(`${specifier}: exports has no ./${subpath}`);
        continue;
      }
      if (TYPESCRIPT.test(subpath)) problems.push(`${specifier}: TypeScript source`);
      if (!(manifest.files ?? []).some((entry) => subpath === trim(entry) || subpath.startsWith(`${trim(entry)}/`))) {
        problems.push(`${specifier}: not in the package's files`);
      }
      if (!tracked.includes(sourceOf(dir, subpath))) problems.push(`${specifier}: ${sourceOf(dir, subpath)} is not tracked`);
    }
    assert.deepEqual(problems, []);
  });
}

// The input-classifier gate and the NanoMind-Guard daemon the models page
// describes are code in packages/nanomind-analyst.
test('docs/models.md links the input-classifier gate and the NanoMind-Guard daemon to their code', () => {
  const linked = linkedPaths('docs/models.md', read('docs/models.md')).map(trim);
  const code = [
    'packages/nanomind-analyst/src/nanomind_analyst/daemon/input_classifier',
    'packages/nanomind-analyst/src/nanomind_analyst/daemon/nanomind_guard_daemon.py',
  ];
  assert.deepEqual(code.filter((path) => !linked.includes(path) || !inRepository(path)), []);
});

// The specification's **File:** and **Files:** lines name a source file of
// this repository by the repository's name (nanomind/packages/...) and then
// bare file names (a name with an extension) in the same directory.
test('every source file a Files line of the specification names in this repository is in this repository', () => {
  const named = [];
  for (const line of read('docs/SPECIFICATION.md').split('\n').filter((text) => /^\*\*Files?:\*\*/.test(text))) {
    let dir = null;
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
      if (span.startsWith('nanomind/')) {
        named.push(span.slice('nanomind/'.length));
        dir = dirname(span.slice('nanomind/'.length));
      } else if (dir && /^[\w-][\w.-]*\.\w+$/.test(span)) {
        named.push(`${dir}/${span}`);
      }
    }
  }
  assert.ok(named.length > 0, 'the specification names no source file of this repository');
  assert.deepEqual(named.filter((path) => !tracked.includes(path)), []);
});

// The specification names each deployment mode's package by its npm name.
test('every @nanomind package the specification names is a workspace of this repository', () => {
  const names = new Set(workspaces().map((manifest) => manifest.name));
  const named = [...new Set(read('docs/SPECIFICATION.md').match(/@nanomind\/[\w-]+/g) ?? [])];
  assert.ok(named.length > 0, 'the specification names no @nanomind package');
  assert.deepEqual(named.filter((name) => !names.has(name)), []);
});

test('the test commands CONTRIBUTING.md gives run scripts and tools this repository declares', () => {
  const commands = fencedCommands(read('CONTRIBUTING.md'));
  const manifests = [readJson('package.json'), ...workspaces()];
  const rootScripts = Object.keys(readJson('package.json').scripts ?? {});
  const declared = new Set(manifests.flatMap((m) => Object.keys({ ...m.dependencies, ...m.devDependencies })));
  const testable = new Set(workspaces().filter((m) => m.scripts?.test).map((m) => m.name));

  const problems = [];
  for (const command of commands) {
    const [tool, verb, ...rest] = command.split(/\s+/);
    if (tool === 'npx' && !declared.has(verb)) problems.push(`${command}: ${verb} is not a declared dependency`);
    if (tool !== 'npm') continue;
    const script = verb === 'run' ? rest[0] : verb;
    const workspace = rest.find((arg) => arg.startsWith('--workspace='))?.slice('--workspace='.length);
    if (workspace) {
      if (!testable.has(workspace)) problems.push(`${command}: ${workspace} is not a workspace with a test script`);
    } else if (!rootScripts.includes(script)) {
      problems.push(`${command}: package.json has no ${script} script`);
    }
  }
  assert.ok(commands.some((command) => command.startsWith('npm ')), 'CONTRIBUTING.md gives no npm command');
  assert.deepEqual(problems, []);
});
