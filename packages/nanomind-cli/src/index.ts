#!/usr/bin/env node
/**
 * @nanomind/cli — Unified NanoMind CLI Entry Point
 *
 * Run directly as the `nanomind` command, it starts the interactive NanoMind
 * prompt, or answers --help and --version. `nanomind --no-guard` starts the
 * session with `noGuard: true`, which skips input screening and prints a
 * warning to stderr. `nanomind teach` runs teach mode (teach.ts), which typing
 * `teach` in a session also starts.
 *
 * Imported, it is the entry point that HMA, secretless-ai, and opena2a
 * adapters delegate to when the user runs their CLI with no arguments.
 *
 * Requests are routed by pattern matching (@nanomind/router). No model is
 * involved.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyIntent, mapToCommand, isATCIntent, type IntentClassification } from '@nanomind/router';
import { ATCIntentHandler } from '@nanomind/atc';
import { screenInput, detectInputSource, type InputSource, type DetectedPattern } from '@nanomind/guard';
import { SkillAdapter } from './adapt.ts';
import { SessionManager, type Finding } from './session.ts';
import { generateArtifact, detectArtifactType, artifactTypeFromInput, listArtifactTypes } from './codegen.ts';
import { runTeachMode } from './teach.ts';

export interface NanoMindSession {
  cliName: string;
  cliVersion: string;
  registryUrl: string;
  onCommand: (cmd: string, args: string[]) => Promise<string>;
  /** CLI that scan, fix, status and help requests run. Defaults to cliName. */
  targetCli?: string;
  projectDir?: string; // directory generated artifacts are for; defaults to the working directory
  noGuard?: boolean; // set when the user launched with --no-guard; input is not screened and a warning is printed
}

/** The launch flag that turns off input screening for one session. */
export const NO_GUARD_FLAG = '--no-guard';

/** The session input, and the `nanomind` argument, that start teach mode. */
const TEACH_COMMAND = 'teach';

export const NO_GUARD_WARNING =
  'WARNING: --no-guard is set. Piped and file input is not screened for prompt injection in this session.';

/**
 * True when the user's launch arguments (argv without the node and script
 * paths) include --no-guard.
 */
export function hasNoGuardFlag(args: string[]): boolean {
  return args.includes(NO_GUARD_FLAG);
}

export interface ScreenedLine {
  /** True when the line must not be routed. */
  blocked: boolean;
  /** The BLOCKED, WARNING or NOTICE text to print. */
  message: string;
}

const SOURCE_LABELS: Record<InputSource, string> = {
  direct: 'direct input',
  piped: 'piped input',
  file: 'file input',
  env: 'environment input',
  'agent-output': 'agent output',
};

// Characters a terminal would not show, or would act on: C0 and C1 controls
// (escape among them), zero-width, line and paragraph separators, and
// bidirectional marks.
const UNPRINTABLE_RANGES: Array<[number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202f],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

function printable(text: string): string {
  return Array.from(text, (c) => {
    const code = c.codePointAt(0) ?? 0;
    const hidden = UNPRINTABLE_RANGES.some(([low, high]) => code >= low && code <= high);
    return hidden ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }).join('');
}

/**
 * Name matched patterns for a session message: the kind of each and the text
 * it matched, quoted, with characters a terminal would not show written as
 * \uXXXX escapes. The guard releases published to npm (0.1.0 and 0.1.1) do
 * not export a way to do this, so the session does it here.
 */
function describePatterns(patterns: DetectedPattern[]): string {
  return patterns.map((p) => `${p.type.replaceAll('_', ' ')} "${printable(p.match)}"`).join(', ');
}

/**
 * Screen one line of session input from `source`. Returns null when the line
 * is not screened or no pattern matched. Otherwise it returns the message to
 * print and whether the line is blocked. A blocked line gets the guard's
 * BLOCKED text. A line that is not blocked is routed at once, so its WARNING
 * or NOTICE names the matched pattern and says the line is still routed, in
 * place of the guard's advice to review the input before proceeding.
 */
export function screenLine(input: string, source: InputSource, noGuard = false): ScreenedLine | null {
  if (noGuard || source === 'direct') return null;
  const result = screenInput(input, source);
  if (!result.recommendation) return null;
  if (!result.safe) return { blocked: true, message: result.recommendation };

  const high = result.patterns.filter((p) => p.severity === 'high');
  const from = SOURCE_LABELS[source];
  const message = high.length > 0
    ? `WARNING: Suspicious pattern detected in ${from}: ${describePatterns(high)}. The line is still routed; a session blocks only critical patterns.`
    : `NOTICE: Minor suspicious pattern detected in ${from}: ${describePatterns(result.patterns)}. The line is still routed.`;
  return { blocked: false, message };
}

/**
 * What a session keeps between turns: the output and findings of the last
 * command, so a follow-up such as "fix the first one" can name the finding it
 * refers to, and the lines typed so far, from which the skill level that sets
 * how much the session says is inferred. startSession creates one per
 * session; handleInput without one handles each line on its own.
 */
export interface SessionMemory {
  context: SessionManager;
  skill: SkillAdapter;
}

export function createSessionMemory(): SessionMemory {
  return { context: new SessionManager(), skill: new SkillAdapter() };
}

// A message in three lengths; the skill level picks one. Without a memory the
// session has no level and says the middle one.
function say(memory: SessionMemory | undefined, full: string, concise: string, terse: string): string {
  return memory ? memory.skill.formatResponse(full, concise, terse) : concise;
}

const WELCOME = `
  NanoMind: interactive assistant for AI security tools
  Type a question or command. Examples:
    "scan this project"
    "why is my agent level 2"
    "fix the credential issue"
  Type "teach" for a 7-step guided walkthrough.
  Type "exit" or Ctrl+C to quit.
`;

type ReadLine = (prompt: string) => Promise<string | null>;
type Ask = (question: string) => Promise<string>;

/**
 * Read the lines of `rl` one at a time: print the prompt, then return the next
 * line, or null once the input has ended. A session reads its requests and
 * teach mode its answers through one reader, so the answer to a question is
 * the line after it, also when the lines are piped in at once. A session reads
 * its next request only after the last one was handled, so a follow-up such as
 * "fix the first one" is read against what the line before it printed.
 */
function lineReader(rl: readline.Interface): ReadLine {
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  return async (prompt) => {
    // Lines that arrived before the input ended are still read after it ends,
    // when rl.prompt() would throw, so the prompt is written out directly.
    if (closed) {
      process.stdout.write(prompt);
    } else {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    const next = await lines.next();
    return next.done ? null : next.value;
  };
}

function askWith(read: ReadLine): Ask {
  return async (question) => {
    const answer = await read(question);
    if (answer === null) {
      throw new Error('The input ended before the question was answered.');
    }
    return answer.trim();
  };
}

// Teach mode's steps run HackMyAgent commands (detect, secure): through hma
// when the session runs hma, and through hackmyagent otherwise.
function teachCli(session: NanoMindSession): string {
  return (session.targetCli ?? session.cliName) === 'hma' ? 'hma' : STANDALONE_TARGET;
}

/**
 * Run teach mode for a session: its commands go through session.onCommand,
 * and `ask` answers its questions.
 */
async function startTeachMode(session: NanoMindSession, ask: Ask): Promise<void> {
  await runTeachMode({
    cliName: teachCli(session),
    projectDir: path.resolve(session.projectDir ?? process.cwd()),
    registryUrl: session.registryUrl,
    onCommand: session.onCommand,
    onPrompt: ask,
    onPrint: (msg) => console.log(msg),
  });
}

/**
 * Start an interactive NanoMind session.
 */
export async function startSession(session: NanoMindSession): Promise<void> {
  const atcHandler = new ATCIntentHandler({ registryUrl: session.registryUrl });
  const inputSource = detectInputSource();
  const memory = createSessionMemory();

  console.log(WELCOME);
  console.log(`  Connected to: ${session.cliName} v${session.cliVersion}\n`);
  if (session.noGuard) {
    console.error(`  ${NO_GUARD_WARNING}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const read = lineReader(rl);
  const ask = askWith(read);
  const prompt = `${session.cliName} > `;

  // Each line is handled before the next one is read. The session ends when
  // the input does, or on "exit" or "quit".
  void (async () => {
    for (let line = await read(prompt); line !== null; line = await read(prompt)) {
      const input = line.trim();
      if (!input) continue;
      if (input === 'exit' || input === 'quit') break;

      // Guard: screen piped and file input for injection
      const screened = screenLine(input, inputSource, session.noGuard);
      if (screened) {
        console.log(`\n  ${screened.message}\n`);
        if (screened.blocked) continue;
      }

      try {
        if (input.toLowerCase() === TEACH_COMMAND) {
          await startTeachMode(session, ask);
        } else {
          await handleInput(input, session, atcHandler, memory);
        }
      } catch (err) {
        console.log(`\n  Error: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
      }
    }

    rl.close();
    console.log('\n  Goodbye.\n');
    process.exit(0);
  })();
}

/**
 * Handle one line of session input. With `memory`, a reference in the line
 * ("the first one", "that finding", "my agent") is first replaced by what the
 * memory holds for it, and the session prints how it read the line. What the
 * line's command prints is then recorded for the next reference, and the line
 * itself for the skill level. Without `memory`, the line is handled on its own.
 */
export async function handleInput(
  input: string,
  session: NanoMindSession,
  atcHandler: ATCIntentHandler,
  memory?: SessionMemory,
): Promise<void> {
  const request = memory ? memory.context.resolveReference(input) : input;
  if (request !== input) {
    console.log(`\n  > Reading "${input}" as "${request}"`);
  }
  let answered = false;
  try {
    answered = await route(request, session, atcHandler, memory);
  } finally {
    memory?.skill.record(input, answered);
  }
}

/**
 * Route a request and print the result. Returns true when the request was
 * answered: a command ran, an artifact was generated or a trust question was
 * answered. A request with no route, or whose command failed, returns false.
 */
async function route(
  request: string,
  session: NanoMindSession,
  atcHandler: ATCIntentHandler,
  memory?: SessionMemory,
): Promise<boolean> {
  const classification = classifyIntent(request);

  // ATC intents — answered here via ATCIntentHandler. The answer is recorded
  // so that "my agent" afterwards names the agent it was about.
  if (isATCIntent(classification.intent)) {
    const answer = await handleATCIntent(classification, atcHandler);
    console.log(answer);
    memory?.context.update(request, answer);
    return true;
  }

  // GENERATE — print the artifact from the local templates; no CLI command runs
  if (classification.intent === 'GENERATE') {
    handleGenerate(request, session);
    return true;
  }

  // Map to CLI command
  const mapping = mapToCommand(classification, session.targetCli ?? session.cliName);

  if (!mapping) {
    if (classification.intent === 'UNKNOWN') {
      console.log(say(
        memory,
        `\n  I'm not sure how to help with that. Requests are matched against fixed patterns, so name the action, for example "scan this project", "fix the credential issue" or "what is the trust level of <agent-id>". Try "help" for examples.\n`,
        `\n  I'm not sure how to help with that. Try "help" for examples.\n`,
        `\n  No matching request. Try "help".\n`,
      ));
    } else {
      console.log(`\n  ${session.cliName} has no command for ${classification.intent} requests. Try "help" for examples.\n`);
    }
    return false;
  }

  console.log(`\n  > ${mapping.description}`);
  console.log(`  > Running: ${mapping.command} ${mapping.args.join(' ')}\n`);

  let output: string;
  try {
    output = await session.onCommand(mapping.command, mapping.args);
  } catch (err) {
    console.log(`  Command failed: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    return false;
  }
  if (output) {
    console.log(output);
  }

  const findings = memory?.context.update([mapping.command, ...mapping.args].join(' '), output ?? '') ?? [];
  if (findings.length > 0) {
    const note = followUpNote(memory, findings[0]);
    if (note) console.log(`\n  ${note}\n`);
  }
  return true;
}

// What the session says, once a command has printed findings, about the
// references it now resolves. An expert is told nothing.
function followUpNote(memory: SessionMemory | undefined, first: Finding): string {
  return say(
    memory,
    `Follow-ups: "the first one" and "that finding" now mean ${first.id}, the first finding above, until a later command prints findings. The session prints how it reads such a line.`,
    `"the first one" and "that finding" now mean ${first.id}.`,
    '',
  );
}

function handleGenerate(input: string, session: NanoMindSession): void {
  const projectDir = path.resolve(session.projectDir ?? process.cwd());
  const named = artifactTypeFromInput(input);
  const type = named ?? detectArtifactType(projectDir);
  const artifact = generateArtifact(type, {
    projectName: path.basename(projectDir),
    projectType: 'mcp_server',
    language: 'typescript',
    registryUrl: session.registryUrl,
  });

  console.log(`\n  > Generating ${type} config`);
  if (!named) {
    console.log('  > No type named, so the type comes from the files in this directory.');
  }
  console.log(`\n${artifact}`);
  const others = listArtifactTypes().filter((t) => t !== type);
  console.log('  Save this to your CI configuration.');
  console.log(`  For another type, ask "generate a ${others[0]} config". Types: ${others.join(', ')}\n`);
}

/**
 * Answer an ATC request. Returns the text to print, so the caller can also
 * record it.
 */
async function handleATCIntent(
  classification: IntentClassification,
  atcHandler: ATCIntentHandler,
): Promise<string> {
  const agentId = classification.entities.agentId || classification.entities.packageName || '';

  switch (classification.intent) {
    case 'TRUST_QUERY': {
      if (!agentId) {
        return '\n  Please specify an agent: "what is the trust level of <agent-id>"\n';
      }
      const summary = await atcHandler.getTrustLevel(agentId);
      if (!summary) {
        return `\n  No ATC found for agent "${agentId}". The agent may not be registered yet.\n`;
      }
      return [
        `\n  Agent: ${summary.agentId}`,
        `  Trust Level: ${summary.trustLevel}`,
        `  Trust Score: ${summary.trustScore}`,
        `  Version: ${summary.version}`,
        `  Signatures: ${summary.signatureCount}`,
        `  Expires: ${summary.expiresAt}\n`,
      ].join('\n');
    }

    case 'ATC_STATUS': {
      const explanation = await atcHandler.explainTrustLevel(agentId || 'current');
      return `\n${explanation.summary}\n`;
    }

    case 'ATTEST':
      return `
  To add trust attestation to your CI pipeline, add this to your GitHub Actions workflow:

  - uses: opena2a-org/opena2a-registry/action@main
    with:
      api-key: \${{ secrets.OPENA2A_API_KEY }}
      package-name: your-package-name
      package-type: mcp_server
      version: \${{ github.ref_name }}
      publisher: your-org

  This issues an Agent Trust Credential (ATC) on every successful build.
`;

    default:
      return `\n  ATC intent "${classification.intent}" is not yet implemented.\n`;
  }
}

const DEFAULT_REGISTRY_URL = 'https://api.oa2a.org';

// The scanner a standalone `nanomind` session runs, and how to get it.
const STANDALONE_TARGET = 'hackmyagent';
const INSTALL_COMMANDS: Record<string, string> = {
  hackmyagent: 'npm install -g hackmyagent',
};

const COMMAND_TIMEOUT_SECONDS = 120;
const COMMAND_MAX_OUTPUT_MB = 16;

// A command name, subcommand, flag, path or identifier. Anything a shell
// would interpret is refused, because Windows needs a shell (see runCommand).
const SAFE_TOKEN = /^[\w@+=:,.\/\\-]+$/;

/**
 * Run a mapped command (for example "hackmyagent secure" with ["."]) and
 * return what it printed. A non-zero exit is not an error: scanners exit
 * non-zero when they report findings.
 */
export function runCommand(command: string, args: string[] = []): string {
  const tokens = [...command.trim().split(/\s+/), ...args];
  const unsafe = tokens.find((token) => !SAFE_TOKEN.test(token));
  if (unsafe !== undefined) {
    throw new Error(`Refusing to run a command that contains "${unsafe}"`);
  }

  const [bin, ...rest] = tokens;
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_SECONDS * 1000,
    maxBuffer: COMMAND_MAX_OUTPUT_MB * 1024 * 1024,
  };
  // npm installs command shims as .cmd files on Windows, and only a shell can
  // start those. Every token passed SAFE_TOKEN above.
  const result = process.platform === 'win32'
    ? spawnSync(tokens.join(' '), { ...options, shell: true })
    : spawnSync(bin, rest, options);

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const install = INSTALL_COMMANDS[bin];
      throw new Error(`${bin} was not found on PATH.${install ? ` Install it with: ${install}` : ''}`);
    }
    if (code === 'ETIMEDOUT') {
      throw new Error(`${bin} did not finish within ${COMMAND_TIMEOUT_SECONDS} seconds`);
    }
    if (code === 'ENOBUFS') {
      throw new Error(`${bin} printed more than ${COMMAND_MAX_OUTPUT_MB} MB of output`);
    }
    throw result.error;
  }

  const output = result.stdout || result.stderr;
  if (!output && result.status !== 0) {
    const how = result.signal ? `was stopped by ${result.signal}` : `exited with status ${result.status}`;
    throw new Error(`${bin} ${how} and printed nothing`);
  }
  return output;
}

const USAGE = `nanomind: interactive assistant for AI security tools

Usage:
  nanomind                 Start the interactive session
  nanomind --no-guard      Start it without screening piped or file input
                           for prompt injection (not recommended)
  nanomind teach           Run teach mode: a 7-step guided walkthrough that
                           scans this directory with ${STANDALONE_TARGET}
  nanomind --help, -h      Show this help
  nanomind --version, -v   Print the version

In the session, type a request in plain language, for example
"scan this project". Requests are matched against fixed patterns
(no model is involved).

Requests the session acts on:
  scan, fix, status, help    Runs ${STANDALONE_TARGET} and prints the command first.
                             ${STANDALONE_TARGET} must be on PATH:
                             ${INSTALL_COMMANDS[STANDALONE_TARGET]}
  trust level of an agent    Looks the agent up in the OpenA2A registry
  build attestation          Prints a CI workflow step
  teach                      Runs teach mode, as nanomind teach does

Teach mode asks before it runs ${STANDALONE_TARGET} secure . --fix. NanoMind keeps
no copy of the files the fix changes: undoing it relies on ${STANDALONE_TARGET}.

Environment:
  OPENA2A_REGISTRY_URL   Registry for trust lookups (default: ${DEFAULT_REGISTRY_URL})

Type "exit" or press Ctrl+C to leave the session.`;

function packageVersion(): string {
  return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version;
}

/**
 * `nanomind teach`: teach mode on its own, with each question answered by the
 * next line of standard input.
 */
async function runTeachCommand(session: NanoMindSession): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await startTeachMode(session, askWith(lineReader(rl)));
  } finally {
    rl.close();
  }
}

/**
 * The `nanomind` command: --help, --version, teach mode, or the interactive
 * session, screened unless --no-guard is given.
 */
export async function runCli(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(packageVersion());
    return;
  }
  if (argv.includes(TEACH_COMMAND) && argv.length > 1) {
    console.error(`nanomind ${TEACH_COMMAND} takes no other arguments\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const unknown = argv.find((arg) => arg !== NO_GUARD_FLAG && arg !== TEACH_COMMAND);
  if (unknown !== undefined) {
    const kind = unknown.startsWith('-') ? 'option' : 'command';
    console.error(`Unknown ${kind}: ${unknown}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const session: NanoMindSession = {
    cliName: 'nanomind',
    cliVersion: packageVersion(),
    targetCli: STANDALONE_TARGET,
    registryUrl: process.env.OPENA2A_REGISTRY_URL || DEFAULT_REGISTRY_URL,
    onCommand: async (cmd: string, args: string[]) => runCommand(cmd, args),
    noGuard: hasNoGuardFlag(argv),
  };
  if (argv[0] === TEACH_COMMAND) {
    await runTeachCommand(session);
    return;
  }
  await startSession(session);
}

// Start the command only when this file is the program that was run. Adapters
// import it for startSession, and that must stay free of side effects.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export default startSession;
