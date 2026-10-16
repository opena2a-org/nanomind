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

  // ATC intents
  it('classifies "what is the trust level of my-agent" as TRUST_QUERY', () => {
    const result = classifyIntent('what is the trust level of agent: my-agent');
    assert.strictEqual(result.intent, 'TRUST_QUERY');
    assert.strictEqual(result.entities.agentId, 'my-agent');
  });

  it('classifies "why is my agent level 2" as ATC_STATUS', () => {
    assert.strictEqual(classifyIntent('why is my agent level 2').intent, 'ATC_STATUS');
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
