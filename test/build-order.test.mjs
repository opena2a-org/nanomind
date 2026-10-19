import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const rootManifest = readJson('package.json');
const lock = readJson('package-lock.json');

// Each workspace as its directory, relative to the root, and its manifest.
function workspaces() {
  return rootManifest.workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .filter((dir) => existsSync(join(root, dir, 'package.json')))
      .map((dir) => ({ dir, manifest: readJson(`${dir}/package.json`) }));
  });
}

const all = workspaces();
const byName = new Map(all.map((workspace) => [workspace.manifest.name, workspace]));

// The lockfile entry a dependent resolves a dependency to: the nearest
// node_modules directory on the way up from the dependent that installs it.
function installed(dir, name) {
  for (let parent = dir; ; parent = parent.slice(0, parent.lastIndexOf('/'))) {
    const entry = lock.packages[`${parent}/node_modules/${name}`];
    if (entry) return entry;
    if (!parent.includes('/')) return lock.packages[`node_modules/${name}`];
  }
}

// The workspaces a workspace's build compiles against: dependencies that name
// another workspace and that npm links to it, because no copy from the
// registry is installed under the dependent. A linked workspace is usable only
// once it is built, as its main and types point into dist/.
function linkedWorkspaceDependencies({ dir, manifest }) {
  const specs = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  return Object.keys(specs).filter((name) => {
    const target = byName.get(name);
    if (!target) return false;
    const entry = installed(dir, name);
    assert.ok(entry, `package-lock.json installs no ${name} for ${dir}`);
    return entry.link === true && entry.resolved === target.dir;
  });
}

// The stages of the root build script, `npm run build` commands joined by &&,
// each as the names of the workspaces it builds: those its --workspace= flags
// name, or every workspace for --workspaces.
function buildStages() {
  return rootManifest.scripts.build.split('&&').map((command) => {
    const words = command.trim().split(/\s+/);
    assert.deepEqual(words.slice(0, 3), ['npm', 'run', 'build'], `unexpected build stage: ${command}`);
    const flags = words.slice(3);
    if (flags.includes('--workspaces')) {
      assert.deepEqual(flags, ['--workspaces', '--if-present'], `unexpected build stage: ${command}`);
      return all.map(({ manifest }) => manifest.name);
    }
    return flags.map((flag) => {
      const named = /^--workspace=(.+)$/.exec(flag)?.[1];
      assert.ok(named, `unexpected flag ${flag} in build stage: ${command}`);
      const workspace = byName.get(named) ?? all.find(({ dir }) => dir === named);
      assert.ok(workspace, `${named} in the build script is not a workspace`);
      return workspace.manifest.name;
    });
  });
}

const stages = buildStages();
const stageOf = (name) => stages.findIndex((names) => names.includes(name));

const built = all.filter(({ manifest }) => typeof manifest.scripts?.build === 'string');
const compiledAgainst = built.flatMap((workspace) =>
  linkedWorkspaceDependencies(workspace).map((dependency) => ({ workspace, dependency })));

test('the root build script ends with a stage that builds every workspace', () => {
  assert.deepEqual(stages.at(-1), all.map(({ manifest }) => manifest.name));
});

test('finds a workspace that compiles against another', () => {
  assert.ok(compiledAgainst.length > 0);
});

// A fresh checkout has no dist/ anywhere, and npm run build on it is what CI
// runs. The last stage builds the workspaces in directory order, so a linked
// dependency that is only built there comes before its dependent only by the
// luck of their names; naming it in an earlier stage does not depend on that.
for (const { workspace, dependency } of compiledAgainst) {
  test(`the root build script builds ${dependency} in a stage before ${workspace.manifest.name}, which compiles against it`, () => {
    const before = stageOf(dependency);
    const after = stageOf(workspace.manifest.name);
    assert.ok(
      before < after,
      `${workspace.manifest.name} is built in stage ${after + 1} and ${dependency} in stage ${before + 1} of the build script;`
        + ` name ${dependency} in an earlier --workspace= stage`,
    );
  });
}
