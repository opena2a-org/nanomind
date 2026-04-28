import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NanoMindDaemon } from './server.ts';
import { OnnxEngine } from './onnx-engine.ts';

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

  it('should reject empty input on /v1/infer (Bug 2 H2)', async () => {
    for (const payload of [
      { intent: 'INTENT_CHECK', input: '' },
      { intent: 'INTENT_CHECK', input: '   ' },
      { intent: 'INTENT_CHECK', input: '\t\n\r' },
    ]) {
      const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.strictEqual(resp.status, 400, `payload ${JSON.stringify(payload)} must 400`);
      const body = await resp.json() as { error: string };
      assert.strictEqual(body.error, 'invalid_request');
    }
  });

  it('should preserve Bug 1 contract on inference error path (Bug 2 M2)', async () => {
    // Stub engine that throws — simulates ORT failure / file IO failure /
    // tokenizer error. Response must STILL carry attackClass:"" so AIM FGA's
    // typed JSON unmarshal lands on a defined value, not Go's zero-value
    // by-accident path that Bug 1 was filed to fix.
    (daemon as unknown as { engine: { ensureReady(): Promise<void>; infer(): Promise<unknown>; modelVersion?: string } }).engine = {
      ensureReady: async () => {},
      infer: async () => { throw new Error('simulated ORT failure'); },
      modelVersion: 'test-engine',
    };
    (daemon as unknown as { modelLoaded: boolean }).modelLoaded = true;

    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'INTENT_CHECK', input: 'list secrets' }),
    });
    assert.strictEqual(resp.status, 500);
    const body = await resp.json() as {
      error: string;
      message: string;
      attackClass: string;
      confidence: number;
      latencyMs: number;
    };
    assert.strictEqual(body.error, 'inference_error');
    assert.strictEqual(body.attackClass, '', '500 response must carry attackClass:"" per Bug 1 contract');
    assert.strictEqual(typeof body.confidence, 'number', '500 response must carry confidence as number');
  });
});

/**
 * Acceptance test for Bug 2 (ONNX swap). Runs the real OnnxEngine against
 * 10 deterministically-sampled `injection`-labeled strings from the local
 * training corpus and asserts ≥7 produce a non-empty `attackClass`.
 *
 * Skips cleanly if either the model artifacts or the corpus file are
 * absent. CI runs without ~/.nanomind/models/* available — the test must
 * not fail in that environment. Local dev with the v0.5.0 artifacts
 * downloaded exercises the full path.
 *
 * Note on label provenance: the model was trained on sft-v10 (HF dataset,
 * gated). The local repo only carries sft-v6, so a few samples may be
 * borderline; the ≥7/10 bar accommodates that drift while still proving
 * the engine is producing real classifications and not template spam.
 */
describe('OnnxEngine — prompt-injection corpus smoke', () => {
  const MODELS_DIR = join(homedir(), '.nanomind', 'models');
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const CORPUS = join(HERE, '..', '..', '..', 'training', 'corpus', 'sft-v6', 'eval.json');

  const haveModel = existsSync(join(MODELS_DIR, 'nanomind-tme.onnx')) &&
                    existsSync(join(MODELS_DIR, 'nanomind-tme.onnx.data')) &&
                    existsSync(join(MODELS_DIR, 'tokenizer.json'));
  const haveCorpus = existsSync(CORPUS);

  // Skip when artifacts are missing UNLESS NANOMIND_REQUIRE_MODEL=1 is set
  // (CI sets this once the workflow downloads the v0.5.0 artifacts so a
  // missing-artifact misconfiguration fails the build instead of silently
  // skipping the only test that exercises real inference).
  const requireModel = process.env.NANOMIND_REQUIRE_MODEL === '1';
  const skipReason = !haveModel || !haveCorpus
    ? `requires ~/.nanomind/models/* and training/corpus/sft-v6/eval.json (set NANOMIND_REQUIRE_MODEL=1 to fail instead of skip)`
    : false;
  if (skipReason && requireModel) {
    throw new Error(`NANOMIND_REQUIRE_MODEL=1 set but ${skipReason}`);
  }

  it('classifies ≥7 of 10 injection-labeled corpus samples as non-benign',
     { skip: skipReason },
     async () => {
    const corpus = JSON.parse(readFileSync(CORPUS, 'utf-8')) as { input: string; attackClass: string }[];
    const injection = corpus.filter((d) => d.attackClass === 'injection');
    assert.ok(injection.length >= 10, `expected ≥10 injection samples, got ${injection.length}`);

    // Deterministic sample of 10 — first 10 in source order keeps the test
    // stable across runs without an RNG dependency.
    const samples = injection.slice(0, 10);

    const engine = new OnnxEngine();
    await engine.ensureReady();

    const results = await Promise.all(samples.map((s) => engine.infer(s.input)));
    const nonEmpty = results.filter((r) => r.attackClass !== '');

    assert.ok(
      nonEmpty.length >= 7,
      `expected ≥7/10 to produce non-empty attackClass, got ${nonEmpty.length}/10. ` +
        `Raw labels: ${results.map((r) => r.rawLabel).join(',')}`,
    );

    for (const r of nonEmpty) {
      assert.ok(r.confidence > 0 && r.confidence <= 1, 'confidence must be a probability');
      assert.ok(r.rawLabel.length > 0, 'rawLabel must be set when classification fires');
    }
  });
});
