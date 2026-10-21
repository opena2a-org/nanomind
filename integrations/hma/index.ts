/**
 * NanoMind HMA Adapter
 *
 * Integrates NanoMind with HackMyAgent CLI.
 * When `hma` is invoked with no args, this adapter launches NanoMind
 * interactive mode instead of the help screen. `hma --no-guard` launches it
 * with input screening off, and the session prints a warning to stderr.
 *
 * Usage in HMA's cli.ts:
 *
 *   import { launchHmaInteractive } from '@nanomind/hma-adapter';
 *
 *   const interactive = await launchHmaInteractive(process.argv.slice(2));
 *   if (!interactive) {
 *     // proceed with normal commander parsing
 *   }
 *
 * It resolves as soon as the prompt is shown, and the session exits the
 * process itself when it ends, so the caller does not call process.exit.
 */

import { execSync } from 'node:child_process';
import { startSession, type NanoMindSession } from '@nanomind/cli';

/**
 * The launch flag that turns off input screening for one session. It is
 * matched here, not with hasNoGuardFlag from @nanomind/cli: the peer
 * dependency range admits the published @nanomind/cli 0.1.2, which does not
 * export it.
 */
const NO_GUARD_FLAG = '--no-guard';

/**
 * Check if NanoMind should launch (no args or --no-guard alone, no --help,
 * no --no-smart).
 */
export function shouldLaunchNanoMind(argv: string[]): boolean {
  const args = argv.slice(2); // remove node and script path

  // --no-smart always bypasses NanoMind
  if (args.includes('--no-smart')) return false;

  // --help always goes to traditional help
  if (args.includes('--help') || args.includes('-h')) return false;

  // If there are actual commands/subcommands, don't intercept. --no-guard
  // only turns off input screening for the session.
  if (args.some((arg) => arg !== NO_GUARD_FLAG)) return false;

  return true;
}

/**
 * Launch NanoMind interactive session for HMA. With `noGuard`, the session
 * starts with input screening off and prints a warning to stderr.
 */
export async function launchNanoMind({ noGuard = false }: { noGuard?: boolean } = {}): Promise<void> {
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
    noGuard,
  };

  await startSession(session);
}

/**
 * Launch NanoMind interactive mode for the arguments hma was run with, without
 * the node and script paths. With none, it starts the session and resolves
 * true once the prompt is shown. With --no-guard alone, it does the same with
 * input screening off. Otherwise it resolves false and starts nothing.
 */
export async function launchHmaInteractive(args: string[]): Promise<boolean> {
  // shouldLaunchNanoMind reads a full argv, node and script path first
  if (!shouldLaunchNanoMind(['node', 'hma', ...args])) return false;
  await launchNanoMind({ noGuard: args.includes(NO_GUARD_FLAG) });
  return true;
}

/**
 * NanoMind CLI Adapter interface implementation for HMA.
 */
export function getCommandManifest() {
  return {
    commands: [
      { name: 'secure', description: 'Run security scan', aliases: ['scan'], args: ['[directory]'], flags: ['--fix', '--ci', '--format'] },
      { name: 'detect', description: 'Detect AI agents in project', args: ['[directory]'] },
      { name: 'check', description: 'Check a package', args: ['<package>'] },
      { name: 'explain', description: 'Explain a security finding', args: ['<findingId>'] },
      { name: 'attack', description: 'Run attack simulation', args: ['[directory]'], flags: ['--scenario'] },
      { name: 'init-mcp', description: 'Initialize MCP security', args: [] },
      { name: 'oasb', description: 'OASB compliance check', args: ['[directory]'] },
    ],
  };
}
