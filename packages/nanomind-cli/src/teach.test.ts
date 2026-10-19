import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTeachMode } from './teach.ts';

// Step 5 looks the project up in the registry. Nothing listens on this
// address, so the lookup fails at once and no test reaches a real registry.
const REGISTRY = 'http://127.0.0.1:9';
// A scan finding, so that teach mode offers its auto-fix.
const FINDING = '[CRED-001] Hardcoded API key (critical)';
const AUTO_FIX_QUESTION = '  Apply auto-fix? (y/n): ';

const dirs: string[] = [];

function projectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-teach-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Runs startSession in a child process in a new project directory, with
// `input` piped to it. The session's onCommand prints "RAN <command>" instead
// of running anything, and answers a scan run with --ci with FINDING.
function runSession(cliName: string, input: string): string {
  const cli = pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href;
  const script = `
    import { startSession } from ${JSON.stringify(cli)};
    await startSession({
      cliName: ${JSON.stringify(cliName)},
      cliVersion: '0.0.0',
      registryUrl: ${JSON.stringify(REGISTRY)},
      onCommand: async (cmd, args) => {
        console.log('RAN ' + [cmd, ...args].join(' '));
        return args.includes('--ci') ? ${JSON.stringify(FINDING)} : '';
      },
    });
  `;
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { cwd: projectDir(), input, encoding: 'utf-8', timeout: 30000 },
  );
  assert.strictEqual(child.status, 0, child.stderr);
  return child.stdout;
}

const commandsRun = (stdout: string) => stdout.split('\n').filter((line) => line.startsWith('RAN '));

describe('teach in a session', () => {
  it('runs the seven steps, answers their questions with the lines after it, then routes requests again', () => {
    const stdout = runSession('hma', 'teach\ny\nn\nn\nscan this project\n');
    for (let step = 1; step <= 7; step++) {
      assert.ok(stdout.includes(`Step ${step}/7`), stdout);
    }
    assert.ok(stdout.includes('=== Teach Mode Complete ==='), stdout);
    assert.deepStrictEqual(commandsRun(stdout), [
      'RAN hma detect .',
      'RAN hma secure . --ci',
      'RAN hma secure . --fix',
      'RAN hma secure .',
    ]);
    // The answers were not routed as requests, and "n" generated no config.
    assert.ok(!stdout.includes("I'm not sure how to help"), stdout);
    assert.ok(!stdout.includes('name: Security Scan'), stdout);
    assert.ok(!stdout.includes('opena2a-registry/action'), stdout);
  });

  it('runs hackmyagent in a session for a CLI that is not HackMyAgent', () => {
    const stdout = runSession('secretless-ai', 'teach\nn\nn\nn\n');
    assert.deepStrictEqual(commandsRun(stdout), ['RAN hackmyagent detect .', 'RAN hackmyagent secure . --ci']);
    assert.ok(stdout.includes('=== Teach Mode Complete ==='), stdout);
  });

  it('stops at a question the input ends before answering, and ends the session', () => {
    const stdout = runSession('hma', 'teach\n');
    assert.ok(stdout.includes(AUTO_FIX_QUESTION), stdout);
    assert.ok(stdout.includes('Error: The input ended before the question was answered.'), stdout);
    assert.ok(!stdout.includes('Step 4/7'), stdout);
    assert.ok(stdout.includes('Goodbye.'), stdout);
    assert.deepStrictEqual(commandsRun(stdout), ['RAN hma detect .', 'RAN hma secure . --ci']);
  });
});

describe('teach mode auto-fix step', () => {
  it('says before asking that NanoMind keeps no copy of the files the fix changes, and prints what the fix printed', async () => {
    const printed: string[] = [];
    const commands: string[] = [];
    await runTeachMode({
      cliName: 'hackmyagent',
      projectDir: process.cwd(),
      registryUrl: REGISTRY,
      onCommand: async (cmd, args) => {
        commands.push([cmd, ...args].join(' '));
        if (args.includes('--ci')) return FINDING;
        if (args.includes('--fix')) return 'fake fix output';
        return '';
      },
      onPrompt: async (question) => {
        printed.push(question);
        return question === AUTO_FIX_QUESTION ? 'y' : 'n';
      },
      onPrint: (msg) => printed.push(msg),
    });

    const transcript = printed.join('\n');
    const question = printed.indexOf(AUTO_FIX_QUESTION);
    const note = printed.findIndex((line) => line.includes('NanoMind keeps no copy of them'));
    assert.ok(note !== -1 && note < question, transcript);
    assert.ok(printed[note].includes("undoing the fix relies on hackmyagent's own backup"), transcript);
    assert.ok(printed.includes('  Running: hackmyagent secure . --fix'), transcript);
    assert.ok(printed.includes('fake fix output'), transcript);
    assert.ok(!transcript.includes('will be backed up'), transcript);
    assert.deepStrictEqual(commands, [
      'hackmyagent detect .',
      'hackmyagent secure . --ci',
      'hackmyagent secure . --fix',
    ]);
  });
});

describe('teach mode registry step', () => {
  // Runs teach mode in a new project directory, answering no to each question,
  // and checks that step 5 printed the failed lookup that `reason` ends, not
  // an unregistered agent, and that the walkthrough went on to the end.
  async function assertLookupFailure(reason: string): Promise<void> {
    const dir = projectDir();
    const printed: string[] = [];
    await runTeachMode({
      cliName: 'hackmyagent',
      projectDir: dir,
      registryUrl: REGISTRY,
      onCommand: async () => '',
      onPrompt: async () => 'n',
      onPrint: (msg) => printed.push(msg),
    });

    const transcript = printed.join('\n');
    const lookup = printed.findIndex((line) =>
      line.startsWith(`  Could not look up agent "${path.basename(dir)}": the registry at ${REGISTRY} ${reason}`),
    );
    assert.ok(lookup > printed.indexOf('  Step 5/7: Checking registry...'), transcript);
    assert.ok(!transcript.includes('is not yet registered'), transcript);
    assert.ok(printed.findIndex((line) => line.includes('Step 6/7')) > lookup, transcript);
    assert.ok(transcript.includes('=== Teach Mode Complete ==='), transcript);
  }

  it('reports a registry it cannot reach as a failed lookup and goes on to step 6', async () => {
    await assertLookupFailure('could not be reached (');
  });

  it('reports a registry error status as a failed lookup and goes on to step 6', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
    await assertLookupFailure('answered with status 500.');
  });
});
