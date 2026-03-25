/**
 * NanoMind HMA Adapter
 *
 * Integrates NanoMind with HackMyAgent CLI.
 * When `hma` is invoked with no args, this adapter launches NanoMind
 * interactive mode instead of the help screen.
 *
 * Usage in HMA's cli.ts:
 *
 *   import { shouldLaunchNanoMind, launchNanoMind } from '@nanomind/hma-adapter';
 *
 *   if (shouldLaunchNanoMind(process.argv)) {
 *     await launchNanoMind();
 *     process.exit(0);
 *   }
 *   // else: proceed with normal commander parsing
 */

import { execSync } from 'node:child_process';
import { startSession, type NanoMindSession } from '@nanomind/cli';

/**
 * Check if NanoMind should launch (no args, no --help, no --no-smart).
 */
export function shouldLaunchNanoMind(argv: string[]): boolean {
  const args = argv.slice(2); // remove node and script path

  // --no-smart always bypasses NanoMind
  if (args.includes('--no-smart')) return false;

  // --help always goes to traditional help
  if (args.includes('--help') || args.includes('-h')) return false;

  // If there are actual commands/subcommands, don't intercept
  if (args.length > 0) return false;

  return true;
}

/**
 * Launch NanoMind interactive session for HMA.
 */
export async function launchNanoMind(): Promise<void> {
  // Detect HMA version
  let hmaVersion = 'unknown';
  try {
    const pkg = require('hackmyagent/package.json');
    hmaVersion = pkg.version;
  } catch {
    try {
      hmaVersion = execSync('npx hackmyagent --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    } catch {
      // fallback
    }
  }

  const session: NanoMindSession = {
    cliName: 'hma',
    cliVersion: hmaVersion,
    registryUrl: process.env.OPENA2A_REGISTRY_URL || 'https://api.oa2a.org',
    onCommand: async (cmd: string, args: string[]): Promise<string> => {
      // Route commands to HMA
      const fullCmd = [cmd, ...args].join(' ');
      try {
        return execSync(fullCmd, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120000,
          cwd: process.cwd(),
        });
      } catch (err: any) {
        return err.stdout || err.message;
      }
    },
  };

  await startSession(session);
}

/**
 * NanoMind CLI Adapter interface implementation for HMA.
 */
export function getCommandManifest() {
  return {
    commands: [
      { name: 'secure', description: 'Run security scan', aliases: ['scan'], args: ['[directory]'], flags: ['--fix', '--ci', '--format'] },
      { name: 'attack', description: 'Run attack simulation', args: ['[directory]'], flags: ['--scenario'] },
      { name: 'init-mcp', description: 'Initialize MCP security', args: [] },
      { name: 'oasb', description: 'OASB compliance check', args: ['[directory]'] },
    ],
  };
}
