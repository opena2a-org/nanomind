import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

// The README opens with an install line, the first call a reader makes after
// it, and what that call prints. The printed block is compared with what the
// call prints when it runs here, so it stays real output.
const FIRST_SCREEN_LINES = 30;

function startBlocks() {
  const lines = read('README.md').split('\n');
  const end = lines.findIndex((line) => line.startsWith('## '));
  const blocks = [];
  let open = null;
  lines.slice(0, end === -1 ? lines.length : end).forEach((line, index) => {
    if (!line.startsWith('```')) {
      if (open) open.body.push(line);
    } else if (open) {
      blocks.push({ ...open, body: open.body.join('\n') });
      open = null;
    } else {
      open = { lang: line.slice(3).trim(), line: index + 1, body: [] };
    }
  });
  return blocks;
}

// The workspace a package name belongs to, and the TypeScript file its main
// entry is built from, so the call runs without a build.
function sourceEntry(name) {
  const parents = readJson('package.json').workspaces.map((pattern) => pattern.replace(/\/\*$/, ''));
  const dir = parents
    .flatMap((parent) => readdirSync(join(root, parent)).map((entry) => `${parent}/${entry}`))
    .find((path) => existsSync(join(root, path, 'package.json')) && readJson(`${path}/package.json`).name === name);
  assert.ok(dir, `${name} is not a workspace of this repository`);
  const { outDir, rootDir } = readJson(`${dir}/tsconfig.json`).compilerOptions;
  const main = readJson(`${dir}/package.json`).main.replace(/^\.\//, '');
  assert.ok(main.startsWith(`${outDir}/`) && main.endsWith('.js'), `${name} main ${main} is not built into ${outDir}/`);
  return join(root, dir, rootDir, `${main.slice(outDir.length + 1, -'.js'.length)}.ts`);
}

test('the README start block is an install line, a call and what the call prints', () => {
  const [install, call, printed] = startBlocks();
  assert.equal(install?.lang, 'bash', 'the first block is not a bash install line');
  assert.match(install.body, /^npm install @nanomind\/[\w-]+$/);
  assert.equal(call?.lang, 'typescript', 'the second block is not the first call');
  assert.equal(printed?.lang, '', 'the third block is not plain printed output');
  assert.ok(printed.line <= FIRST_SCREEN_LINES, `the printed output opens on line ${printed.line}`);
});

test('the README start block shows what its call prints when it runs', () => {
  const [install, call, printed] = startBlocks();
  const name = install.body.replace(/^npm install /, '');
  const from = `from '${name}';`;
  assert.ok(call.body.includes(from), `the call does not import ${name}, the package the install line names`);

  const script = call.body.replace(from, `from ${JSON.stringify(pathToFileURL(sourceEntry(name)).href)};`);
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.signal, null, 'the call was still running after 30 seconds');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trimEnd(), printed.body.trimEnd());
});
