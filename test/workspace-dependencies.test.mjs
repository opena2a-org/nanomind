import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readManifest = (path) => JSON.parse(readFileSync(path, 'utf8'));

function workspaces() {
  return readManifest(join(root, 'package.json')).workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((dir) => existsSync(join(dir, 'package.json')))
      .map((dir) => ({ dir, manifest: readManifest(join(dir, 'package.json')) }));
  });
}

const all = workspaces();
const byName = new Map(all.map((workspace) => [workspace.manifest.name, workspace]));

// Each runtime dependency of a workspace on another workspace in this
// repository. A peer dependency counts: the adapters load @nanomind/cli at
// runtime and declare it as one.
const links = all.flatMap((from) =>
  Object.entries({ ...from.manifest.dependencies, ...from.manifest.peerDependencies })
    .filter(([name]) => byName.has(name))
    .map(([name, range]) => ({ from, to: byName.get(name), range })),
);

describe('workspace dependencies', () => {
  it('finds the dependency of @nanomind/cli on @nanomind/router', () => {
    assert.ok(
      links.some(({ from, to }) => from.manifest.name === '@nanomind/cli' && to.manifest.name === '@nanomind/router'),
    );
  });

  it('finds the peer dependency of @nanomind/hma-adapter on @nanomind/cli', () => {
    assert.ok(
      links.some(({ from, to }) => from.manifest.name === '@nanomind/hma-adapter' && to.manifest.name === '@nanomind/cli'),
    );
  });

  // npm installs a registry release under the dependent's node_modules when the
  // range in its package.json does not admit the workspace version, and that
  // release is what the dependent then loads.
  for (const { from, to, range } of links) {
    const name = to.manifest.name;
    const fromDir = relative(root, from.dir);
    const toDir = relative(root, to.dir);

    it(`${fromDir} resolves ${name} to ${toDir}`, () => {
      let resolved;
      try {
        resolved = createRequire(join(from.dir, 'package.json')).resolve(`${name}/package.json`);
      } catch (error) {
        assert.fail(`${fromDir} cannot resolve ${name} (${error.code}); run npm ci first`);
      }
      assert.equal(
        dirname(realpathSync(resolved)),
        realpathSync(to.dir),
        `${fromDir} resolves ${name} ${readManifest(resolved).version} from ${relative(root, resolved)}, ` +
          `not ${to.manifest.version} from ${toDir}; its package.json asks for "${range}"`,
      );
    });
  }
});
