import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('nanomind-models.json'));

const ANALYST_PACKAGE = 'packages/nanomind-analyst';
const DAEMON_MODULE = `${ANALYST_PACKAGE}/src/nanomind_analyst/daemon/nanomind_guard_daemon.py`;
const GATE_MODULE = `${ANALYST_PACKAGE}/src/nanomind_analyst/daemon/input_classifier/predictor.py`;

// Read from the manifest, so the card of a new analyst version is checked too.
function analystModelCards() {
  const versions = manifest.models['nanomind-security-analyst'].versions;
  return [...new Set(Object.values(versions).map((record) => record.modelCard).filter(Boolean))];
}

function deploymentNotes(path) {
  const section = read(path).match(/\n## Deployment notes[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(section, `${path} has no Deployment notes section`);
  return section[1].replace(/\s+/g, ' ');
}

test('the analyst daemon and its input-classifier gate ship in this repository', () => {
  for (const path of [DAEMON_MODULE, GATE_MODULE]) {
    assert.ok(existsSync(join(root, path)), `${path} is missing`);
  }
});

// The card is also the README of the Hugging Face model repository, where the
// daemon and the gate are absent. In this repository they ship in the analyst
// package, so the card says where they are rather than that they are elsewhere.
test('the analyst model card does not say the daemon and gate are outside this repository', () => {
  for (const card of analystModelCards()) {
    const denials = deploymentNotes(card)
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /\b(?:not|neither|nor)\b/i.test(sentence) && /\bthis repo(?:sitory)?\b/i.test(sentence));
    assert.deepEqual(denials, [], card);
  }
});

test('the analyst model card names the package that ships the daemon and gate', () => {
  const name = read(`${ANALYST_PACKAGE}/pyproject.toml`).match(/^name = "([^"]+)"/m)[1];
  for (const card of analystModelCards()) {
    const notes = deploymentNotes(card);
    assert.ok(notes.includes(`\`${name}\``), `${card} does not name the ${name} package`);
    assert.ok(notes.includes(`\`${ANALYST_PACKAGE}\``), `${card} does not point to ${ANALYST_PACKAGE}`);
  }
});
