/**
 * NanoMind OpenA2A CLI Adapter
 *
 * The cross-product router. One prompt reaches HMA scans, agent detection,
 * Secretless credential checks and ATC trust queries; the routes are the
 * opena2a table in @nanomind/router.
 *
 * Usage in opena2a CLI's router.ts:
 *
 *   import { launchOpena2aInteractive } from '@nanomind/opena2a-adapter';
 *
 *   const interactive = await launchOpena2aInteractive(process.argv.slice(2));
 *   if (!interactive) {
 *     // proceed with normal command parsing
 *   }
 *
 * It resolves as soon as the prompt is shown, and the session exits the
 * process itself when it ends, so the caller does not call process.exit.
 */

import { execSync } from 'node:child_process';
import { startSession, type NanoMindSession } from '@nanomind/cli';

export function shouldLaunchNanoMind(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.includes('--no-smart')) return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  if (args.length > 0) return false;
  return true;
}

export async function launchNanoMind(): Promise<void> {
  let cliVersion = 'unknown';
  try {
    const pkg = require('opena2a-cli/package.json');
    cliVersion = pkg.version;
  } catch {}

  const session: NanoMindSession = {
    cliName: 'opena2a',
    cliVersion,
    registryUrl: process.env.OPENA2A_REGISTRY_URL || 'https://api.oa2a.org',
    onCommand: async (cmd: string, args: string[]): Promise<string> => {
      // Route to appropriate tool based on command prefix
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
 * Launch NanoMind interactive mode for the arguments opena2a was run with,
 * without the node and script paths. With none, it starts the session and
 * resolves true once the prompt is shown. Otherwise it resolves false and
 * starts nothing.
 */
export async function launchOpena2aInteractive(args: string[]): Promise<boolean> {
  // shouldLaunchNanoMind reads a full argv, node and script path first
  if (!shouldLaunchNanoMind(['node', 'opena2a', ...args])) return false;
  await launchNanoMind();
  return true;
}

export function getCommandManifest() {
  return {
    commands: [
      { name: 'opena2a scan', description: 'Run HMA security scan', aliases: ['hma secure'] },
      { name: 'opena2a trust', description: 'Query agent trust level' },
      { name: 'opena2a attest', description: 'Generate build attestation config' },
      { name: 'opena2a detect', description: 'Detect AI agents in project' },
      { name: 'opena2a identity', description: 'Manage agent identity' },
      { name: 'opena2a secretless', description: 'Check credential exposure' },
      { name: 'opena2a review', description: 'Review project security' },
      { name: 'opena2a config', description: 'Manage OpenA2A configuration' },
    ],
  };
}
