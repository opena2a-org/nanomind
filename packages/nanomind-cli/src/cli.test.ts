import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SkillAdapter } from './adapt.ts';
import { SessionManager } from './session.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateArtifact, listArtifactTypes, detectArtifactType, artifactTypeFromInput } from './codegen.ts';

describe('SkillAdapter', () => {
  it('defaults to intermediate', () => {
    const adapter = new SkillAdapter();
    assert.strictEqual(adapter.getLevel(), 'intermediate');
  });

  it('infers expert from CLI flags', () => {
    const adapter = new SkillAdapter();
    for (let i = 0; i < 10; i++) {
      adapter.record('hma secure --ci --format json', true);
    }
    assert.strictEqual(adapter.getLevel(), 'expert');
  });

  it('infers beginner from help queries', () => {
    const adapter = new SkillAdapter();
    for (let i = 0; i < 10; i++) {
      adapter.record('what is a credential', false);
      adapter.record('help', false);
    }
    assert.strictEqual(adapter.getLevel(), 'beginner');
  });

  it('formats response by level', () => {
    const adapter = new SkillAdapter();
    const result = adapter.formatResponse('long explanation', 'concise', 'terse');
    assert.strictEqual(result, 'concise'); // default intermediate
  });
});

describe('SessionManager', () => {
  it('starts with empty context', () => {
    const session = new SessionManager();
    const ctx = session.getContext();
    assert.strictEqual(ctx.turnCount, 0);
    assert.strictEqual(ctx.lastCommand, null);
  });

  it('tracks command history', () => {
    const session = new SessionManager();
    session.update('scan .', 'Found 3 issues');
    const ctx = session.getContext();
    assert.strictEqual(ctx.turnCount, 1);
    assert.strictEqual(ctx.lastCommand, 'scan .');
  });

  it('extracts findings from output', () => {
    const session = new SessionManager();
    session.update('scan', '[CRED-001] Hardcoded API key (critical)\n[MCP-003] Open transport (high)');
    const ctx = session.getContext();
    assert.strictEqual(ctx.lastFindings.length, 2);
    assert.strictEqual(ctx.lastFindings[0].id, 'CRED-001');
  });

  it('resolves "the first one" reference', () => {
    const session = new SessionManager();
    session.update('scan', '[CRED-001] Hardcoded API key (critical)');
    const resolved = session.resolveReference('fix the first one');
    assert.ok(resolved.includes('CRED-001'));
  });

  it('resolves "my agent" reference', () => {
    const session = new SessionManager();
    session.update('trust', 'agent: billing-agent\nTrust Level: 3');
    const resolved = session.resolveReference('why is my agent level 2');
    assert.ok(resolved.includes('billing-agent'));
  });

  it('returns the findings of this output and keeps the earlier ones when it lists none', () => {
    const session = new SessionManager();
    const found = session.update('scan', '[CRED-001] Hardcoded API key (critical)\n[SKILL-SEMANTIC-007] Exfiltration pattern (high)');
    assert.deepStrictEqual(found.map((f) => f.id), ['CRED-001', 'SKILL-SEMANTIC-007']);
    assert.strictEqual(found[1].severity, 'high');
    assert.deepStrictEqual(session.update('secure --fix', 'Fixed 1 finding'), []);
    assert.strictEqual(session.getContext().lastFindings[0].id, 'CRED-001');
    assert.strictEqual(session.resolveReference('explain that finding'), 'explain CRED-001');
  });

  it('takes the agent from an "Agent:" line or a "Your agent" sentence, not from a quoted mention', () => {
    const session = new SessionManager();
    session.update('trust', 'No ATC found for agent "x;echo". The agent may not be registered yet.');
    assert.strictEqual(session.getContext().lastAgentId, null);
    session.update('trust', 'Please specify an agent: "what is the trust level of <agent-id>"');
    assert.strictEqual(session.getContext().lastAgentId, null);
    session.update('trust', 'Your agent billing-agent is trust level 2 because:\n  Missing: HMA scan');
    assert.strictEqual(session.getContext().lastAgentId, 'billing-agent');
    session.update('trust', '  Agent: pay.agent.v2\n  Trust Level: 3');
    assert.strictEqual(session.getContext().lastAgentId, 'pay.agent.v2');
    assert.strictEqual(session.resolveReference('why is my agent level 2'), 'why is agent: pay.agent.v2 level 2');
  });
});

describe('CodeGen', () => {
  it('lists 9 artifact types', () => {
    const types = listArtifactTypes();
    assert.strictEqual(types.length, 9);
    assert.ok(types.includes('github-action'));
    assert.ok(types.includes('build-action'));
  });

  it('generates github-action', () => {
    const artifact = generateArtifact('github-action', {
      projectName: 'test-agent',
      projectType: 'mcp_server',
      language: 'typescript',
      publisher: 'acme',
    });
    assert.ok(artifact.includes('hackmyagent'));
    assert.ok(artifact.includes('test-agent'));
    assert.ok(artifact.includes('mcp_server'));
    assert.ok(artifact.includes('acme'));
  });

  it('generates build-action', () => {
    const artifact = generateArtifact('build-action', {
      projectName: 'my-agent',
      projectType: 'a2a_agent',
      language: 'go',
    });
    assert.ok(artifact.includes('opena2a-registry/action'));
    assert.ok(artifact.includes('my-agent'));
  });

  it('generates all 9 types without error', () => {
    const types = listArtifactTypes();
    for (const type of types) {
      const result = generateArtifact(type, {
        projectName: 'test',
        projectType: 'mcp_server',
        language: 'typescript',
      });
      assert.ok(result.length > 0, `${type} should produce non-empty output`);
    }
  });

  it('reads the artifact type named in a request', () => {
    const cases: Array<[string, string | null]> = [
      ['generate a github action', 'github-action'],
      ['generate a github action for trust', 'github-action'],
      ['create a gitlab ci config', 'gitlab-ci'],
      ['set up azure pipelines yaml', 'azure-pipelines'],
      ['generate circleci config', 'circleci'],
      ['make a docker compose config', 'docker-compose'],
      ['generate docker config', 'dockerfile'],
      ['create a pre-commit config', 'pre-commit'],
      ['generate a makefile config', 'makefile'],
      ['create a build action config', 'build-action'],
      ['generate a ci config', null],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(artifactTypeFromInput(input), expected, input);
    }
  });

  it('detects the artifact type from project files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-codegen-'));
    try {
      assert.strictEqual(detectArtifactType(dir), 'github-action');
      fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), '');
      assert.strictEqual(detectArtifactType(dir), 'gitlab-ci');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for unknown type', () => {
    assert.throws(() => {
      generateArtifact('nonexistent' as any, {
        projectName: 'test',
        projectType: 'mcp_server',
        language: 'typescript',
      });
    });
  });
});
