#!/usr/bin/env node
// Checks the prose of the tracked Markdown files for two writing rules: no
// dash written as a double or triple hyphen, an em dash or a spaced en dash,
// and no heading or section label named "Why this exists" or "Why this
// matters".
//
// Code is not prose and is skipped: fenced and indented code blocks, also
// inside block quotes and list items, and inline code spans, also when one
// runs across a line break. Front matter, HTML comments, link targets, images,
// bare URLs, table delimiter rows and thematic breaks are skipped as well, so
// a command line such as `npm test -- --watch` stays as it is and a flag such
// as --model is not read as a dash. A code fence or HTML comment that is never
// closed would hide the rest of a file, so it is reported. Changelogs,
// licenses and test data are out of scope: history is not rewritten, and test
// text is data a test compares against.
//
// Usage: node scripts/check-docs-prose.mjs [--help] [file ...]
// With no file it checks every tracked *.md and *.mdx file in scope, or every
// such file on disk when the tree is not a git checkout. A file argument is
// read relative to the current directory.
// Exits 1 and prints file:line for each finding, 0 when there is none, and 2
// when a file or directory cannot be read or an option is unknown.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/check-docs-prose.mjs [--help] [file ...]

Reports a dash written as a double or triple hyphen, an em dash or a spaced en
dash, and a heading or label named "Why this exists" or "Why this matters", in
the prose of Markdown files. Code, front matter, comments and link targets are
not prose and are skipped. With no file it checks every tracked *.md and *.mdx
file in scope; a file argument is read relative to the current directory.

Exit status: 0 with no finding, 1 with a finding, 2 when a file or directory
cannot be read or an option is unknown.`;

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

// A run of two or three hyphens is a dash when it has a space or a line edge
// on each side, or stands against a word with no space. One with a space
// before and a letter after is a command-line flag such as --model.
const HYPHENS = /(?<![-\S])-{2,3}(?![-\S])|(?<=[\p{L}\p{N}])-{2,3}(?=[\p{L}\p{N}]|\s|$)/gu;

function hyphenRule(text, match) {
  const count = match[0].length === 2 ? 'double' : 'triple';
  const before = text[match.index - 1];
  const after = text[match.index + match[0].length];
  if (before === undefined || after === undefined) return `${count} hyphen at a line break`;
  return /\s/.test(before) && /\s/.test(after) ? `spaced ${count} hyphen` : `unspaced ${count} hyphen`;
}

const DASHES = [
  { pattern: HYPHENS, name: hyphenRule },
  { pattern: /—/g, name: () => 'em dash' },
  { pattern: /(?<!\S)–(?!\S)/g, name: () => 'spaced en dash' },
];

const WHY_THIS = /^why this (exists|matters)\b/i;

const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;

const blankOut = (text) => ' '.repeat(text.length);

// Masks the parts of a line that are not prose apart from code and comments,
// which checkText masks first: images, link targets, autolinks and bare URLs.
// Masking keeps the length, so a column still points into the source line.
export function stripNonProse(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, blankOut)
    .replace(/\](?:\([^)]*\)|\[[^\]]*\])/g, (target) => `]${blankOut(target.slice(1))}`)
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blankOut)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blankOut);
}

// The indentation of a line in columns, a tab advancing to the next multiple
// of four, and the index of its first other character.
function indentOf(text) {
  let columns = 0;
  let offset = 0;
  for (; offset < text.length; offset += 1) {
    if (text[offset] === ' ') columns += 1;
    else if (text[offset] === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return { columns, offset };
}

// Removes up to `max` block quote markers from the start of a line.
function stripQuotes(line, max = Infinity) {
  let depth = 0;
  let rest = line;
  while (depth < max) {
    const marker = /^ {0,3}>[ \t]?/.exec(rest);
    if (!marker) break;
    depth += 1;
    rest = rest.slice(marker[0].length);
  }
  return { depth, rest };
}

// The marker of a code fence that opens on this line, or null. The info
// string of a backtick fence has no backtick in it.
function fenceOpen(body) {
  const marker = /^(?:`{3,}|~{3,})/.exec(body)?.[0];
  if (!marker || (marker[0] === '`' && body.includes('`', marker.length))) return null;
  return marker;
}

function closesFence(body, marker) {
  const close = /^(`{3,}|~{3,})[ \t]*$/.exec(body);
  return close !== null && close[1][0] === marker[0] && close[1].length >= marker.length;
}

// A thematic break or setext underline.
function isRule(body) {
  return /^(?:-{2,}|=+|\*{3,}|_{3,})$/.test(body.replace(/[ \t]/g, ''));
}

function isTableDelimiter(body) {
  if (!body.includes('|')) return false;
  const cells = body.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell));
}

// The text of an ATX heading, without its closing hashes, or null. Built from
// string operations so a long run of spaces takes linear time.
function atxText(body) {
  const open = /^ {0,3}#{1,6}(?=[ \t]|$)/.exec(body);
  if (!open) return null;
  const text = body.slice(open[0].length).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === text.length || (end > 0 && !/[ \t]/.test(text[end - 1]))) return text;
  return text.slice(0, end).trimEnd();
}

// Whether a line cannot continue the paragraph above it.
function endsParagraph(content) {
  const { columns, offset } = indentOf(content);
  const body = content.slice(offset);
  if (body === '') return true;
  if (columns >= 4) return false;
  return fenceOpen(body) !== null || atxText(body) !== null || isRule(body) ||
    LIST_ITEM.test(body) || body.startsWith('>') || body.startsWith('<!--');
}

// Index of the first run of exactly `count` backticks at or after `from`, or -1.
function backtickRun(text, count, from = 0) {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let run = runs.exec(text); run; run = runs.exec(text)) {
    if (run[0].length === count) return run.index;
  }
  return -1;
}

// Masks the code spans and HTML comments of one line. `state.span` (the
// backtick count of an open code span) and `state.comment` carry a span or
// comment into the next line, and `state.opened` is set when a comment opens
// here and stays open. `closesLater(count)` tells whether a code span that
// does not close on this line closes on a later line of the same paragraph;
// when it does not, its backticks are plain text.
function maskInline(text, state, closesLater) {
  let masked = '';
  let at = 0;
  state.opened = false;
  if (state.comment) {
    const end = text.indexOf('-->');
    if (end === -1) return blankOut(text);
    state.comment = false;
    at = end + 3;
    masked = blankOut(text.slice(0, at));
  } else if (state.span) {
    const end = backtickRun(text, state.span);
    if (end === -1) return blankOut(text);
    at = end + state.span;
    masked = blankOut(text.slice(0, at));
    state.span = 0;
  }
  while (at < text.length) {
    const tick = text.indexOf('`', at);
    const comment = text.indexOf('<!--', at);
    if (tick === -1 && comment === -1) break;
    if (tick !== -1 && (comment === -1 || tick < comment)) {
      let end = tick;
      while (text[end] === '`') end += 1;
      const count = end - tick;
      masked += text.slice(at, tick);
      const close = backtickRun(text, count, end);
      if (close !== -1) {
        at = close + count;
        masked += blankOut(text.slice(tick, at));
      } else if (closesLater(count)) {
        state.span = count;
        return masked + blankOut(text.slice(tick));
      } else {
        masked += text.slice(tick, end);
        at = end;
      }
      continue;
    }
    masked += text.slice(at, comment);
    const close = text.indexOf('-->', comment + 2);
    if (close === -1) {
      state.comment = true;
      state.opened = true;
      return masked + blankOut(text.slice(comment));
    }
    at = close + 3;
    masked += blankOut(text.slice(comment, at));
  }
  return masked + text.slice(at);
}

// The text of a heading, or of a bold or italic label at the start of a line,
// or null for any other line.
function sectionName(text, next) {
  const heading = atxText(text);
  if (heading !== null) return heading;
  if (next !== undefined && SETEXT.test(next) && text.trim() !== '') return text.trim();
  const label = /^(\*{1,3}|_{1,3})(.+?)\1/.exec(text.trim());
  return label ? label[2] : null;
}

export function checkText(text) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  const report = (index, rule, column = 1) => findings.push({ line: index + 1, rule, column });
  const inline = { span: 0, comment: false, opened: false };
  let fence = null;
  let commentLine = 0;
  let lists = [];
  let depth = 0;
  let paragraph = false;
  let table = false;
  let pipe = false;
  let start = 0;

  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) start = end + 1;
  }

  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index];

    if (fence) {
      const quoted = stripQuotes(raw, fence.depth);
      const { columns, offset } = indentOf(quoted.rest);
      const body = quoted.rest.slice(offset);
      // A fenced block also ends where its block quote or list item ends.
      if (quoted.depth === fence.depth && (body === '' || columns >= fence.base)) {
        if (columns - fence.base < 4 && closesFence(body, fence.marker)) fence = null;
        continue;
      }
      fence = null;
      paragraph = false;
    }

    const { depth: quoted, rest } = stripQuotes(raw);
    const { columns, offset } = indentOf(rest);
    const body = rest.slice(offset);
    const inComment = inline.comment;
    const continued = inComment || inline.span > 0;
    let source = null;
    let heading = false;
    let rule = false;
    let delimiter = false;

    if (!continued) {
      if (body === '') {
        paragraph = false;
        table = false;
        pipe = false;
        continue;
      }
      if (quoted !== depth) {
        lists = [];
        depth = quoted;
      }
      const opener = fenceOpen(body);
      rule = isRule(body);
      heading = atxText(body) !== null;
      const listed = !rule && LIST_ITEM.test(body);
      // Only paragraph text continues a list item lazily at a smaller indent.
      if (!paragraph || opener || rule || heading || listed) {
        while (lists.length > 0 && columns < lists.at(-1)) lists.pop();
      }
      const base = lists.at(-1) ?? 0;
      if (columns >= base + 4) {
        if (!paragraph) {
          pipe = false;
          continue;
        }
        rule = false;
        heading = false;
      } else if (opener) {
        fence = { marker: opener, depth: quoted, base, line: index };
        paragraph = false;
        pipe = false;
        continue;
      } else if (listed) {
        const marker = LIST_ITEM.exec(body)[0];
        const after = body.slice(marker.length);
        source = after.trimStart();
        const spaces = after.length - source.length;
        lists.push(columns + marker.length + (source === '' || spaces > 4 ? 1 : spaces));
      } else {
        source = body;
        delimiter = !table && pipe && isTableDelimiter(body);
      }
    }

    const closesLater = heading || table || delimiter ? () => false : (count) => {
      for (let next = index + 1; next < lines.length; next += 1) {
        const following = stripQuotes(lines[next], quoted).rest;
        if (endsParagraph(following)) return false;
        if (backtickRun(following, count) !== -1) return true;
      }
      return false;
    };
    const masked = stripNonProse(maskInline(rest, inline, closesLater));
    if (inline.opened) commentLine = index;
    const shift = raw.length - rest.length + 1;

    if (!rule && !delimiter) {
      for (const { pattern, name } of DASHES) {
        for (const match of masked.matchAll(pattern)) report(index, name(masked, match), shift + match.index);
      }
    }

    if (source !== null) {
      const next = source === body && index + 1 < lines.length
        ? stripQuotes(lines[index + 1], quoted).rest
        : undefined;
      const section = sectionName(masked.slice(rest.length - source.length), next);
      if (section !== null && WHY_THIS.test(section.replace(/<[^<>]*>/g, ' ').replace(/[*_[\]]/g, '').trim())) {
        report(index, 'section named "Why this exists" or "Why this matters"');
      }
    }

    if (!continued) {
      if (delimiter) table = true;
      else if (!body.includes('|')) table = false;
      pipe = body.includes('|');
    }
    const commentOnly = masked.trim() === '' && (inComment || body.startsWith('<!--'));
    paragraph = !heading && !rule && !delimiter && !commentOnly;
  }

  if (fence) report(fence.line, 'code fence not closed');
  if (inline.comment) report(commentLine, 'HTML comment not closed');
  return findings;
}

// A directory whose files are all out of scope, such as node_modules or test
// data, is not listed. A directory that cannot be listed is added to
// unreadable as { path, error } and its files are not checked.
function filesOnDisk(cwd, unreadable, dir = '') {
  let entries;
  try {
    entries = readdirSync(join(cwd, dir), { withFileTypes: true });
  } catch (error) {
    unreadable.push({ path: `${dir === '' ? '.' : dir}/`, error });
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== '.git' && !EXCLUDED.some((pattern) => pattern.test(`${path}/`))) {
      found.push(...filesOnDisk(cwd, unreadable, path));
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

// The variables with which git names a repository to its child processes. A
// git hook can inherit them (git sets GIT_DIR for a hook in a linked
// worktree), and a git command that inherits them reads that repository
// whatever its working directory is.
const REPOSITORY_VARIABLE =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/;

// The variables that change how git matches a pathspec. With the GLOB one set,
// *.md matches only the files at the top of the tree; with NOGLOB or LITERAL,
// no file at all; with ICASE, also a file named in another case, such as
// docs/NOTES.MD.
const PATHSPEC_VARIABLE = /^GIT_(GLOB|NOGLOB|ICASE|LITERAL)_PATHSPECS$/;

// The tracked Markdown files in scope. Outside a git checkout, such as a
// source archive, or when git lists none, the files on disk; a directory that
// cannot be listed is added to unreadable as { path, error }. git finds the
// repository from cwd alone, not from the variables a git hook exports, and
// matches the pathspecs the same way whatever the environment sets.
export function trackedDocs(cwd = root, unreadable = []) {
  let listed = [];
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !REPOSITORY_VARIABLE.test(name) && !PATHSPEC_VARIABLE.test(name),
      ),
    );
    const output = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    listed = output.split('\0').filter(Boolean);
  } catch {
    // Not a git checkout, or git is not installed.
  }
  return (listed.length > 0 ? listed : filesOnDisk(cwd, unreadable)).filter(inScope).sort();
}

export function checkFiles(paths, cwd = root) {
  return paths.flatMap((path) =>
    checkText(readFileSync(resolve(cwd, path), 'utf8')).map((finding) => ({ path, ...finding })),
  );
}

function main(args) {
  const named = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') {
      options = false;
    } else if (options && (arg === '-h' || arg === '--help')) {
      console.log(USAGE);
      return 0;
    } else if (options && arg.startsWith('-') && arg !== '-') {
      console.error(`check-docs-prose: unknown option ${arg}\n\n${USAGE}`);
      return 2;
    } else {
      named.push(arg);
    }
  }

  const cwd = named.length > 0 ? process.cwd() : root;
  const unreadable = [];
  const paths = named.length > 0 ? named : trackedDocs(root, unreadable);
  const findings = [];
  for (const path of paths) {
    try {
      findings.push(...checkFiles([path], cwd));
    } catch (error) {
      unreadable.push({ path, error });
    }
  }

  for (const { path, line, rule } of findings) {
    console.error(`${path}:${line}: ${rule}`);
  }
  for (const { path, error } of unreadable) {
    console.error(`check-docs-prose: cannot read ${path} (${error.code ?? error.message})`);
  }
  if (unreadable.length > 0) return 2;
  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s) in ${new Set(findings.map((f) => f.path)).size} file(s). ` +
      'Rewrite each dash as a period, comma, colon or parentheses, fold any "Why this exists" section into ' +
      'the prose around it, and close any code fence or comment left open.');
    return 1;
  }
  console.log(`docs prose check: ${paths.length} file(s), no findings`);
  return 0;
}

// Whether node started this file as the script to run. node resolves the
// symlinks in the path of that script and process.argv[1] keeps them, as in a
// path under /tmp or /var on macOS, so both paths are resolved before they are
// compared.
function startedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  process.exitCode = main(process.argv.slice(2));
}
