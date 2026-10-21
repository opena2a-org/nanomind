/**
 * NanoMind secretless-ai Adapter
 *
 * When `secretless-ai` runs with no args, launches NanoMind interactive mode.
 * `secretless-ai --no-guard` launches it with input screening off, and the
 * session prints a warning to stderr.
 * SECRETS_EXPOSE intent routes to secretless-ai diagnose; the routes are
 * the secretless-ai table in @nanomind/router.
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

export function shouldLaunchNanoMind(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.includes('--no-smart')) return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  // --no-guard only turns off input screening for the session
  if (args.some((arg) => arg !== NO_GUARD_FLAG)) return false;
  return true;
}

/**
 * With `noGuard`, the session starts with input screening off and prints a
 * warning to stderr.
 */
export async function launchNanoMind({ noGuard = false }: { noGuard?: boolean } = {}): Promise<void> {
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
    noGuard,
  };

  await startSession(session);
}

/**
 * Launch NanoMind interactive mode for the arguments secretless-ai was run
 * with, without the node and script paths. With none, it starts the session
 * and resolves true once the prompt is shown. With --no-guard alone, it does
 * the same with input screening off. Otherwise it resolves false and starts
 * nothing.
 */
export async function launchSecretlessInteractive(args: string[]): Promise<boolean> {
  // shouldLaunchNanoMind reads a full argv, node and script path first
  if (!shouldLaunchNanoMind(['node', 'secretless-ai', ...args])) return false;
  await launchNanoMind({ noGuard: args.includes(NO_GUARD_FLAG) });
  return true;
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
