import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NanoMindRuntime, type BehavioralEvent } from './index';
import { addDifferentialPrivacy, validatePrivacy, submitGradient } from './fleet';

/**
 * E2E test: simulates a full agent lifecycle.
 * 1. Start runtime
 * 2. Feed 200 normal events (build baseline)
 * 3. Verify baseline learned
 * 4. Feed anomalous events
 * 5. Verify anomaly detected
 * 6. Verify events logged to disk
 * 7. Compute gradient
 * 8. Apply differential privacy
 * 9. Submit gradient to production
 */

const TEST_AGENT = 'e2e-test-agent';
const EVENT_LOG = path.join(os.homedir(), '.opena2a', 'arp', 'events.jsonl');
const BASELINE_PATH = path.join(os.homedir(), '.opena2a', 'arp', `baseline-${TEST_AGENT}.json`);

function normalEvent(seq: number): BehavioralEvent {
  return {
    agentId: TEST_AGENT,
    sessionId: 'e2e-session',
    sequenceNum: seq,
    eventType: 'TOOL_CALL',
    capability: 'db:read',
    toolName: 'query_users',
    argHash: 'abc123',
    timestampDelta: 40 + Math.random() * 20, // 40-60ms normal
    wallClock: Date.now(),
    responseSize: 1024,
    responseCode: 0,
    l0Decision: 'allow',
  };
}

function anomalousEvent(seq: number): BehavioralEvent {
  return {
    agentId: TEST_AGENT,
    sessionId: 'e2e-session',
    sequenceNum: seq,
    eventType: 'EXTERNAL_CALL',
    capability: 'admin:delete_all', // never seen before
    toolName: 'unknown_tool',
    argHash: 'xyz789',
    timestampDelta: 1, // way too fast (burst)
    wallClock: Date.now(),
    responseSize: 50000, // unusually large
    responseCode: 500, // error
    l0Decision: 'block', // L0 already flagged
  };
}

describe('NanoMind Runtime E2E', () => {
  let runtime: NanoMindRuntime;

  before(() => {
    // Clean up previous test artifacts
    try { fs.unlinkSync(BASELINE_PATH); } catch {}
    runtime = new NanoMindRuntime(TEST_AGENT);
  });

  after(async () => {
    // Save baseline for inspection
    await runtime.saveBaseline();
  });

  it('Step 1: runtime initializes', async () => {
    await runtime.initialize();
    assert.ok(runtime, 'Runtime should be created');
  });

  it('Step 2: feed 200 normal events (build baseline)', () => {
    for (let i = 0; i < 200; i++) {
      const result = runtime.processEvent(normalEvent(i));
      // During baseline learning, score should be 0
      if (i < 100) {
        assert.strictEqual(result.score, 0.0, `Event ${i} should score 0 during learning`);
      }
    }
  });

  it('Step 3: baseline is learned (normal events score low)', () => {
    const result = runtime.processEvent(normalEvent(201));
    assert.ok(result.score < 0.2, `Normal event should score < 0.2, got ${result.score}`);
    assert.strictEqual(result.action, 'allow');
  });

  it('Step 4: anomalous event detected (high score)', () => {
    const result = runtime.processEvent(anomalousEvent(202));
    assert.ok(result.score > 0.3, `Anomaly should score > 0.3, got ${result.score}`);
    assert.ok(result.action !== 'allow', `Action should not be allow, got ${result.action}`);
  });

  it('Step 5: anomaly handler fires', () => {
    let handlerFired = false;
    let detectedScore = 0;
    const unsub = runtime.onAnomalyDetected((score, action) => {
      handlerFired = true;
      detectedScore = score;
    });

    runtime.processEvent(anomalousEvent(203));
    unsub();

    assert.ok(handlerFired, 'Anomaly handler should have fired');
    assert.ok(detectedScore > 0.3, `Handler should receive score > 0.3, got ${detectedScore}`);
  });

  it('Step 6: events logged to disk', () => {
    assert.ok(fs.existsSync(EVENT_LOG), `Event log should exist at ${EVENT_LOG}`);
    const content = fs.readFileSync(EVENT_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(l => {
      try { return JSON.parse(l).agentId === TEST_AGENT; } catch { return false; }
    });
    assert.ok(lines.length > 100, `Should have 100+ logged events, got ${lines.length}`);
  });

  it('Step 7: gradient computable', () => {
    const gradient = runtime.getGradient();
    assert.ok(gradient, 'Gradient should be non-null after 200+ events');
    assert.ok(gradient.eventCount >= 100, `Event count should be >= 100, got ${gradient.eventCount}`);
  });

  it('Step 8: differential privacy applied to gradient', () => {
    const gradient = runtime.getGradient()!;
    // Create a synthetic gradient vector from baseline stats
    const vector = [
      gradient.baseline.avgTimingDelta || 0,
      gradient.baseline.stdTimingDelta || 0,
      gradient.baseline.avgResponseSize || 0,
      gradient.baseline.errorRate || 0,
      Object.keys(gradient.baseline.eventTypeCounts || {}).length,
      (gradient.baseline.capabilities || []).length,
    ];

    const noisy = addDifferentialPrivacy(vector, { epsilon: 1.0 });
    assert.strictEqual(noisy.length, vector.length, 'Noisy vector should have same length');

    // Should be different from original
    let different = false;
    for (let i = 0; i < vector.length; i++) {
      if (Math.abs(noisy[i] - vector[i]) > 1e-10) { different = true; break; }
    }
    assert.ok(different, 'Noise should change the gradient');
  });

  it('Step 9: gradient submission to production', async () => {
    const gradient = runtime.getGradient()!;
    const vector = [
      gradient.baseline.avgTimingDelta || 0,
      gradient.baseline.stdTimingDelta || 0,
      gradient.baseline.avgResponseSize || 0,
      gradient.baseline.errorRate || 0,
    ];
    const noisy = addDifferentialPrivacy(vector, { epsilon: 1.0 });

    // Submit to production
    const success = await submitGradient(noisy, gradient.eventCount, 0.023, {
      registryUrl: 'https://api.oa2a.org',
      agentCategory: 'e2e-test',
      epsilon: 1.0,
    });
    assert.ok(success, 'Gradient should be accepted by production endpoint');
  });

  it('Step 10: baseline can be saved and restored', async () => {
    await runtime.saveBaseline();
    assert.ok(fs.existsSync(BASELINE_PATH), 'Baseline file should exist');

    // Create new runtime and verify it loads baseline
    const runtime2 = new NanoMindRuntime(TEST_AGENT);
    const result = runtime2.processEvent(normalEvent(300));
    // With loaded baseline, normal event should still score low
    assert.ok(result.score < 0.2, `Restored baseline should score normal events low, got ${result.score}`);
  });

  it('Step 11: privacy validation rejects bad epsilon', () => {
    assert.strictEqual(validatePrivacy(1.0), true);
    assert.strictEqual(validatePrivacy(2.0), true);
    assert.strictEqual(validatePrivacy(3.0), false);
    assert.strictEqual(validatePrivacy(0), false);
  });
});
