import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

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

const directory = (path) => normalize(path).replace(/\/+$/, '');

// The workspaces whose build script is tsc, which publish what it emits.
const built = workspacePackages().filter(({ manifest }) => /^tsc\b/.test(manifest.scripts?.build ?? ''));

test('finds the workspaces that build with tsc', () => {
  assert.ok(built.length > 0);
});

// Node loads an installed package that has no exports field from its main,
// and refuses to strip types from a file under node_modules, so main has to
// name the JavaScript tsc emits, and types the declarations it emits from the
// same source file.
for (const { dir, manifest } of built) {
  test(`${dir}/package.json points main and types at the files tsc builds from one tracked source`, () => {
    const { outDir, rootDir, declaration } = readJson(`${dir}/tsconfig.json`).compilerOptions ?? {};
    assert.ok(outDir && rootDir, `${dir}/tsconfig.json sets no outDir or no rootDir`);
    const out = directory(outDir);
    const sourceOf = (entry, extension) => {
      const path = normalize(entry ?? '');
      assert.ok(path.startsWith(`${out}/`) && path.endsWith(extension), `${entry} is not a ${extension} file under ${out}/`);
      return normalize(join(dir, rootDir, `${path.slice(out.length + 1, -extension.length)}.ts`));
    };

    const main = sourceOf(manifest.main, '.js');
    assert.ok(tracked.includes(main), `main ${manifest.main} would be built from ${main}, which is not tracked`);
    assert.ok(declaration, `${dir}/tsconfig.json does not emit declarations`);
    assert.equal(sourceOf(manifest.types, '.d.ts'), main, 'types is not built from the source main is built from');
    assert.ok((manifest.files ?? []).some((entry) => directory(entry) === out), `files does not publish ${out}/`);
  });
}
