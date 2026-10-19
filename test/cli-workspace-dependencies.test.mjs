import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const lock = readJson('package-lock.json');

// Each workspace's directory, relative to the root, by package name.
const workspaceDirs = new Map(
  readJson('package.json').workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json')))
      .map((entry) => [readJson(`${parent}/${entry.name}/package.json`).name, `${parent}/${entry.name}`]);
  }),
);

// The package whose dist/index.js is the nanomind command.
const CLI_DIR = 'packages/nanomind-cli';
const cliDependencies = Object.entries(readJson(`${CLI_DIR}/package.json`).dependencies ?? {})
  .filter(([name]) => workspaceDirs.has(name));

test('@nanomind/cli depends on packages in this repository', () => {
  assert.ok(cliDependencies.length > 0);
});

// When a workspace's version does not satisfy the range the CLI declares for
// it, npm installs a copy from the registry under
// packages/nanomind-cli/node_modules, and the CLI's imports of that package
// load the copy instead of the code here.
for (const [name, spec] of cliDependencies) {
  const dir = workspaceDirs.get(name);
  test(`@nanomind/cli resolves ${name} to ${dir}`, () => {
    const version = readJson(`${dir}/package.json`).version;
    const nested = lock.packages[`${CLI_DIR}/node_modules/${name}`];
    assert.equal(
      nested,
      undefined,
      `${CLI_DIR}/package.json declares ${name} ${spec} but ${dir} is version ${version},`
        + ` so package-lock.json installs ${name} ${nested?.version} under ${CLI_DIR}/node_modules; declare ^${version}`,
    );
    const hoisted = lock.packages[`node_modules/${name}`];
    assert.ok(hoisted?.link === true && hoisted.resolved === dir, `package-lock.json does not link node_modules/${name} to ${dir}`);
  });
}
