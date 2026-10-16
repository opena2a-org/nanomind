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
const PAGES = ['README.md', 'CONTRIBUTING.md', 'docs/integrations.md', 'docs/cli-mode.md', 'docs/models.md'];

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

// Every command line in a fenced block, with its continuation lines joined.
function fencedCommands(text) {
  const blocks = text.match(/^```[^\n]*\n[\s\S]*?^```/gm) ?? [];
  return blocks
    .flatMap((block) => block.replace(/\\\n\s*/g, ' ').split('\n').slice(1, -1))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function workspaces() {
  return readJson('package.json').workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[^*]+\/\*$/, `unsupported workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    return [...new Set(tracked.filter((file) => file.startsWith(`${parent}/`)).map((file) => file.split('/')[1]))]
      .map((name) => `${parent}/${name}/package.json`)
      .filter((path) => existsSync(join(root, path)))
      .map((path) => readJson(path));
  });
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
}

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
