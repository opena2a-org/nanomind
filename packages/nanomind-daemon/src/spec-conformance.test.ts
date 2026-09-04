import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const SPEC = readFileSync(join(ROOT, 'docs', 'SPECIFICATION.md'), 'utf-8');
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'nanomind-models.json'), 'utf-8')) as {
  attackClasses: string[];
};

// §3.4.1 is the normative definition of the /v1/infer wire vocabulary; these are
// the sources it must agree with. Read as text, never imported, so this file keeps
// running under `node --test --experimental-strip-types` with no node_modules.
const SERVER_TS_PATH = 'packages/nanomind-daemon/src/server.ts';
const ONNX_TS_PATH = 'packages/nanomind-daemon/src/onnx-engine.ts';
const DAEMON_README_PATH = 'packages/nanomind-daemon/README.md';

const SERVER_TS = readFileSync(join(HERE, 'server.ts'), 'utf-8');
const ONNX_TS = readFileSync(join(HERE, 'onnx-engine.ts'), 'utf-8');
const DAEMON_README = readFileSync(join(HERE, '..', 'README.md'), 'utf-8');

const TEN_CLASSES = [
  'exfiltration',
  'injection',
  'privilege_escalation',
  'persistence',
  'credential_abuse',
  'lateral_movement',
  'social_engineering',
  'policy_violation',
  'steganography',
  'benign',
];

/**
 * Extract a section's text: from the heading line to the next heading of
 * equal or higher level (exclusive). Defaults to the specification; the daemon
 * README is passed explicitly when checking its derived copy.
 */
function section(heading: string, doc: string = SPEC): string {
  const lines = doc.split('\n');
  const start = lines.findIndex(l => l.trim() === heading);
  if (start === -1) return '';
  const level = heading.match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Parse markdown table rows from a section: lines starting with `|`, cells
 * trimmed and backtick-stripped, separator row and header dropped.
 */
function tableRows(sectionText: string): string[][] {
  const rows = sectionText
    .split('\n')
    .filter(l => l.trimStart().startsWith('|'))
    .map(l =>
      l
        .split('|')
        .slice(1, -1)
        .map(c => c.trim().replace(/`/g, ''))
    )
    .filter(cells => !cells.every(c => /^:?-+:?$/.test(c)));
  return rows.slice(1); // drop header
}

/**
 * Split a section into its markdown tables — runs of consecutive `|` lines —
 * each parsed by `tableRows`. §3.4.1 carries three tables in one section, so
 * they have to be told apart before any of them can be compared.
 */
function tables(sectionText: string): string[][][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of sectionText.split('\n')) {
    if (line.trimStart().startsWith('|')) {
      current.push(line);
    } else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks.map(b => tableRows(b.join('\n')));
}

/**
 * The value a cell names on the wire. `tableRows` already strips backticks; the
 * daemon README additionally quotes its JSON values (`"abstain"`) where the spec
 * does not, and both spell the empty string `""`. Dropping one surrounding pair
 * of double quotes maps both spellings onto the same value.
 */
function wireValue(cell: string): string {
  const m = cell.match(/^"(.*)"$/);
  return m ? m[1] : cell;
}

// Every parser below anchors the identifier with `\b` so a longer name that merely
// starts with it (`RAW_TO_CANONICALS`) is not silently accepted as the real thing —
// otherwise a rename would leave these checks passing on a declaration that no
// longer exists.

/** String-literal members of an exported TypeScript union type, in source order. */
function tsUnionMembers(src: string, path: string, typeName: string): string[] {
  const m = src.match(new RegExp(`export type ${typeName}\\b\\s*=([^;]*);`));
  assert.ok(m, `${path}: cannot parse \`export type ${typeName}\``);
  const members = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
  assert.ok(members.length > 0, `${path}: \`export type ${typeName}\` parsed to zero members`);
  return members;
}

/** Value of an exported numeric constant. */
function tsNumberConst(src: string, path: string, constName: string): number {
  const m = src.match(new RegExp(`export const ${constName}\\b\\s*=\\s*(\\d+(?:\\.\\d+)?)`));
  assert.ok(m, `${path}: cannot parse \`export const ${constName}\``);
  return Number(m[1]);
}

/** Entries of an `Object.freeze({ key: 'value', ... })` string record. */
function tsStringRecord(src: string, path: string, constName: string): Record<string, string> {
  const m = src.match(new RegExp(`const ${constName}\\b[^=]*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`));
  assert.ok(m, `${path}: cannot parse \`${constName}\``);
  const entries: Record<string, string> = {};
  for (const [, key, value] of m[1].matchAll(/^\s*'?([A-Za-z_]\w*)'?\s*:\s*'([^']*)'\s*,/gm)) {
    entries[key] = value;
  }
  assert.ok(Object.keys(entries).length > 0, `${path}: \`${constName}\` parsed to zero entries`);
  return entries;
}

/** Field names of an exported interface, optional members suffixed `?`, in source order. */
function tsInterfaceFields(src: string, path: string, name: string): string[] {
  const m = src.match(new RegExp(`export interface ${name}\\b\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `${path}: cannot parse \`export interface ${name}\``);
  const fields = [...m[1].matchAll(/^ {2}([A-Za-z_]\w*)(\??):/gm)].map(x => x[1] + x[2]);
  assert.ok(fields.length > 0, `${path}: \`export interface ${name}\` parsed to zero fields`);
  return fields;
}

describe('spec conformance', () => {
  const sec42 = section('### 4.2 Attack Class Taxonomy (v0.4.0)');
  const sec43 = section('### 4.3 Emitted-Token Vocabulary');
  const sec5 = section('## 5. Consumer Integration Requirements');

  it('NMD-01.AC4 §4.2 lists exactly the ten classes and none is not a class', () => {
    const classes = tableRows(sec42).map(r => r[0]);
    assert.strictEqual(classes.length, 10);
    assert.deepStrictEqual(new Set(classes), new Set(TEN_CLASSES));
    assert.ok(!classes.includes('none'));
  });

  it('NMD-01.AC4 §4.2 agrees with nanomind-models.json attackClasses', () => {
    const classes = tableRows(sec42).map(r => r[0]);
    assert.deepStrictEqual(new Set(classes), new Set(CATALOG.attackClasses));
  });

  it('NMD-01.AC1 §4.3 defines none as the benign-case emitted token normalizing to benign', () => {
    const rows = tableRows(sec43);
    const noneRow = rows.find(r => r[0] === 'none');
    assert.ok(noneRow, '§4.3 table has a row whose first cell is `none`');
    assert.ok(noneRow[2].startsWith('benign'), '`none` row normalizes to `benign`');
    assert.ok(!rows.some(r => r[0] === 'benign'), 'no §4.3 row emits `benign`');
  });

  it('NMD-01.AC2 §4.3 names both namespaces', () => {
    assert.ok(/class namespace/i.test(sec43));
    assert.ok(/emitted-token namespace/i.test(sec43));
  });

  it('NMD-01.AC3 §4.3 states this specification is the normative definition', () => {
    assert.ok(sec43.includes('normative definition'));
  });

  it('NMD-01.AC1 §5 tells consumers attackClass: none is the benign case', () => {
    assert.ok(sec5.includes('attackClass: none'));
  });

  // §3.4.1 is the normative definition of the /v1/infer wire vocabulary. Every
  // check below reads the tree — the spec, the daemon README, server.ts and
  // onnx-engine.ts — and compares them against each other. Nothing here is
  // asserted against a literal copied into this file, so the spec cannot drift
  // from the daemon without a check going red.
  const HEADING_341 = '#### 3.4.1 /v1/infer Wire Vocabulary';
  const sec34 = section('### 3.4 NanoMind Daemon (localhost:47200)');
  const sec341 = section(HEADING_341);

  /** The three §3.4.1 tables — enum, classification, mapping — or a failure naming the gap. */
  function specTables(): [string[][], string[][], string[][]] {
    assert.ok(sec341.length > 0, `docs/SPECIFICATION.md: cannot find the \`${HEADING_341}\` heading`);
    const found = tables(sec341);
    assert.strictEqual(
      found.length,
      3,
      'docs/SPECIFICATION.md §3.4.1 carries exactly three tables (attackClass enum, classification, mapping)'
    );
    found.forEach((rows, i) =>
      assert.ok(rows.length > 0, `docs/SPECIFICATION.md §3.4.1 table ${i + 1} parsed to zero rows`)
    );
    return found as [string[][], string[][], string[][]];
  }

  /** The single table under a daemon README heading, or a failure naming the gap. */
  function readmeTable(heading: string): string[][] {
    const sec = section(heading, DAEMON_README);
    assert.ok(sec.length > 0, `${DAEMON_README_PATH}: cannot find the \`${heading}\` heading`);
    const found = tables(sec);
    assert.strictEqual(found.length, 1, `${DAEMON_README_PATH}: \`${heading}\` carries exactly one table`);
    assert.ok(found[0].length > 0, `${DAEMON_README_PATH}: \`${heading}\` table parsed to zero rows`);
    return found[0];
  }

  it('NMD-03.AC3 §3.4.1 attackClass enum equals the AttackClass union in server.ts', () => {
    const [enumTable] = specTables();
    const values = enumTable.map(r => wireValue(r[0]));
    assert.strictEqual(values.length, 5, '§3.4.1 attackClass table has exactly five value cells');
    assert.ok(values.includes(''), '§3.4.1 documents the empty string as a member of the enum');
    assert.deepStrictEqual(
      new Set(values),
      new Set(tsUnionMembers(SERVER_TS, SERVER_TS_PATH, 'AttackClass'))
    );
  });

  it('NMD-03.AC3 §3.4.1 classification statuses equal the ClassificationStatus union in server.ts', () => {
    const [, statusTable] = specTables();
    const values = statusTable.map(r => wireValue(r[0]));
    assert.strictEqual(values.length, 2, '§3.4.1 classification table has exactly two value cells');
    assert.deepStrictEqual(
      new Set(values),
      new Set(tsUnionMembers(SERVER_TS, SERVER_TS_PATH, 'ClassificationStatus'))
    );
  });

  it('NMD-03.AC3 §3.4.1 abstain floor equals ABSTAIN_CONFIDENCE_FLOOR in server.ts', () => {
    assert.ok(sec341.length > 0, `docs/SPECIFICATION.md: cannot find the \`${HEADING_341}\` heading`);
    const stated = sec341.match(/abstain confidence floor is `(\d+(?:\.\d+)?)`/i);
    assert.ok(stated, 'docs/SPECIFICATION.md §3.4.1 states the abstain confidence floor as a literal');
    assert.strictEqual(
      Number(stated[1]),
      tsNumberConst(SERVER_TS, SERVER_TS_PATH, 'ABSTAIN_CONFIDENCE_FLOOR')
    );
  });

  it('NMD-03.AC3 §3.4.1 mapping is total over §4.2 and equals RAW_TO_CANONICAL in onnx-engine.ts', () => {
    const [enumTable, , mapTable] = specTables();
    assert.strictEqual(mapTable.length, 10, '§3.4.1 mapping table has exactly ten rows');

    const mapping = Object.fromEntries(mapTable.map(r => [r[0], wireValue(r[1])]));
    assert.strictEqual(Object.keys(mapping).length, 10, '§3.4.1 mapping table names each class once');
    assert.deepStrictEqual(mapping, tsStringRecord(ONNX_TS, ONNX_TS_PATH, 'RAW_TO_CANONICAL'));

    // Total over §4.2: the left column is exactly the ten classes of the taxonomy.
    assert.deepStrictEqual(new Set(Object.keys(mapping)), new Set(tableRows(sec42).map(r => r[0])));

    // Onto the enum: every non-empty enum value is reached by at least one row.
    const reached = new Set(Object.values(mapping));
    for (const value of enumTable.map(r => wireValue(r[0]))) {
      if (value !== '') {
        assert.ok(reached.has(value), `§3.4.1 enum value \`${value}\` is unreached by the mapping table`);
      }
    }
  });

  it('NMD-03.AC3 daemon README carries a derived copy of the three §3.4.1 tables', () => {
    const [specEnum, specStatus, specMap] = specTables();

    // Value columns must be identical. The Meaning columns are prose and the
    // README deliberately states the same rules at more operational depth (the
    // HTTP 500 path, a NaN score), so they are not compared byte-for-byte.
    assert.deepStrictEqual(
      readmeTable('### `attackClass` enum').map(r => wireValue(r[0])),
      specEnum.map(r => wireValue(r[0]))
    );
    assert.deepStrictEqual(
      readmeTable('### `classification` (abstain signal)').map(r => wireValue(r[0])),
      specStatus.map(r => wireValue(r[0]))
    );

    // The mapping table is pure vocabulary, so it is compared in full.
    assert.deepStrictEqual(
      readmeTable('### `attackClass` mapping').map(r => [r[0], wireValue(r[1])]),
      specMap.map(r => [r[0], wireValue(r[1])])
    );
  });

  it('NMD-03.AC3 §3.4.1 keeps the abstain rule and claims the normative definition', () => {
    assert.ok(sec341.length > 0, `docs/SPECIFICATION.md: cannot find the \`${HEADING_341}\` heading`);
    assert.ok(
      sec341.includes('MUST NOT be read as benign'),
      '§3.4.1 states that an abstain `attackClass` MUST NOT be read as benign'
    );
    assert.ok(
      sec341.includes('normative definition'),
      '§3.4.1 claims to be the normative definition of this namespace'
    );
  });

  it('NMD-03.AC2 §3.4 Response line is the real InferResponse field set', () => {
    assert.ok(sec34.length > 0, 'docs/SPECIFICATION.md: cannot find the `### 3.4` heading');
    const line = sec34.match(/^\s*Response:\s*\{([^}]*)\}/m);
    assert.ok(line, 'docs/SPECIFICATION.md §3.4 carries a `Response: { ... }` line for /v1/infer');
    const specFields = line[1].split(',').map(f => f.trim()).filter(Boolean);

    assert.deepStrictEqual(specFields, tsInterfaceFields(SERVER_TS, SERVER_TS_PATH, 'InferResponse'));

    // The README's response schema is the same field set, `?` where Required is "no".
    assert.deepStrictEqual(
      readmeTable('### Response schema').map(r => r[0] + (r[2].toLowerCase() === 'yes' ? '' : '?')),
      specFields
    );
  });
});
