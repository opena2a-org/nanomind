#!/usr/bin/env node
// Checks the prose of the tracked Markdown files for two writing rules: no
// spaced double hyphen, em dash or spaced en dash used as a dash, and no
// heading or section named "Why this exists" or "Why this matters".
//
// Fenced code blocks, inline code spans, front matter, HTML comments, link
// targets, images and bare URLs are not prose and are skipped, so a command
// line such as `npm test -- --watch` stays as it is. Changelogs, licenses and
// test data are out of scope: history is not rewritten, and test text is data
// a test compares against.
//
// Usage: node scripts/check-docs-prose.mjs [file ...]
// With no arguments it checks every tracked *.md and *.mdx file in scope.
// Exits 1 and prints file:line for each finding; exits 0 when there is none.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED = [
  /(^|\/)CHANGELOG\.md$/i,
  /(^|\/)changelog\.d\//i,
  /(^|\/)LICENSE[^/]*$/i,
  /(^|\/)(node_modules|vendor|dist|build)\//,
  /(^|\/)(test|tests|__tests__|fixtures?|corpus|golden|snapshots?|__snapshots__|examples?)\//i,
];

export function inScope(path) {
  return /\.mdx?$/i.test(path) && !EXCLUDED.some((pattern) => pattern.test(path));
}

const DASHES = [
  { pattern: / -- /g, name: 'spaced double hyphen' },
  { pattern: /—/g, name: 'em dash' },
  { pattern: / – /g, name: 'spaced en dash' },
];

const WHY_THIS = /^why this (exists|matters)\b/i;

// Removes the parts of a line that are not prose: inline code spans (any
// number of backticks), images, link targets, autolinks and bare URLs.
export function stripNonProse(line) {
  return line
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
}

// The text of a heading or of a line that stands alone as a section label in
// bold or italics, or null for any other line.
function sectionName(line, next) {
  const atx = line.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
  if (atx) return atx[1];
  if (next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next) && line.trim() !== '') return line.trim();
  const label = line.trim().match(/^(\*\*|__|\*|_)(.+?)\1:?$/);
  return label ? label[2] : null;
}

export function checkText(text) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  let fence = null;
  let inComment = false;
  let start = 0;

  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) start = end + 1;
  }

  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index];

    if (fence) {
      const close = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      continue;
    }

    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    let prose = stripNonProse(line).replace(/<!--[\s\S]*?-->/g, ' ');
    const comment = prose.indexOf('<!--');
    if (comment !== -1) {
      prose = prose.slice(0, comment);
      inComment = true;
    }

    for (const { pattern, name } of DASHES) {
      for (const match of prose.matchAll(pattern)) {
        findings.push({ line: index + 1, rule: name, column: match.index + 1 });
      }
    }

    const section = sectionName(prose, lines[index + 1]);
    if (section !== null && WHY_THIS.test(stripNonProse(section).replace(/[*_]/g, '').trim())) {
      findings.push({ line: index + 1, rule: 'section named "Why this exists" or "Why this matters"', column: 1 });
    }
  }
  return findings;
}

export function trackedDocs(cwd = root) {
  const output = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], { cwd, encoding: 'utf8' });
  return output.split('\0').filter(Boolean).filter(inScope).sort();
}

export function checkFiles(paths, cwd = root) {
  return paths.flatMap((path) =>
    checkText(readFileSync(join(cwd, path), 'utf8')).map((finding) => ({ path, ...finding })),
  );
}

function main(args) {
  const paths = args.length > 0 ? args : trackedDocs();
  const findings = checkFiles(paths);
  for (const { path, line, rule } of findings) {
    console.error(`${path}:${line}: ${rule}`);
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s) in ${new Set(findings.map((f) => f.path)).size} file(s). ` +
      'Rewrite each dash as a period, comma, colon or parentheses, and fold any "Why this exists" section into the prose around it.');
    return 1;
  }
  console.log(`docs prose check: ${paths.length} file(s), no findings`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
