import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trackedDocs } from '../scripts/check-docs-prose.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

// A comment in a code block that opens with `{` is a sample of the value the
// statement above it returns. A sample shows the fields of that value, or
// writes `...` in each object or array it leaves a field or item out of, so a
// reader can tell a shortened sample from the whole value. A sample outside
// the files below is compared with what its statement returns when its block
// runs here.

// Files with samples this test does not run, and why.
const NOT_RUN = new Map([
  ['packages/nanomind-atc/README.md', 'its calls fetch trust data from the Registry over the network'],
]);

const CODE = /^(?:typescript|ts|javascript|js)$/;
const COMMENT = /^\s*\/\//;
const SAMPLE = /^\s*\/\/\s*\{/;

// The Markdown files the docs check reads. Changelogs are not among them, so a
// sample there keeps what a release returned.
const docs = trackedDocs();

// The fenced code blocks of a Markdown file, each with its language and the
// line of the file its first line is on.
function codeBlocks(text) {
  const blocks = [];
  let open = null;
  text.split('\n').forEach((line, index) => {
    if (!line.startsWith('```')) {
      if (open) open.lines.push(line);
    } else if (open) {
      blocks.push(open);
      open = null;
    } else {
      open = { lang: line.slice(3).trim(), start: index + 2, lines: [] };
    }
  });
  return blocks;
}

// Reads the value a sample shows from the start of `text`: objects and arrays
// whose values are strings, numbers, true, false, null, or objects and arrays
// in turn. A `...` entry marks the object or array it is in as one that leaves
// entries out. Returns the value and the number of characters of `text` it was
// read from.
function parseSample(text, where) {
  let at = 0;
  const fail = (expected) => {
    throw new SyntaxError(`${where}: expected ${expected} at ${JSON.stringify(text.slice(at, at + 24))}`);
  };
  const skip = () => {
    while (at < text.length && /\s/.test(text[at])) at += 1;
  };
  const eat = (token) => {
    skip();
    if (!text.startsWith(token, at)) return false;
    at += token.length;
    return true;
  };
  const token = (pattern, expected) => {
    skip();
    const match = pattern.exec(text.slice(at));
    if (!match) fail(expected);
    at += match[0].length;
    return match[0];
  };
  const string = () => {
    const quoted = token(/^(['"])(?:\\.|(?!\1)[^\\\n])*\1/, 'a string');
    return quoted.slice(1, -1).replace(/\\(.)/g, (_, char) => ({ n: '\n', t: '\t' })[char] ?? char);
  };
  // The entries up to `close`, each read by `entry`, and whether one is `...`.
  const list = (close, entry) => {
    const read = { entries: [], partial: false };
    if (eat(close)) return read;
    do {
      if (eat(close)) return read;
      if (eat('...')) read.partial = true;
      else read.entries.push(entry());
    } while (eat(','));
    if (!eat(close)) fail(`, or ${close}`);
    return read;
  };
  const value = () => {
    if (eat('{')) {
      const { entries, partial } = list('}', () => {
        skip();
        const key = /['"]/.test(text[at] ?? '') ? string() : token(/^[A-Za-z_$][\w$]*/, 'a field name');
        if (!eat(':')) fail(':');
        return [key, value()];
      });
      return { kind: 'object', fields: new Map(entries), partial };
    }
    if (eat('[')) {
      const { entries, partial } = list(']', value);
      return { kind: 'array', items: entries, partial };
    }
    skip();
    if (/['"]/.test(text[at] ?? '')) return { kind: 'scalar', value: string() };
    const literal = token(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$])/, 'a value');
    return { kind: 'scalar', value: JSON.parse(literal) };
  };
  const shown = value();
  return { shown, length: at };
}

// What a sample gets wrong about a value: a field or item it shows that the
// value does not have or has with another value, and a field or item the value
// has that the sample neither shows nor marks with `...`.
function differences(shown, actual, path = '') {
  const name = path || 'the value';
  if (shown.kind === 'scalar') {
    return Object.is(shown.value, actual) ? [] : [`${name} is ${JSON.stringify(actual)}, the sample shows ${JSON.stringify(shown.value)}`];
  }
  if (shown.kind === 'array') {
    if (!Array.isArray(actual)) return [`${name} is ${JSON.stringify(actual)}, the sample shows an array`];
    const found = shown.items.flatMap((item, index) =>
      index < actual.length ? differences(item, actual[index], `${path}[${index}]`) : [`${path}[${index}] is shown but not returned`],
    );
    if (!shown.partial) {
      for (let index = shown.items.length; index < actual.length; index += 1) {
        found.push(`${path}[${index}] is returned but the sample neither shows it nor marks it with ...`);
      }
    }
    return found;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return [`${name} is ${JSON.stringify(actual)}, the sample shows an object`];
  }
  const field = (key) => (path ? `${path}.${key}` : key);
  const found = [...shown.fields].flatMap(([key, value]) =>
    Object.hasOwn(actual, key) ? differences(value, actual[key], field(key)) : [`${field(key)} is shown but not returned`],
  );
  if (!shown.partial) {
    for (const key of Object.keys(actual)) {
      if (!shown.fields.has(key)) found.push(`${field(key)} is returned but the sample neither shows it nor marks it with ...`);
    }
  }
  return found;
}

// The samples in a code block: the file line each opens on, the value it
// shows and the index of the block line holding the statement it follows.
function blockSamples(file, block) {
  const found = [];
  for (let index = 0; index < block.lines.length; index += 1) {
    if (!SAMPLE.test(block.lines[index])) continue;
    const line = block.start + index;
    let last = index;
    while (last + 1 < block.lines.length && COMMENT.test(block.lines[last + 1])) last += 1;
    const comment = block.lines.slice(index, last + 1).map((text) => text.replace(COMMENT, '')).join('\n');
    const { shown, length } = parseSample(comment, `${file}:${line}`);
    const rest = comment.slice(length).split('\n')[0];
    assert.match(rest, /^\s*$/, `${file}:${line}: the sample ends with ${JSON.stringify(rest.trim())}`);
    let statement = index - 1;
    while (statement >= 0 && (block.lines[statement].trim() === '' || COMMENT.test(block.lines[statement]))) statement -= 1;
    assert.ok(statement >= 0, `${file}:${line}: no statement comes before the sample`);
    found.push({ line, shown, statement });
    index += comment.slice(0, length).split('\n').length - 1;
  }
  return found;
}

// The workspace a package name belongs to, and the TypeScript file its main
// entry is built from, so a block runs without a build.
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

// Runs a code block with the @nanomind packages it imports loaded from their
// TypeScript source, and returns the value of each statement a sample follows,
// in block order.
function sampledValues(file, block, found) {
  const lines = [...block.lines];
  for (const { line, statement } of found) {
    const match = /^(\s*(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?)(.+?);\s*$/.exec(lines[statement]);
    assert.ok(match, `${file}:${block.start + statement}: the line before the sample on line ${line} is not a one-line statement`);
    lines[statement] = `${match[1]}__show(${match[2]});`;
  }
  const script = [
    'const __shown = [];',
    'const __show = (value) => (__shown.push(value), value);',
    ...lines.map((text) =>
      text.replace(/(\bfrom\s+)(['"])(@nanomind\/[\w-]+)\2/, (_match, from, _quote, name) => `${from}${JSON.stringify(pathToFileURL(sourceEntry(name)).href)}`),
    ),
    'console.log(JSON.stringify(__shown));',
  ].join('\n');
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.signal, null, `${file}:${block.start}: the block was still running after 30 seconds`);
  assert.equal(run.status, 0, `${file}:${block.start}: ${run.stderr}`);
  return JSON.parse(run.stdout.trimEnd().split('\n').at(-1));
}

test('a sample that leaves out a returned field without a ..., or shows another value, is reported', () => {
  const direct = { safe: true, patterns: [], source: 'direct', recommendation: '' };
  const shows = (text, actual) => differences(parseSample(text, 'sample').shown, actual);
  assert.deepEqual(shows('{ safe: true, patterns: [] }', direct), [
    'source is returned but the sample neither shows it nor marks it with ...',
    'recommendation is returned but the sample neither shows it nor marks it with ...',
  ]);
  assert.deepEqual(shows('{ safe: true, patterns: [], ... }', direct), []);
  assert.deepEqual(shows("{ safe: true, patterns: [], source: 'direct', recommendation: '' }", direct), []);
  assert.deepEqual(shows("{ safe: false, patterns: [], source: 'piped', ... }", direct), [
    'safe is true, the sample shows false',
    'source is "direct", the sample shows "piped"',
  ]);

  const piped = {
    safe: false,
    patterns: [{ type: 'instruction_override', match: 'ignore previous instructions', position: 0, severity: 'critical' }],
    source: 'piped',
    recommendation: 'BLOCKED',
  };
  assert.deepEqual(shows("{ safe: false, patterns: [{ type: 'instruction_override', severity: 'critical' }], ... }", piped), [
    'patterns[0].match is returned but the sample neither shows it nor marks it with ...',
    'patterns[0].position is returned but the sample neither shows it nor marks it with ...',
  ]);
  assert.deepEqual(shows("{ safe: false, patterns: [{ type: 'instruction_override', ... }], ... }", piped), []);
  assert.deepEqual(shows('{ safe: false, patterns: [], ... }', piped), [
    'patterns[0] is returned but the sample neither shows it nor marks it with ...',
  ]);
});

test('each sample in a code block shows every field its statement returns, or marks the ones it leaves out with ...', () => {
  const withSamples = [];
  const found = [];
  for (const file of docs) {
    const blocks = codeBlocks(read(file))
      .filter((block) => CODE.test(block.lang))
      .map((block) => ({ block, samples: blockSamples(file, block) }))
      .filter(({ samples }) => samples.length > 0);
    if (blocks.length === 0) continue;
    withSamples.push(file);
    if (NOT_RUN.has(file)) continue;
    for (const { block, samples } of blocks) {
      const values = sampledValues(file, block, samples);
      samples.forEach(({ line, shown }, index) => {
        found.push(...differences(shown, values[index]).map((difference) => `${file}:${line}: ${difference}`));
      });
    }
  }
  assert.ok(withSamples.some((file) => !NOT_RUN.has(file)), 'no Markdown file has a sample this test runs');
  for (const file of NOT_RUN.keys()) {
    assert.ok(withSamples.includes(file), `${file} is listed as not run but has no sample`);
  }
  assert.deepEqual(found, []);
});
