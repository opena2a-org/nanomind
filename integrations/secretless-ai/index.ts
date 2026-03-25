/**
 * NanoMind secretless-ai Adapter
 *
 * When `secretless-ai` runs with no args, launches NanoMind interactive mode.
 * SECRETS_EXPOSE intent routes to secretless-ai diagnose workflow.
 * EXPOSURE intent shows how credential exposure affects ARS.
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
  let version = 'unknown';
  try {
    const pkg = require('secretless-ai/package.json');
    version = pkg.version;
  } catch {}

  const session: NanoMindSession = {
    cliName: 'secretless-ai',
    cliVersion: version,
    registryUrl: process.env.OPENA2A_REGISTRY_URL || 'https://api.oa2a.org',
    onCommand: async (cmd: string, args: string[]): Promise<string> => {
      const fullCmd = [cmd, ...args].join(' ');
      try {
        return execSync(fullCmd, { encoding: 'utf-8', timeout: 120000, cwd: process.cwd() });
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
      { name: 'verify', description: 'Verify secretless configuration', aliases: ['check'] },
      { name: 'diagnose', description: 'Diagnose credential exposure' },
      { name: 'scan', description: 'Scan for exposed secrets' },
      { name: 'protect', description: 'Apply secretless protection' },
    ],
  };
}
