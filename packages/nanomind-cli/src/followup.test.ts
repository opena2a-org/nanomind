import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ATCIntentHandler } from '@nanomind/atc';
import { createSessionMemory, handleInput, type NanoMindSession, type SessionMemory } from './index.ts';

// No test here may reach a real registry.
const REGISTRY = 'http://127.0.0.1:9';
const SCAN_OUTPUT = '[CRED-001] Hardcoded API key (critical)\n[MCP-003] Open transport (high)\n2 total, 1 critical, 1 high';
const UNKNOWN = 'frobnicate the widget';

const BEGINNER_UNKNOWN = 'Requests are matched against fixed patterns';
const INTERMEDIATE_UNKNOWN = 'I\'m not sure how to help with that. Try "help" for examples.';
const EXPERT_UNKNOWN = 'No matching request. Try "help".';

// Runs one line through handleInput, carrying `memory` between calls. The
// session's onCommand records the command and answers with `reply`.
async function turn(
  input: string,
  memory: SessionMemory | undefined,
  reply = '',
): Promise<{ output: string; commands: string[] }> {
  const commands: string[] = [];
  const session: NanoMindSession = {
    cliName: 'hma',
    cliVersion: '0.0.0',
    registryUrl: REGISTRY,
    onCommand: async (cmd, args) => {
      commands.push([cmd, ...args].join(' '));
      return reply;
    },
  };
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await handleInput(input, session, new ATCIntentHandler({ registryUrl: REGISTRY }), memory);
  } finally {
    log.mock.restore();
  }
  return { output: lines.join('\n'), commands };
}

describe('handleInput: follow-up references', () => {
  it('reads "the first one" and "that finding" as the first finding the last command printed', async () => {
    const memory = createSessionMemory();
    const scan = await turn('scan this project', memory, SCAN_OUTPUT);
    assert.deepStrictEqual(scan.commands, ['hma secure .']);
    assert.ok(scan.output.includes('"the first one" and "that finding" now mean CRED-001.'), scan.output);

    const fix = await turn('fix the first one', memory);
    assert.ok(fix.output.includes('> Reading "fix the first one" as "fix CRED-001"'), fix.output);
    assert.deepStrictEqual(fix.commands, ['hma secure --fix']);

    // The follow-up is then routed as the line with the id typed out would
    // be, whatever the router's table maps that line to.
    const explain = await turn('explain that finding', memory);
    const typed = await turn('explain CRED-001', createSessionMemory());
    assert.strictEqual(explain.output, `\n  > Reading "explain that finding" as "explain CRED-001"\n${typed.output}`);
    assert.deepStrictEqual(explain.commands, typed.commands);
  });

  it('keeps the findings of the last command that printed any', async () => {
    const memory = createSessionMemory();
    await turn('scan this project', memory, SCAN_OUTPUT);
    const fix = await turn('fix the first one', memory, 'Fixed 1 finding');
    assert.ok(!fix.output.includes('now mean'), fix.output);
    const explain = await turn('explain that check', memory);
    assert.ok(explain.output.includes('> Reading "explain that check" as "explain CRED-001"'), explain.output);
  });

  it('routes the words as typed when no finding was printed', async () => {
    const memory = createSessionMemory();
    const fix = await turn('fix the first one', memory);
    assert.ok(!fix.output.includes('> Reading'), fix.output);
    assert.deepStrictEqual(fix.commands, ['hma secure --fix']);
    const explain = await turn('explain that finding', memory);
    assert.ok(explain.output.includes('hma has no command for EXPLAIN requests'), explain.output);
    assert.deepStrictEqual(explain.commands, []);
  });

  it('handles a line on its own without a memory', async () => {
    const explain = await turn('explain that finding', undefined);
    assert.ok(explain.output.includes('hma has no command for EXPLAIN requests'), explain.output);
    const unknown = await turn(UNKNOWN, undefined);
    assert.ok(unknown.output.includes(INTERMEDIATE_UNKNOWN), unknown.output);
  });

  it('reads "my agent" as the agent the last trust answer named', async () => {
    const memory = createSessionMemory();
    memory.context.update('what is the trust level of agent: billing-agent', '\n  Agent: billing-agent\n  Trust Level: 3\n');
    const status = await turn('why is my agent level 2', memory);
    assert.ok(status.output.includes('> Reading "why is my agent level 2" as "why is agent: billing-agent level 2"'), status.output);
    assert.ok(status.output.includes('billing-agent'), status.output);
    assert.deepStrictEqual(status.commands, []);
  });

  it('takes no agent from a not-found answer that quotes the id', async () => {
    const memory = createSessionMemory();
    const query = await turn('what is the trust level of agent: billing-agent', memory);
    assert.ok(query.output.includes('No ATC found for agent "billing-agent"'), query.output);
    const status = await turn('why is my agent level 2', memory);
    assert.ok(!status.output.includes('> Reading'), status.output);
  });
});

describe('handleInput: skill level', () => {
  it('says the middle-length message before three lines were typed', async () => {
    const memory = createSessionMemory();
    const unknown = await turn(UNKNOWN, memory);
    assert.ok(unknown.output.includes(INTERMEDIATE_UNKNOWN), unknown.output);
    assert.ok(!unknown.output.includes(BEGINNER_UNKNOWN), unknown.output);
  });

  it('says more to a user whose lines were questions the CLI had no command for', async () => {
    const memory = createSessionMemory();
    for (let i = 0; i < 3; i++) await turn('what is a credential', memory);
    assert.strictEqual(memory.skill.getLevel(), 'beginner');
    const unknown = await turn(UNKNOWN, memory);
    assert.ok(unknown.output.includes(BEGINNER_UNKNOWN), unknown.output);
    assert.ok(!unknown.output.includes(EXPERT_UNKNOWN), unknown.output);
    const scan = await turn('scan this project', memory, SCAN_OUTPUT);
    assert.ok(scan.output.includes('now mean CRED-001, the first finding above'), scan.output);
  });

  it('says less to a user whose lines carried CLI flags and ran', async () => {
    const memory = createSessionMemory();
    for (let i = 0; i < 3; i++) await turn('hma secure --ci', memory, SCAN_OUTPUT);
    assert.strictEqual(memory.skill.getLevel(), 'expert');
    const unknown = await turn(UNKNOWN, memory);
    assert.ok(unknown.output.includes(EXPERT_UNKNOWN), unknown.output);
    assert.ok(!unknown.output.includes("I'm not sure"), unknown.output);
    const scan = await turn('scan this project', memory, SCAN_OUTPUT);
    assert.deepStrictEqual(scan.commands, ['hma secure .']);
    assert.ok(!scan.output.includes('now mean'), scan.output);
  });
});

// Runs startSession in a child process with `input` piped to its stdin. Its
// onCommand prints "RAN <command>", waits a moment so the input has ended
// before the turn finishes, and answers the first command with SCAN_OUTPUT.
function runSession(input: string): string {
  const cli = pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href;
  const script = `
    import { startSession } from ${JSON.stringify(cli)};
    let calls = 0;
    await startSession({
      cliName: 'hma',
      cliVersion: '0.0.0',
      registryUrl: ${JSON.stringify(REGISTRY)},
      onCommand: async (cmd, args) => {
        calls += 1;
        console.log('RAN ' + [cmd, ...args].join(' '));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return calls === 1 ? ${JSON.stringify(SCAN_OUTPUT)} : '';
      },
    });
  `;
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { input, encoding: 'utf-8', timeout: 30000 },
  );
  assert.strictEqual(child.status, 0, child.stderr);
  return child.stdout;
}

describe('startSession: turns', () => {
  it('handles piped lines in order, so a follow-up names the finding the line before it printed', () => {
    const stdout = runSession('scan this project\nfix the first one\nexplain that finding\n');
    assert.ok(!stdout.includes('Error:'), stdout);
    const scanAt = stdout.indexOf('RAN hma secure .');
    const outputAt = stdout.indexOf('[CRED-001] Hardcoded API key');
    const fixAt = stdout.indexOf('RAN hma secure --fix');
    const explainAt = stdout.indexOf('> Reading "explain that finding" as "explain CRED-001"');
    assert.ok(scanAt >= 0 && outputAt > scanAt && fixAt > outputAt && explainAt > fixAt, stdout);
    assert.ok(stdout.includes('> Reading "fix the first one" as "fix CRED-001"'), stdout);
    assert.ok(stdout.trimEnd().endsWith('Goodbye.'), stdout);
  });

  it('leaves the lines queued behind exit unhandled', () => {
    const stdout = runSession('scan this project\nexit\nfix the first one\n');
    assert.ok(stdout.includes('RAN hma secure .'), stdout);
    assert.ok(!stdout.includes('RAN hma secure --fix'), stdout);
    assert.ok(stdout.trimEnd().endsWith('Goodbye.'), stdout);
  });
});
