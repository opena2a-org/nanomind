#!/usr/bin/env node
/**
 * @nanomind/cli — Unified NanoMind CLI Entry Point
 *
 * Run directly as the `nanomind` command, it starts the interactive NanoMind
 * prompt, or answers --help and --version.
 *
 * Imported, it is the entry point that HMA, secretless-ai, and opena2a
 * adapters delegate to when the user runs their CLI with no arguments.
 *
 * Requests are routed by pattern matching (@nanomind/router). No model is
 * involved.
 */

import * as readline from 'node:readline';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyIntent, mapToCommand, isATCIntent, type IntentClassification } from '@nanomind/router';
import { ATCIntentHandler } from '@nanomind/atc';
import { screenInput, detectInputSource } from '@nanomind/guard';

export interface NanoMindSession {
  cliName: string;
  cliVersion: string;
  registryUrl: string;
  onCommand: (cmd: string, args: string[]) => Promise<string>;
  /** CLI that scan, fix, status and help requests run. Defaults to cliName. */
  targetCli?: string;
}

const WELCOME = `
  NanoMind: interactive assistant for AI security tools
  Type a question or command. Examples:
    "scan this project"
    "why is my agent level 2"
    "fix the credential issue"
  Type "exit" or Ctrl+C to quit.
`;

/**
 * Start an interactive NanoMind session.
 */
export async function startSession(session: NanoMindSession): Promise<void> {
  const atcHandler = new ATCIntentHandler({ registryUrl: session.registryUrl });
  const inputSource = detectInputSource();

  console.log(WELCOME);
  console.log(`  Connected to: ${session.cliName} v${session.cliVersion}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${session.cliName} > `,
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === 'exit' || input === 'quit') {
      rl.close();
      return;
    }

    // Guard: screen piped input for injection
    if (inputSource !== 'direct') {
      const guardResult = screenInput(input, inputSource);
      if (!guardResult.safe) {
        console.log(`\n  ${guardResult.recommendation}\n`);
        rl.prompt();
        return;
      }
    }

    try {
      await handleInput(input, session, atcHandler);
    } catch (err) {
      console.log(`\n  Error: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n  Goodbye.\n');
    process.exit(0);
  });
}

async function handleInput(
  input: string,
  session: NanoMindSession,
  atcHandler: ATCIntentHandler,
): Promise<void> {
  const classification = classifyIntent(input);

  // ATC intents — handle directly via ATCIntentHandler
  if (isATCIntent(classification.intent)) {
    await handleATCIntent(classification, atcHandler);
    return;
  }

  // Map to CLI command
  const mapping = mapToCommand(classification, session.targetCli ?? session.cliName);

  if (!mapping) {
    if (classification.intent === 'UNKNOWN') {
      console.log(`\n  I'm not sure how to help with that. Try "help" for examples.\n`);
    } else {
      console.log(`\n  ${session.cliName} has no command for ${classification.intent} requests. Try "help" for examples.\n`);
    }
    return;
  }

  console.log(`\n  > ${mapping.description}`);
  console.log(`  > Running: ${mapping.command} ${mapping.args.join(' ')}\n`);

  try {
    const output = await session.onCommand(mapping.command, mapping.args);
    if (output) {
      console.log(output);
    }
  } catch (err) {
    console.log(`  Command failed: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
  }
}

async function handleATCIntent(
  classification: IntentClassification,
  atcHandler: ATCIntentHandler,
): Promise<void> {
  const agentId = classification.entities.agentId || classification.entities.packageName || '';

  switch (classification.intent) {
    case 'TRUST_QUERY': {
      if (!agentId) {
        console.log('\n  Please specify an agent: "what is the trust level of <agent-id>"\n');
        return;
      }
      const summary = await atcHandler.getTrustLevel(agentId);
      if (!summary) {
        console.log(`\n  No ATC found for agent "${agentId}". The agent may not be registered yet.\n`);
        return;
      }
      console.log(`\n  Agent: ${summary.agentId}`);
      console.log(`  Trust Level: ${summary.trustLevel}`);
      console.log(`  Trust Score: ${summary.trustScore}`);
      console.log(`  Version: ${summary.version}`);
      console.log(`  Signatures: ${summary.signatureCount}`);
      console.log(`  Expires: ${summary.expiresAt}\n`);
      return;
    }

    case 'ATC_STATUS': {
      const explanation = await atcHandler.explainTrustLevel(agentId || 'current');
      console.log(`\n${explanation.summary}\n`);
      return;
    }

    case 'ATTEST': {
      console.log(`
  To add trust attestation to your CI pipeline, add this to your GitHub Actions workflow:

  - uses: opena2a-org/opena2a-registry/action@main
    with:
      api-key: \${{ secrets.OPENA2A_API_KEY }}
      package-name: your-package-name
      package-type: mcp_server
      version: \${{ github.ref_name }}
      publisher: your-org

  This issues an Agent Trust Credential (ATC) on every successful build.
`);
      return;
    }

    default:
      console.log(`\n  ATC intent "${classification.intent}" is not yet implemented.\n`);
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

Environment:
  OPENA2A_REGISTRY_URL   Registry for trust lookups (default: ${DEFAULT_REGISTRY_URL})

Type "exit" or press Ctrl+C to leave the session.`;

function packageVersion(): string {
  return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version;
}

/**
 * The `nanomind` command: --help, --version, or the interactive session.
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
  if (argv.length > 0) {
    const kind = argv[0].startsWith('-') ? 'option' : 'command';
    console.error(`Unknown ${kind}: ${argv[0]}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  await startSession({
    cliName: 'nanomind',
    cliVersion: packageVersion(),
    targetCli: STANDALONE_TARGET,
    registryUrl: process.env.OPENA2A_REGISTRY_URL || DEFAULT_REGISTRY_URL,
    onCommand: async (cmd: string, args: string[]) => runCommand(cmd, args),
  });
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
