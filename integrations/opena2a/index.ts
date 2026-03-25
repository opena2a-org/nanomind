/**
 * NanoMind OpenA2A CLI Adapter
 *
 * The primary cross-product router. Users can ask about HMA, AIM,
 * Secretless, OASB, ATC from a single prompt.
 *
 * Usage in opena2a CLI's router.ts:
 *
 *   import { shouldLaunchNanoMind, launchNanoMind } from '@nanomind/opena2a-adapter';
 *
 *   if (shouldLaunchNanoMind(process.argv)) {
 *     await launchNanoMind();
 *     process.exit(0);
 *   }
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

export function getCommandManifest() {
  return {
    commands: [
      { name: 'opena2a scan', description: 'Run HMA security scan', aliases: ['hma secure'] },
      { name: 'opena2a trust', description: 'Query agent trust level' },
      { name: 'opena2a attest', description: 'Generate build attestation config' },
      { name: 'opena2a detect', description: 'Detect AI agents in project' },
      { name: 'opena2a identity', description: 'Manage agent identity' },
      { name: 'opena2a secretless', description: 'Check credential exposure' },
    ],
  };
}
