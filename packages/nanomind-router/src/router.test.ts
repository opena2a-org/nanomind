import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  classifyIntent,
  mapToCommand,
  commandTableFor,
  isATCIntent,
  isPlainArgument,
  isScanIntent,
  COMMAND_TABLES,
  type IntentClassification,
  type IntentType,
} from './index.ts';

function intent(name: IntentType, entities: Record<string, string> = {}): IntentClassification {
  return { intent: name, confidence: 0.85, entities, rawInput: '' };
}

function route(input: string, cliName: string) {
  return mapToCommand(classifyIntent(input), cliName);
}

// The adapter directory for each CLI that has a routing table.
const ADAPTER_DIRS: Record<string, string> = {
  hma: 'hma',
  'secretless-ai': 'secretless-ai',
  opena2a: 'opena2a',
};

function adapterSource(cliName: string): string {
  return readFileSync(new URL(`../../../integrations/${ADAPTER_DIRS[cliName]}/index.ts`, import.meta.url), 'utf8');
}

// Subcommand names an adapter's getCommandManifest() lists, without the CLI name.
function manifestCommands(cliName: string): Set<string> {
  const source = adapterSource(cliName);
  const manifest = source.slice(source.indexOf('export function getCommandManifest'));
  const names = [...manifest.matchAll(/\bname:\s*'([^']+)'/g)].map((m) => m[1]);
  return new Set(names.map((name) => name.replace(new RegExp(`^${cliName} `), '').split(' ')[0]));
}

describe('NanoMind Router', () => {
  // Scan intents
  it('classifies "scan this project" as SCAN', () => {
    const result = classifyIntent('scan this project');
    assert.strictEqual(result.intent, 'SCAN');
    assert.ok(result.confidence > 0.5);
  });

  it('classifies "check for vulnerabilities" as SCAN', () => {
    assert.strictEqual(classifyIntent('check for vulnerabilities').intent, 'SCAN');
  });

  // Fix intents
  it('classifies "fix the credential issue" as FIX', () => {
    assert.strictEqual(classifyIntent('fix the credential issue').intent, 'FIX');
  });

  it('classifies "auto-fix all findings" as FIX', () => {
    assert.strictEqual(classifyIntent('auto-fix all findings').intent, 'FIX');
  });

  // Explain intents
  it('classifies "what does CRED-001 mean" as EXPLAIN', () => {
    const result = classifyIntent('what does CRED-001 mean');
    assert.strictEqual(result.intent, 'EXPLAIN');
    assert.strictEqual(result.entities.checkId, 'CRED-001');
  });

  it('takes a finding ID with more than one prefix whole', () => {
    const result = classifyIntent('explain SKILL-SEMANTIC-007');
    assert.strictEqual(result.intent, 'EXPLAIN');
    assert.strictEqual(result.entities.checkId, 'SKILL-SEMANTIC-007');
  });

  it('takes a finding ID with a digit in a prefix or written in lower case, in upper case', () => {
    assert.strictEqual(classifyIntent('what does A2A-001 mean').entities.checkId, 'A2A-001');
    assert.strictEqual(classifyIntent('what does cred-001 mean').entities.checkId, 'CRED-001');
    assert.strictEqual(classifyIntent('explain skill-semantic-007').entities.checkId, 'SKILL-SEMANTIC-007');
  });

  it('takes up to four prefixes of a finding ID, and no ID from a number with no prefix', () => {
    assert.strictEqual(classifyIntent('explain AA-BB-CC-DD-001').entities.checkId, 'AA-BB-CC-DD-001');
    assert.strictEqual(classifyIntent('explain AA-BB-CC-DD-EE-001').entities.checkId, 'BB-CC-DD-EE-001');
    assert.strictEqual(classifyIntent('what does 555-123 mean').entities.checkId, undefined);
  });

  it('needs the words a pattern takes in order to be on one line', () => {
    assert.strictEqual(classifyIntent('scan the skill, it looks malicious').intent, 'SCAN_SKILL_INTENT');
    assert.strictEqual(classifyIntent('scan the skill\nit looks malicious').intent, 'SCAN');
    assert.strictEqual(classifyIntent('why\nwhy is my score low').intent, 'ATC_STATUS');
  });

  // ATC intents
  it('classifies "what is the trust level of my-agent" as TRUST_QUERY', () => {
    const result = classifyIntent('what is the trust level of agent: my-agent');
    assert.strictEqual(result.intent, 'TRUST_QUERY');
    assert.strictEqual(result.entities.agentId, 'my-agent');
  });

  it('classifies "why is my agent level 2" as ATC_STATUS', () => {
    assert.strictEqual(classifyIntent('why is my agent level 2').intent, 'ATC_STATUS');
  });

  // An agent id is taken only where the input marks one
  it('takes no agent id from "why is my agent level 2"', () => {
    assert.deepStrictEqual(classifyIntent('why is my agent level 2').entities, {});
  });

  it('takes no agent id from the word after an unmarked "agent"', () => {
    for (const input of [
      'is this agent trusted',
      'is my agent trusted',
      'check my agent trust level',
      'why is the agent at level 2',
      'scan my agent for vulnerabilities',
      'why is agent billing-agent level 2',
      'is agent "my agent" trusted',
    ]) {
      assert.strictEqual(classifyIntent(input).entities.agentId, undefined, input);
    }
  });

  it('takes the agent id from agent:<id>, a quoted id or a DID after "agent"', () => {
    const cases: Array<[string, string]> = [
      ['trust level of agent:my-agent', 'my-agent'],
      ['trust level of agent: my-agent', 'my-agent'],
      ['why is agent : billing-agent level 2', 'billing-agent'],
      ['Agent: acme/agent trust level', 'acme/agent'],
      ['is agent "my-agent" trusted', 'my-agent'],
      ["is agent 'my-agent' trusted", 'my-agent'],
      ['trust level of agent: "my-agent"', 'my-agent'],
      ["trust level of agent: 'my-agent'", 'my-agent'],
      ['is agent did:web:example.org trusted', 'did:web:example.org'],
      ['trust level of agent: did:web:example.org', 'did:web:example.org'],
      ['why is my agent level 2, agent: billing-agent', 'billing-agent'],
    ];
    for (const [input, agentId] of cases) {
      assert.strictEqual(classifyIntent(input).entities.agentId, agentId, input);
    }
  });

  it('classifies "show risk score" as RISK_SCORE', () => {
    assert.strictEqual(classifyIntent('show risk score').intent, 'RISK_SCORE');
  });

  it('classifies "why was this revoked" as REVOCATION', () => {
    assert.strictEqual(classifyIntent('why was this revoked').intent, 'REVOCATION');
  });

  it('classifies "add trust to my CI" as ATTEST', () => {
    assert.strictEqual(classifyIntent('add trust attestation to my CI').intent, 'ATTEST');
  });

  // Help
  it('classifies "help" as HELP', () => {
    assert.strictEqual(classifyIntent('help').intent, 'HELP');
  });

  it('classifies "what can you do" as HELP', () => {
    assert.strictEqual(classifyIntent('what can you do').intent, 'HELP');
  });

  // Unknown
  it('classifies gibberish as UNKNOWN', () => {
    assert.strictEqual(classifyIntent('asdfghjkl').intent, 'UNKNOWN');
  });

  // isATCIntent
  it('identifies ATC intents', () => {
    assert.strictEqual(isATCIntent('TRUST_QUERY'), true);
    assert.strictEqual(isATCIntent('ATC_STATUS'), true);
    assert.strictEqual(isATCIntent('ATTEST'), true);
    assert.strictEqual(isATCIntent('SCAN'), false);
    assert.strictEqual(isATCIntent('HELP'), false);
  });

  // SCAN intents (NanoMind-enhanced HMA scanning)
  it('classifies skill intent scan', () => {
    assert.strictEqual(classifyIntent('scan skill intent malicious').intent, 'SCAN_SKILL_INTENT');
  });

  it('classifies SOUL governance completeness', () => {
    assert.strictEqual(classifyIntent('soul governance completeness gaps').intent, 'SCAN_SOUL_COMPLETENESS');
  });

  it('classifies MCP scope analysis', () => {
    assert.strictEqual(classifyIntent('mcp tool description scope analysis').intent, 'SCAN_MCP_SCOPE');
  });

  it('classifies system prompt intent', () => {
    assert.strictEqual(classifyIntent('system prompt behavioral envelope').intent, 'SCAN_PROMPT_INTENT');
  });

  it('classifies version delta', () => {
    assert.strictEqual(classifyIntent('version delta semantic diff').intent, 'SCAN_VERSION_DELTA');
  });

  it('classifies scan explain', () => {
    assert.strictEqual(classifyIntent('explain finding SKILL-007').intent, 'SCAN_EXPLAIN');
  });

  // isScanIntent
  it('identifies SCAN intents', () => {
    assert.strictEqual(isScanIntent('SCAN_SKILL_INTENT'), true);
    assert.strictEqual(isScanIntent('SCAN_SOUL_COMPLETENESS'), true);
    assert.strictEqual(isScanIntent('SCAN_MCP_SCOPE'), true);
    assert.strictEqual(isScanIntent('SCAN_PROMPT_INTENT'), true);
    assert.strictEqual(isScanIntent('SCAN_VERSION_DELTA'), true);
    assert.strictEqual(isScanIntent('SCAN_EXPLAIN'), true);
    assert.strictEqual(isScanIntent('SCAN'), false); // generic SCAN is NOT a SCAN intent
    assert.strictEqual(isScanIntent('HELP'), false);
  });

  // Command mapping
  it('maps SCAN to hma secure', () => {
    const classification = classifyIntent('scan this');
    const cmd = mapToCommand(classification, 'hma');
    assert.ok(cmd);
    assert.strictEqual(cmd.command, 'hma secure');
  });

  it('maps TRUST_QUERY to opena2a trust', () => {
    const classification = classifyIntent('trust level');
    const cmd = mapToCommand(classification, 'opena2a');
    assert.ok(cmd);
    assert.strictEqual(cmd.command, 'opena2a trust');
  });

  // Secrets: tried before the general SCAN pattern, which also matches "check"
  it('classifies "check for exposed secrets" as SECRETS_EXPOSE', () => {
    assert.strictEqual(classifyIntent('check for exposed secrets').intent, 'SECRETS_EXPOSE');
  });

  it('classifies "find credentials" as SECRETS_EXPOSE', () => {
    assert.strictEqual(classifyIntent('find credentials').intent, 'SECRETS_EXPOSE');
  });

  it('classifies "is my api key exposed" as SECRETS_EXPOSE', () => {
    assert.strictEqual(classifyIntent('is my api key exposed').intent, 'SECRETS_EXPOSE');
  });

  it('classifies "open the dashboard" and "show the report" as NAVIGATE', () => {
    assert.strictEqual(classifyIntent('open the dashboard').intent, 'NAVIGATE');
    assert.strictEqual(classifyIntent('show the report').intent, 'NAVIGATE');
    assert.strictEqual(classifyIntent('view reports').intent, 'NAVIGATE');
  });

  it('classifies a request to open the scan report as NAVIGATE, not SCAN', () => {
    assert.strictEqual(classifyIntent('show the scan report').intent, 'NAVIGATE');
    assert.strictEqual(classifyIntent('scan the report').intent, 'SCAN');
  });

  it('keeps STATUS and FIX for a request that also names a report or dashboard', () => {
    assert.strictEqual(classifyIntent('show the status report').intent, 'STATUS');
    assert.strictEqual(classifyIntent('show status dashboard').intent, 'STATUS');
    assert.strictEqual(classifyIntent('display the summary report').intent, 'STATUS');
    assert.strictEqual(classifyIntent('open the report and fix issues').intent, 'FIX');
    assert.strictEqual(classifyIntent('view the report and remediate').intent, 'FIX');
  });

  it('classifies "detect agents in this project" as SCAN', () => {
    assert.strictEqual(classifyIntent('detect agents in this project').intent, 'SCAN');
  });
});

describe('Per-CLI command tables', () => {
  it('routes secretless-ai SECRETS_EXPOSE to secretless-ai diagnose', () => {
    const cmd = mapToCommand(intent('SECRETS_EXPOSE'), 'secretless-ai');
    assert.ok(cmd);
    assert.strictEqual(cmd.command, 'secretless-ai diagnose');
  });

  it('routes "check for exposed secrets" in secretless-ai to diagnose, not a scan', () => {
    assert.strictEqual(route('check for exposed secrets', 'secretless-ai')?.command, 'secretless-ai diagnose');
  });

  it('routes secretless-ai SCAN and STATUS to commands in its manifest', () => {
    assert.strictEqual(route('scan this project', 'secretless-ai')?.command, 'secretless-ai scan');
    assert.strictEqual(route('show status', 'secretless-ai')?.command, 'secretless-ai verify');
  });

  it('routes hma "detect" to hma detect', () => {
    assert.deepStrictEqual(route('detect agents in this project', 'hma'), {
      command: 'hma detect',
      args: ['.'],
      description: 'Detect AI agents in project',
    });
  });

  it('routes hma "check package: <name>" to hma check <name>', () => {
    const cmd = route('check package: express', 'hma');
    assert.ok(cmd);
    assert.strictEqual(cmd.command, 'hma check');
    assert.deepStrictEqual(cmd.args, ['express']);
  });

  it('passes a scoped package name to hma check', () => {
    assert.deepStrictEqual(route('check package: @scope/name', 'hma')?.args, ['@scope/name']);
  });

  // Entity values come from the request text and adapters run the mapped
  // command through a shell, so a value a shell would interpret never
  // becomes an argument: the route is skipped and the next one applies.
  it('skips hma check when the package name holds shell characters', () => {
    const secure = { command: 'hma secure', args: ['.'], description: 'Run security scan' };
    assert.deepStrictEqual(route('check package: x;echo', 'hma'), secure);
    assert.deepStrictEqual(route('check package: x;echo${IFS}INJECTED>out', 'hma'), secure);
    assert.deepStrictEqual(route('check package: $(id)', 'hma'), secure);
    assert.deepStrictEqual(route('check package: "a', 'hma'), secure);
  });

  it('skips hma check when the package name starts with a hyphen', () => {
    assert.deepStrictEqual(route('check package: --fix', 'hma'), {
      command: 'hma secure',
      args: ['.'],
      description: 'Run security scan',
    });
  });

  it('maps to null when an optional entity value is not a plain argument and no other route applies', () => {
    assert.strictEqual(mapToCommand(intent('TRUST_QUERY', { agentId: 'my-agent;id' }), 'opena2a'), null);
    assert.strictEqual(mapToCommand(intent('TRUST_QUERY', { agentId: '--help' }), 'hma'), null);
    assert.deepStrictEqual(mapToCommand(intent('TRUST_QUERY', { agentId: 'did:web:example.org' }), 'hma')?.args, ['did:web:example.org']);
  });

  it('routes "why is my agent level 2" to opena2a trust explain with no agent id', () => {
    for (const cliName of Object.keys(COMMAND_TABLES)) {
      assert.deepStrictEqual(route('why is my agent level 2', cliName), {
        command: 'opena2a trust explain',
        args: [],
        description: 'Explain trust level',
      }, cliName);
    }
  });

  it('appends a marked agent id to the trust commands', () => {
    assert.deepStrictEqual(route('why is agent: billing-agent level 2', 'opena2a'), {
      command: 'opena2a trust explain',
      args: ['billing-agent'],
      description: 'Explain trust level',
    });
    assert.deepStrictEqual(route('is agent "my-agent" trusted', 'hma'), {
      command: 'opena2a trust',
      args: ['my-agent'],
      description: 'Query trust level',
    });
  });

  it('isPlainArgument accepts identifiers and refuses shell syntax', () => {
    for (const value of ['express', '@scope/name', 'my-agent', 'my_agent', 'v1.2.3', 'a:b', 'c++']) {
      assert.strictEqual(isPlainArgument(value), true, value);
    }
    for (const value of ['', '-x', 'a;b', 'a b', 'a|b', 'a&b', '$HOME', '`id`', 'a>b', 'a<b', "a'b", 'a"b', '*', '~u', 'a\\b', 'a=b', '(a)', '{a}', '#a', '!a', 'aé']) {
      assert.strictEqual(isPlainArgument(value), false, JSON.stringify(value));
    }
  });

  it('isPlainArgument refuses a value that starts with anything but a letter, digit or @', () => {
    for (const value of ['_x', '.x', '/x', ':x', '+x', 'éa']) {
      assert.strictEqual(isPlainArgument(value), false, JSON.stringify(value));
    }
  });

  it('keeps the hma scan, fix, status and help routes', () => {
    assert.deepStrictEqual(route('scan this project', 'hma'), { command: 'hma secure', args: ['.'], description: 'Run security scan' });
    assert.deepStrictEqual(route('auto-fix all findings', 'hma'), { command: 'hma secure', args: ['--fix'], description: 'Auto-fix findings' });
    assert.deepStrictEqual(route('show status', 'hma'), { command: 'hma secure', args: ['--summary'], description: 'Show scan summary' });
    assert.deepStrictEqual(route('help', 'hma'), { command: 'hma --help', args: [], description: 'Show help' });
  });

  it('routes hma EXPLAIN with a finding ID to hma explain <id>', () => {
    assert.deepStrictEqual(route('what does CRED-001 mean', 'hma'), {
      command: 'hma explain',
      args: ['CRED-001'],
      description: 'Explain a security finding',
    });
    assert.deepStrictEqual(route('explain SKILL-SEMANTIC-007', 'hma')?.args, ['SKILL-SEMANTIC-007']);
  });

  it('routes hma EXPLAIN with a finding ID that has a digit in a prefix or is in lower case', () => {
    assert.deepStrictEqual(route('what does A2A-001 mean', 'hma')?.args, ['A2A-001']);
    assert.deepStrictEqual(route('what does cred-001 mean', 'hma'), {
      command: 'hma explain',
      args: ['CRED-001'],
      description: 'Explain a security finding',
    });
  });

  it('maps EXPLAIN to null when no finding ID is named or the CLI has no explain command', () => {
    assert.strictEqual(classifyIntent('what does this mean').intent, 'EXPLAIN');
    assert.strictEqual(route('what does this mean', 'hma'), null);
    assert.strictEqual(route('what does CRED-001 mean', 'secretless-ai'), null);
    assert.strictEqual(route('what does CRED-001 mean', 'opena2a'), null);
  });

  it('routes hma SECRETS_EXPOSE to the hma credential scan', () => {
    assert.strictEqual(route('check for exposed secrets', 'hma')?.command, 'hma secure');
  });

  it('routes opena2a intents to the products behind it', () => {
    assert.strictEqual(route('check for exposed secrets', 'opena2a')?.command, 'opena2a secretless');
    assert.strictEqual(route('detect agents in this project', 'opena2a')?.command, 'opena2a detect');
    assert.strictEqual(route('scan this project', 'opena2a')?.command, 'opena2a scan');
    assert.strictEqual(route('show status', 'opena2a')?.command, 'opena2a review');
    assert.deepStrictEqual(mapToCommand(intent('TRUST_QUERY', { agentId: 'my-agent' }), 'opena2a')?.args, ['my-agent']);
  });

  it('routes opena2a NAVIGATE to opena2a review and CONFIG to opena2a config show', () => {
    assert.deepStrictEqual(route('open the dashboard', 'opena2a'), {
      command: 'opena2a review',
      args: [],
      description: 'Run all security checks and open the HTML dashboard',
    });
    assert.deepStrictEqual(route('show config', 'opena2a'), {
      command: 'opena2a config',
      args: ['show'],
      description: 'Show OpenA2A configuration',
    });
  });

  it('maps NAVIGATE and CONFIG to null on hma and secretless-ai', () => {
    for (const cliName of ['hma', 'secretless-ai']) {
      assert.strictEqual(route('open the dashboard', cliName), null, `${cliName} NAVIGATE`);
      assert.strictEqual(route('show config', cliName), null, `${cliName} CONFIG`);
    }
  });

  it('routes a STATUS or FIX request that names a report to the STATUS or FIX command', () => {
    assert.deepStrictEqual(route('show the status report', 'hma'), {
      command: 'hma secure',
      args: ['--summary'],
      description: 'Show scan summary',
    });
    assert.deepStrictEqual(route('open the report and fix issues', 'hma'), {
      command: 'hma secure',
      args: ['--fix'],
      description: 'Auto-fix findings',
    });
    assert.strictEqual(route('show status dashboard', 'hma')?.command, 'hma secure');
    assert.strictEqual(route('show the status report', 'secretless-ai')?.command, 'secretless-ai verify');
    assert.strictEqual(route('show the status report', 'opena2a')?.command, 'opena2a review');
  });

  it('returns null for an intent a CLI has no command for', () => {
    assert.strictEqual(mapToCommand(intent('FIX'), 'secretless-ai'), null);
    assert.strictEqual(mapToCommand(intent('NAVIGATE'), 'hma'), null);
    assert.strictEqual(mapToCommand(intent('constructor' as IntentType), 'hma'), null);
  });

  it('gives a CLI without a table the generic routes', () => {
    assert.deepStrictEqual(commandTableFor('acme'), commandTableFor('another-cli'));
    assert.strictEqual(route('scan this project', 'acme')?.command, 'acme secure');
    assert.strictEqual(route('check for exposed secrets', 'acme')?.command, 'acme secure');
  });

  it('uses a table the caller supplies over the built-in one', () => {
    const cmd = mapToCommand(intent('COMPARE'), 'acme', {
      COMPARE: [{ command: 'diff', args: ['--last'], description: 'Compare with the last scan' }],
    });
    assert.deepStrictEqual(cmd, { command: 'acme diff', args: ['--last'], description: 'Compare with the last scan' });
  });

  for (const cliName of Object.keys(COMMAND_TABLES)) {
    it(`${cliName} adapter declares the cliName its table is keyed by`, () => {
      assert.match(adapterSource(cliName), new RegExp(`cliName:\\s*'${cliName}'`));
    });

    it(`${cliName} table only routes to commands an adapter manifest lists`, () => {
      for (const [intentName, routes] of Object.entries(COMMAND_TABLES[cliName])) {
        for (const r of routes ?? []) {
          if (r.command.startsWith('--')) continue;
          const owner = r.cli ?? cliName;
          const subcommand = r.command.split(' ')[0];
          assert.ok(
            manifestCommands(owner).has(subcommand),
            `${cliName} ${intentName} routes to "${owner} ${r.command}", which the ${owner} manifest does not list`,
          );
        }
      }
    });
  }
});

// CPU time of one classifyIntent call in milliseconds. CPU time rather than
// wall time, so that load from other processes on the machine does not count.
function classifyCpuMs(input: string): number {
  const before = process.cpuUsage();
  classifyIntent(input);
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

// Each input repeats the start of a match and never completes it: "A-" is a
// finding ID prefix with no number, and each other input repeats the first
// word, or the first two words, of a pattern built with inOrder but never its
// last word.
describe('Classification time', () => {
  const SIZE = 256 * 1024;
  const LIMIT_MS = 250;
  for (const unit of ['A-', 'scan skill ', 'add ci ', 'why ', 'explain ', 'mcp ', 'soul ', 'build ', 'secret ', 'find ', 'open ', 'create ']) {
    it(`classifies 256 KB of ${JSON.stringify(unit)} repeated in under ${LIMIT_MS} ms of CPU time`, () => {
      const input = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
      const ms = classifyCpuMs(input);
      assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)} ms`);
    });
  }
});

// The README's intent count, isScanIntent examples and SCAN_* table, read from
// the README itself and checked against IntentType and the router functions.
describe('Router README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const intentNames = [...(source.match(/export type IntentType =([\s\S]*?);/)?.[1] ?? '').matchAll(/\|\s*'([A-Z_]+)'/g)]
    .map((m) => m[1] as IntentType);
  const scanIntents = intentNames.filter((name) => isScanIntent(name));

  it('states how many intents IntentType names', () => {
    assert.ok(intentNames.includes('UNKNOWN'), 'IntentType is read from index.ts');
    const stated = readme.match(/`IntentType` names (\d+) intents plus `UNKNOWN`, (\d+) of them security scanning intents/);
    assert.ok(stated, 'README states the IntentType count');
    assert.strictEqual(Number(stated[1]), intentNames.length - 1);
    assert.strictEqual(Number(stated[2]), scanIntents.length);
  });

  it('shows the value isScanIntent returns in each example', () => {
    const examples = [...readme.matchAll(/isScanIntent\('([A-Z_]+)'\);\s*\/\/\s*(true|false)/g)];
    assert.ok(examples.length > 0, 'README has isScanIntent examples');
    for (const [, name, shown] of examples) {
      assert.strictEqual(String(isScanIntent(name as IntentType)), shown, `README: isScanIntent('${name}'); // ${shown}`);
    }
  });

  it('lists in the route table the command each example runs on each CLI', () => {
    const start = readme.indexOf('### General Intents and Routes');
    assert.notStrictEqual(start, -1, 'README has a General Intents and Routes section');
    const end = readme.indexOf('\n### ', start + 1);
    const header = readme.slice(start, end).match(/^\| Intent \| Example \|(.+)\|$/m);
    assert.ok(header, 'README route table has a header row');
    const clis = header[1].split('|').map((cell) => cell.trim().replaceAll('`', ''));
    assert.deepStrictEqual(clis, Object.keys(COMMAND_TABLES));
    const rows = [...readme.slice(start, end).matchAll(/^\| ([^|]+) \| "([^"]+)" \|(.+)\|$/gm)];
    assert.ok(rows.length > 0, 'README route table has rows');
    for (const [, intentCell, input, cells] of rows) {
      const classification = classifyIntent(input);
      assert.strictEqual(classification.intent, intentCell.split(',')[0], `"${input}" classifies to ${intentCell}`);
      cells.split('|').forEach((cell, i) => {
        const mapping = mapToCommand(classification, clis[i]);
        const actual = mapping ? [mapping.command, ...mapping.args].join(' ') : 'no route';
        assert.strictEqual(actual, cell.trim().replaceAll('`', ''), `README: "${input}" on ${clis[i]}`);
      });
    }
  });

  it('lists the scanning intents isScanIntent accepts, each with an input that classifies to it', () => {
    const start = readme.indexOf('### Security Scanning Intents');
    assert.notStrictEqual(start, -1, 'README has a Security Scanning Intents section');
    const end = readme.indexOf('\n## ', start);
    const rows = [...readme.slice(start, end === -1 ? undefined : end).matchAll(/^\| (\w+) \| [^|]+ \| "([^"]+)" \|$/gm)];
    assert.deepStrictEqual(rows.map((row) => row[1]).sort(), [...scanIntents].sort());
    for (const [, name, input] of rows) {
      const classification = classifyIntent(input);
      assert.strictEqual(classification.intent, name, `"${input}" classifies to ${name}`);
      for (const cliName of [...Object.keys(COMMAND_TABLES), 'acme']) {
        assert.strictEqual(mapToCommand(classification, cliName), null, `${name} has no ${cliName} route`);
      }
    }
  });
});

// The intent patterns before the rows with `.*` between their words were
// rewritten as matchers that find the words in order, one line at a time. The
// tests below check that classifyIntent gives the intent these patterns give,
// and that an input repeating one of the words is classified in linear time.
describe('Intent patterns whose words are matched in order', () => {
  const previousFix = /\b(fix|repair|patch|remediate|auto-?fix)\b/i;
  const previousStatus = /\b(status|how (secure|safe)|summary|overview)\b/i;
  const previousPatterns: Array<{ pattern: RegExp; intent: IntentType; unless?: RegExp[] }> = [
    { pattern: /\bscan.*(skill|intent).*malicious\b/i, intent: 'SCAN_SKILL_INTENT' },
    { pattern: /\b(soul|governance).*(complet|coverage|gap)/i, intent: 'SCAN_SOUL_COMPLETENESS' },
    { pattern: /\bmcp.*(scope|permission|tool\s*desc)\b/i, intent: 'SCAN_MCP_SCOPE' },
    { pattern: /\b(system\s*prompt|prompt\s*intent|behavioral\s*envelope)\b/i, intent: 'SCAN_PROMPT_INTENT' },
    { pattern: /\b(version\s*delta|semantic\s*diff|skill\s*update)\b/i, intent: 'SCAN_VERSION_DELTA' },
    { pattern: /\bexplain\s*(finding|scan\s*result|detection)\b/i, intent: 'SCAN_EXPLAIN' },
    { pattern: /\b(trust\s*level|trust\s*score|trusted)\b/i, intent: 'TRUST_QUERY' },
    { pattern: /\b(why.*(level|trust|score)|explain.*(trust|level|atc))\b/i, intent: 'ATC_STATUS' },
    { pattern: /\b(risk\s*score|ars|blast\s*radius)\b/i, intent: 'RISK_SCORE' },
    { pattern: /\b(revok(ed|e|ation)|why.*blocked)\b/i, intent: 'REVOCATION' },
    { pattern: /\b(exposure|ceiling|exposure\s*ceiling)\b/i, intent: 'EXPOSURE' },
    { pattern: /\b(attest|attestation|build.*(trust|atc)|add.*ci.*trust)\b/i, intent: 'ATTEST' },
    { pattern: /\b(secrets?|credentials?|keys?|tokens?|passwords?|env)\b.*\b(exposed?|leak(s|ed|ing)?|find|check)\b/i, intent: 'SECRETS_EXPOSE' },
    { pattern: /\b(exposed?|leak(s|ed|ing)?|find|check)\b.*\b(secrets?|credentials?|keys?|tokens?|passwords?|env)\b/i, intent: 'SECRETS_EXPOSE' },
    { pattern: /\b(open|show|view|display)\b.*\b(dashboards?|reports?)\b/i, intent: 'NAVIGATE', unless: [previousFix, previousStatus] },
    { pattern: /\b(scan|check|audit|inspect|analyze|secure|detect)\b/i, intent: 'SCAN' },
    { pattern: previousFix, intent: 'FIX' },
    { pattern: /\b(generate|create|make|build|setup|configure)\b.*\b(action|docker|ci|yaml|config)\b/i, intent: 'GENERATE' },
    { pattern: /\b(compare|diff|changed|difference|delta)\b/i, intent: 'COMPARE' },
    { pattern: previousStatus, intent: 'STATUS' },
    { pattern: /\b(set|configure|config|setting|preference)\b/i, intent: 'CONFIG' },
    { pattern: /\b(explain|what (does|is|are)|describe|tell me about|meaning)\b/i, intent: 'EXPLAIN' },
    { pattern: /\b(help|command|what can|how do|usage)\b/i, intent: 'HELP' },
  ];

  function previousIntent(input: string): IntentType {
    const trimmed = input.trim();
    for (const { pattern, intent, unless } of previousPatterns) {
      if (unless?.some((skip) => skip.test(trimmed))) continue;
      if (pattern.test(trimmed)) return intent;
    }
    return 'UNKNOWN';
  }

  it('matches the words of a row in order on one line, as the pattern with `.*` did', () => {
    const cases: Array<[string, IntentType]> = [
      ['show me the latest report', 'NAVIGATE'],
      ['the report, then show it', 'UNKNOWN'],
      ['show\nthe report', 'UNKNOWN'],
      ['show\nshow the report', 'NAVIGATE'],
      ['showreport', 'UNKNOWN'],
      ['Display the DASHBOARDS', 'NAVIGATE'],
      ['scan the skill for malicious intent', 'SCAN_SKILL_INTENT'],
      ['scan for malicious skill', 'SCAN'],
      ['add ci trust', 'ATTEST'],
      ['add trust to ci', 'UNKNOWN'],
      ['build trust\r\nadd ci', 'ATTEST'],
      ['build\u{2028}trust', 'UNKNOWN'],
      ['why was the agent blocked', 'REVOCATION'],
      ['explain the atc level', 'ATC_STATUS'],
      ['find the leaked keys', 'SECRETS_EXPOSE'],
      ['create a docker config', 'GENERATE'],
      ['the docker config was created', 'CONFIG'],
      ['mcp tool description scope', 'SCAN_MCP_SCOPE'],
      ['soul coverage', 'SCAN_SOUL_COMPLETENESS'],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(previousIntent(input), expected, `previous pattern for ${JSON.stringify(input)}`);
      assert.strictEqual(classifyIntent(input).intent, expected, JSON.stringify(input));
    }
  });

  it('gives the intent of the previous patterns on 20000 generated inputs', () => {
    // The words of the rewritten rows, words that share a stem with them but
    // are not them, words of the other rows, and filler.
    const words = [
      'scan', 'skill', 'intent', 'malicious', 'soul', 'governance', 'complete', 'coverage', 'gap',
      'mcp', 'scope', 'permission', 'tool desc', 'tooldesc', 'why', 'level', 'trust', 'score',
      'explain', 'atc', 'blocked', 'attest', 'attestation', 'build', 'add', 'ci', 'secret',
      'secrets', 'credential', 'credentials', 'key', 'keys', 'token', 'tokens', 'password',
      'passwords', 'env', 'expose', 'exposed', 'leak', 'leaks', 'leaked', 'leaking', 'find',
      'check', 'open', 'show', 'view', 'display', 'dashboard', 'dashboards', 'report', 'reports',
      'generate', 'create', 'make', 'setup', 'configure', 'action', 'docker', 'yaml', 'config',
      'scanner', 'skills', 'intents', 'maliciously', 'souls', 'gaps', 'scoped', 'trusted',
      'levels', 'scores', 'explained', 'blocks', 'builder', 'adds', 'cis', 'secretive', 'keyed',
      'exposure', 'leakage', 'finder', 'checked', 'showing', 'opened', 'viewer', 'displays',
      'reporting', 'created', 'maker', 'configs', 'fix', 'status', 'summary', 'risk', 'ars',
      'revoked', 'ceiling', 'help', 'set', 'compare', 'the', 'my', 'a', 'to', 'for', 'is', 'and',
      'please', 'project', 'agent', '2', 'it', 'now', 'report!', 'x',
    ];
    const separators = [' ', ' ', ' ', '', '\n', '\r\n', '\u{2028}', '\u{2029}', '-', ', ', '  ', '\t'];
    const casings: Array<(word: string) => string> = [
      (word) => word,
      (word) => word.toUpperCase(),
      (word) => word[0].toUpperCase() + word.slice(1),
    ];
    // mulberry32 with a fixed seed, so the corpus is the same on every run.
    let state = 184;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    for (let i = 0; i < 20000; i++) {
      const count = 1 + Math.floor(random() * 10);
      let input = pick(casings)(pick(words));
      for (let j = 1; j < count; j++) input += pick(separators) + pick(casings)(pick(words));
      assert.strictEqual(classifyIntent(input).intent, previousIntent(input), JSON.stringify(input));
    }
  });

  // Each input repeats a word that opens one of the rewritten rows and holds
  // no word that completes the row. The pattern with `.*` re-read the rest of
  // the input from every repetition, so its time grew four times per doubling
  // of the input, and eight times for the rows with three words.
  const repeatedWords: Array<[string, number]> = [
    ['scan skill ', 8],
    ['soul ', 128],
    ['mcp ', 128],
    ['why ', 128],
    ['explain ', 128],
    ['build ', 128],
    ['add ci ', 8],
    ['secrets ', 128],
    ['check ', 128],
    ['show ', 128],
    ['create ', 128],
  ];
  for (const [word, kb] of repeatedWords) {
    it(`classifies ${kb} KB of "${word}" repeated in under 200 ms`, () => {
      const input = word.repeat(Math.ceil((kb * 1024) / word.length));
      let fastest = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        classifyIntent(input);
        fastest = Math.min(fastest, performance.now() - start);
      }
      assert.ok(fastest < 200, `${fastest.toFixed(1)} ms`);
    });
  }
});
