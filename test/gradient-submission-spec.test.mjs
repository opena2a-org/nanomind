import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const SOURCE = 'packages/nanomind-runtime-core/src/index.ts';
const SPEC = 'spec/NANOMIND-SPEC.md';

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

// A level-three section of the specification, from its heading to the next
// heading.
function section(number) {
  const found = read(SPEC)
    .split(/^(?=#{1,6} )/m)
    .filter((text) => text.startsWith(`### ${number} `));
  assert.equal(found.length, 1, `${SPEC} has no section ${number}, or more than one`);
  return found[0];
}

test(`the example in ${SPEC} section 4.1 carries the fields src/index.ts posts`, () => {
  const example = /```json\n([\s\S]*?)\n```/.exec(section('4.1'))?.[1];
  assert.ok(example, `${SPEC} section 4.1 has no JSON example`);
  const keys = [...example.matchAll(/^\s*"(\w+)":/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), postedFields().map((field) => field.name).sort());
});

test(`${SPEC} section 4.3 names each field src/index.ts posts as sent exact or noised, as it is sent`, () => {
  const text = section('4.3');
  const rows = new Map(
    text
      .split('\n')
      .filter((line) => /^\| `\w+` \|/.test(line))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
      .map(([field, sent, learns]) => [field.replaceAll('`', ''), { sent, learns }]),
  );
  const fields = postedFields();
  assert.deepEqual([...rows.keys()].sort(), fields.map((field) => field.name).sort(), 'the table of section 4.3 has one row per posted field');
  for (const { name, noised } of fields) {
    const { sent, learns } = rows.get(name);
    if (noised) assert.match(sent, /\bnoised\b/, `section 4.3 does not call ${name} noised`);
    else assert.equal(sent, 'exact', `section 4.3 does not call ${name} sent exact`);
    assert.ok(learns, `section 4.3 does not say what a reader of one submission learns from ${name}`);
  }
  assert.doesNotMatch(text, /\bonly differentially[- ]private\b/i, 'section 4.3 says that only differentially-private updates are sent');
});

test(`${SPEC} section 4.3 gives the number of events at which src/index.ts sends a round`, () => {
  const interval = /^const GRADIENT_FLUSH_INTERVAL = (\d+);$/m.exec(source)?.[1];
  assert.ok(interval, `${SOURCE} declares no GRADIENT_FLUSH_INTERVAL`);
  assert.match(section('4.3'), new RegExp(`\\b${interval} events\\b`));
});
