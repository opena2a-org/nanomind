import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NanoMindRuntime, type BehavioralEvent } from './index';

function makeEvent(overrides: Partial<BehavioralEvent> = {}): BehavioralEvent {
  return {
    agentId: 'test-agent',
    sessionId: 'session-1',
    sequenceNum: 1,
    eventType: 'TOOL_CALL',
    capability: 'db:read',
    toolName: 'query',
    argHash: 'abc123',
    timestampDelta: 50,
    wallClock: Date.now(),
    responseSize: 1024,
    responseCode: 0,
    l0Decision: 'allow',
    ...overrides,
  };
}

describe('NanoMindRuntime', () => {
  it('creates with agent ID', () => {
    const runtime = new NanoMindRuntime('test-agent');
    assert.ok(runtime);
  });

  it('returns 0.0 for events during baseline learning', () => {
    const runtime = new NanoMindRuntime('test-agent');
    const result = runtime.processEvent(makeEvent());
    assert.strictEqual(result.score, 0.0);
    assert.strictEqual(result.action, 'allow');
  });

  it('builds baseline from events', () => {
    const runtime = new NanoMindRuntime('baseline-test');
    // Feed 100+ events to build baseline
    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent({
        sequenceNum: i,
        timestampDelta: 40 + Math.random() * 20,
      }));
    }
    // Now score should be non-zero for anomalous events
    const anomalous = runtime.processEvent(makeEvent({
      capability: 'NEVER_SEEN_BEFORE',
      l0Decision: 'block',
      timestampDelta: 1, // way too fast
    }));
    assert.ok(anomalous.score > 0.0, `Expected anomaly score > 0, got ${anomalous.score}`);
  });

  it('detects unknown capability', () => {
    const runtime = new NanoMindRuntime('cap-test');
    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent({ capability: 'db:read' }));
    }
    const result = runtime.processEvent(makeEvent({ capability: 'admin:delete_all' }));
    assert.ok(result.score >= 0.3, `Unknown capability should score >= 0.3, got ${result.score}`);
  });

  it('detects L0 block escalation', () => {
    const runtime = new NanoMindRuntime('l0-test');
    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent());
    }
    const result = runtime.processEvent(makeEvent({ l0Decision: 'block' }));
    assert.ok(result.score >= 0.3, `L0 block should score >= 0.3, got ${result.score}`);
  });

  it('fires anomaly handler on high score', () => {
    const runtime = new NanoMindRuntime('handler-test');
    let fired = false;
    runtime.onAnomalyDetected((score, action) => {
      fired = true;
    });

    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent());
    }
    // Trigger anomaly
    runtime.processEvent(makeEvent({
      capability: 'UNKNOWN',
      l0Decision: 'block',
    }));
    assert.ok(fired, 'Anomaly handler should have fired');
  });

  it('unsubscribes handler', () => {
    const runtime = new NanoMindRuntime('unsub-test');
    let count = 0;
    const unsub = runtime.onAnomalyDetected(() => { count++; });

    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent());
    }
    runtime.processEvent(makeEvent({ capability: 'X', l0Decision: 'block' }));
    assert.ok(count > 0);

    const prevCount = count;
    unsub(); // unsubscribe
    runtime.processEvent(makeEvent({ capability: 'Y', l0Decision: 'block' }));
    assert.strictEqual(count, prevCount, 'Handler should not fire after unsubscribe');
  });

  it('returns gradient for federated learning', () => {
    const runtime = new NanoMindRuntime('gradient-test');
    // Not enough data
    assert.strictEqual(runtime.getGradient(), null);

    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent({ sequenceNum: i }));
    }
    const gradient = runtime.getGradient();
    assert.ok(gradient, 'Should return gradient after 100+ events');
    assert.ok(gradient.eventCount >= 100);
  });

  it('respects offline mode', () => {
    process.env.NANOMIND_OFFLINE = '1';
    const runtime = new NanoMindRuntime('offline-test');
    assert.strictEqual(runtime.isOffline(), true);
    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent());
    }
    assert.strictEqual(runtime.getGradient(), null, 'No gradient in offline mode');
    delete process.env.NANOMIND_OFFLINE;
  });

  it('has sub-2ms latency', () => {
    const runtime = new NanoMindRuntime('perf-test');
    for (let i = 0; i < 200; i++) {
      runtime.processEvent(makeEvent());
    }

    const iterations = 1000;
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      runtime.processEvent(makeEvent({ sequenceNum: 200 + i }));
    }
    const elapsed = Date.now() - start;
    const avgMs = elapsed / iterations;
    assert.ok(avgMs < 2, `Avg latency ${avgMs}ms should be < 2ms`);
  });

  it('caps score at 1.0', () => {
    const runtime = new NanoMindRuntime('cap-score');
    for (let i = 0; i < 150; i++) {
      runtime.processEvent(makeEvent({ capability: 'normal' }));
    }
    // Everything anomalous
    const result = runtime.processEvent(makeEvent({
      capability: 'NEVER_SEEN',
      l0Decision: 'block',
      timestampDelta: 0,
      responseCode: 500,
    }));
    assert.ok(result.score <= 1.0, `Score ${result.score} should be <= 1.0`);
  });
});
