#!/usr/bin/env node
/**
 * @nanomind/cli — Unified NanoMind CLI Entry Point
 *
 * When invoked with no args, launches the interactive NanoMind prompt.
 * When invoked with --no-smart, falls through to the underlying CLI tool.
 *
 * This is the entry point that HMA, secretless-ai, and opena2a adapters
 * delegate to when the user runs their CLI with no arguments.
 */

import * as readline from 'node:readline';
import { classifyIntent, mapToCommand, isATCIntent, type IntentClassification } from '@nanomind/router';
import { ATCIntentHandler } from '@nanomind/atc';
import { screenInput, detectInputSource } from '@nanomind/guard';

export interface NanoMindSession {
  cliName: string;
  cliVersion: string;
  registryUrl: string;
  onCommand: (cmd: string, args: string[]) => Promise<string>;
}

const WELCOME = `
  NanoMind — AI Security Assistant
  Type a question or command. Examples:
    "scan this project"
    "why is my agent level 2"
    "fix the credential issue"
    "generate a github action for trust"
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
  const mapping = mapToCommand(classification, session.cliName);

  if (!mapping) {
    console.log(`\n  I'm not sure how to help with that. Try "help" for examples.\n`);
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

export default startSession;
