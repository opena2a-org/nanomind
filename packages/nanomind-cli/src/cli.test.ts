import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SkillAdapter } from './adapt';
import { SessionManager } from './session';
import { generateArtifact, listArtifactTypes, detectArtifactType } from './codegen';

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
