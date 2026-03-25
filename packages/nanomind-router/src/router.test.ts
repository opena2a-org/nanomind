import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyIntent, mapToCommand, isATCIntent } from './index';

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
});
