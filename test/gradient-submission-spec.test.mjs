import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const SOURCE = 'packages/nanomind-runtime-core/src/index.ts';
const SPEC = 'spec/NANOMIND-SPEC.md';
const DOCS = 'docs/SPECIFICATION.md';

const source = read(SOURCE);

// The fields of the object src/index.ts serializes as the body of its POST to
// the behavioral-gradient endpoint, one `name: value` pair per line. A field is
// noised when its value comes from addPrivacyNoise.
function postedFields() {
  const body = /fetch\(\s*'[^']*\/behavioral-gradient'[\s\S]*?\bbody: JSON\.stringify\(\{\n([\s\S]*?)\n\s*\}\)/.exec(source)?.[1];
  assert.ok(body, `${SOURCE} posts no JSON body to the behavioral-gradient endpoint`);
  const noisy = new Set([...source.matchAll(/\bconst (\w+) = this\.addPrivacyNoise\(/g)].map((match) => match[1]));
  const fields = [...body.matchAll(/^\s*(\w+): (.+?),?$/gm)].map(([, name, value]) => ({
    name,
    noised: noisy.has(value) || /\baddPrivacyNoise\(/.test(value),
  }));
  assert.ok(fields.some((field) => field.noised), `${SOURCE} posts no field whose value comes from addPrivacyNoise`);
  return fields;
}

// A level-three section of a Markdown file, from its heading to the next
// heading.
function section(path, number) {
  const found = read(path)
    .split(/^(?=#{1,6} )/m)
    .filter((text) => text.startsWith(`### ${number} `));
  assert.equal(found.length, 1, `${path} has no section ${number}, or more than one`);
  return found[0];
}

test(`the example in ${SPEC} section 4.1 carries the fields src/index.ts posts`, () => {
  const example = /```json\n([\s\S]*?)\n```/.exec(section(SPEC, '4.1'))?.[1];
  assert.ok(example, `${SPEC} section 4.1 has no JSON example`);
  const keys = [...example.matchAll(/^\s*"(\w+)":/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), postedFields().map((field) => field.name).sort());
});

test(`${SPEC} section 4.3 names each field src/index.ts posts as sent exact or noised, as it is sent`, () => {
  const text = section(SPEC, '4.3');
  assertFieldTable(text, `${SPEC} section 4.3`);
  assert.doesNotMatch(text, /\bonly differentially[- ]private\b/i, 'section 4.3 says that only differentially-private updates are sent');
});

test(`${SPEC} section 4.3 gives the number of events at which src/index.ts sends a round`, () => {
  const interval = /^const GRADIENT_FLUSH_INTERVAL = (\d+);$/m.exec(source)?.[1];
  assert.ok(interval, `${SOURCE} declares no GRADIENT_FLUSH_INTERVAL`);
  assert.match(section(SPEC, '4.3'), new RegExp(`\\b${interval} events\\b`));
});

// Checks the rows of the tables in `text` whose first cell is a field name in
// backticks: one row per field src/index.ts posts, the second cell calling the
// noised field noised and each other field exact, and a third cell that is not
// empty.
function assertFieldTable(text, where) {
  const rows = new Map(
    text
      .split('\n')
      .filter((line) => /^\| `\w+` \|/.test(line))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
      .map(([field, sent, about]) => [field.replaceAll('`', ''), { sent, about }]),
  );
  const fields = postedFields();
  assert.deepEqual([...rows.keys()].sort(), fields.map((field) => field.name).sort(), `the table of ${where} has one row per posted field`);
  for (const { name, noised } of fields) {
    const { sent, about } = rows.get(name);
    if (noised) assert.match(sent, /\bnoised\b/, `${where} does not call ${name} noised`);
    else assert.equal(sent, 'exact', `${where} does not call ${name} sent exact`);
    assert.ok(about, `${where} leaves the third cell of the ${name} row empty`);
  }
}

test(`${DOCS} section 3.5 names each field src/index.ts posts as sent exact or noised, as it is sent`, () => {
  assertFieldTable(section(DOCS, '3.5'), `${DOCS} section 3.5`);
});

test(`the payload line under the POST in ${DOCS} section 3.5 lists the fields src/index.ts posts`, () => {
  const payload = /POST \/api\/v1\/telemetry\/behavioral-gradient\n\s*(\{.*\})$/m.exec(section(DOCS, '3.5'))?.[1];
  assert.ok(payload, `${DOCS} section 3.5 has no payload line under its POST to the behavioral-gradient endpoint`);
  const keys = [...payload.matchAll(/[{,]\s*([A-Za-z_]\w*)(?=\s*[:,}])/g)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), postedFields().map((field) => field.name).sort());
});

test(`${DOCS} sections 2.2 and 3.5 name the noised field and the fields sent exact, not only differentially-private gradients`, () => {
  const noised = postedFields().filter((field) => field.noised).map((field) => field.name);
  for (const number of ['2.2', '3.5']) {
    const text = section(DOCS, number);
    for (const name of noised) {
      assert.ok(text.includes(`\`${name}\``), `${DOCS} section ${number} does not name ${name}, the field differential privacy covers`);
    }
    assert.match(text, /\bsent exact\b/, `${DOCS} section ${number} does not say that the other fields are sent exact`);
  }
  assert.doesNotMatch(read(DOCS), /\bonly differentially[- ]private\b/i, `${DOCS} says that only differentially-private gradients are submitted`);
});
