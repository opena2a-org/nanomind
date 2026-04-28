import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { NanoMindDaemon } from './server.ts';

describe('NanoMindDaemon', () => {
  let daemon: NanoMindDaemon;
  const TEST_PORT = 47299; // Use non-default port for tests

  before(async () => {
    daemon = new NanoMindDaemon({
      httpPort: TEST_PORT,
      idleUnloadSeconds: 60,
    });
    await daemon.start();
    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  after(async () => {
    await daemon.stop();
  });

  it('should report status', async () => {
    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/status`);
    assert.strictEqual(resp.status, 200);
    const status = await resp.json() as { running: boolean; port: number };
    assert.strictEqual(status.running, true);
    assert.strictEqual(status.port, TEST_PORT);
  });

  it('should respond to health check', async () => {
    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    assert.strictEqual(resp.status, 200);
    const body = await resp.json() as { running: boolean };
    assert.strictEqual(body.running, true);
  });

  it('should return 404 for unknown routes', async () => {
    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`);
    assert.strictEqual(resp.status, 404);
  });

  it('should reject invalid JSON on /v1/infer', async () => {
    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    assert.strictEqual(resp.status, 400);
    const body = await resp.json() as { error: string };
    assert.strictEqual(body.error, 'invalid_request');
  });

  it('should reject empty request on /v1/infer', async () => {
    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(resp.status, 400);
    const body = await resp.json() as { error: string };
    assert.strictEqual(body.error, 'invalid_request');
  });

  it('should track active tasks correctly', () => {
    const status = daemon.getStatus();
    assert.strictEqual(status.activeTasks, 0);
  });

  it('should have started timestamp', () => {
    const status = daemon.getStatus();
    assert.ok(status.startedAt instanceof Date);
    assert.ok(status.uptime > 0);
  });

  it('should always include attackClass in /v1/infer response (default empty)', async () => {
    // Stub the engine to avoid loading the real model. The contract under test
    // is that handleInfer always emits attackClass; what the engine returns
    // is irrelevant to that contract.
    (daemon as unknown as { engine: { ensureReady(): Promise<void>; infer(p: string, o: unknown): Promise<{ text: string }> }; modelLoaded: boolean }).engine = {
      ensureReady: async () => {},
      infer: async () => ({ text: 'stub-result' }),
    };
    (daemon as unknown as { modelLoaded: boolean }).modelLoaded = true;

    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'INTENT_CHECK', input: 'list secrets' }),
    });
    assert.strictEqual(resp.status, 200);
    const body = await resp.json() as {
      intent: string;
      result: string;
      confidence: number;
      attackClass: string;
      latencyMs: number;
      modelVersion: string;
    };
    assert.ok('attackClass' in body, 'response must always include attackClass field');
    assert.strictEqual(typeof body.attackClass, 'string', 'attackClass must be a string');
    assert.strictEqual(body.attackClass, '', 'attackClass defaults to empty until the production classifier ships');
    assert.strictEqual(typeof body.confidence, 'number');
  });
});
