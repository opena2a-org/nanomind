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
 * equal or higher level (exclusive).
 */
function section(heading: string): string {
  const lines = SPEC.split('\n');
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
});
