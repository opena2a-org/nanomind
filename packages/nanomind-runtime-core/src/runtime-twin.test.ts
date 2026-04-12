/**
 * Unit tests for @nanomind/runtime-core. These exercise the RuntimeTwin
 * class in isolation from any ARP integration and are deliberately
 * standalone: the package has no dependency on hackmyagent, and the
 * tests use a minimal EventEngineLike stub.
 *
 * The 6 integration tests in hackmyagent/src/arp/intelligence/
 * runtime-twin.test.ts continue to exercise the twin inside a real
 * ARP EventEngine. Those remain the authoritative integration coverage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeTwin,
  type ARPEventInput,
  type EventEngineLike,
} from './index.ts';

function makeEvent(overrides: Partial<ARPEventInput> = {}): ARPEventInput {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    source: 'process',
    category: 'normal',
    severity: 'info',
    description: 'test event',
    data: { capability: 'db:read', ...(overrides.data ?? {}) },
    ...overrides,
  };
}

test('constructs with default config', () => {
  const twin = new RuntimeTwin('unit-test-agent');
  assert.ok(twin, 'twin should construct');
});

test('attach is a no-op when disabled', () => {
  const twin = new RuntimeTwin('disabled-agent', { enabled: false });
  const calls: Array<(e: ARPEventInput) => void> = [];
  const engine: EventEngineLike = {
    onEvent(cb) {
      calls.push(cb);
    },
  };
  twin.attach(engine);
  assert.equal(calls.length, 0, 'onEvent should not be registered when disabled');
});

test('attach registers a handler when enabled', () => {
  const twin = new RuntimeTwin('enabled-agent');
  const calls: Array<(e: ARPEventInput) => void> = [];
  const engine: EventEngineLike = {
    onEvent(cb) {
      calls.push(cb);
    },
  };
  twin.attach(engine);
  assert.equal(calls.length, 1, 'onEvent should be registered once when enabled');
});

test('scoreARPEvent returns null before baseline trains', () => {
  const twin = new RuntimeTwin('cold-agent');
  const result = twin.scoreARPEvent(makeEvent());
  assert.equal(result, null, 'cold twin should return null');
});

test('scoreARPEvent returns null when disabled', () => {
  const twin = new RuntimeTwin('off-agent', { enabled: false });
  const result = twin.scoreARPEvent(makeEvent());
  assert.equal(result, null, 'disabled twin should return null');
});

test('scoreARPEvent returns a scored result after baseline install', () => {
  const twin = new RuntimeTwin('warm-agent');
  // Install a baseline directly via the test seam so we do not need to
  // push 100 events through the mutating path.
  twin._setBaselineForTest({
    eventTypeCounts: { TOOL_CALL: 200 },
    avgTimingDelta: 100,
    stdTimingDelta: 20,
    capabilitySet: new Set(['db:read', 'db:write']),
    avgResponseSize: 512,
    totalEvents: 200,
    errorRate: 0.0,
  });

  const benign = twin.scoreARPEvent(makeEvent());
  assert.ok(benign, 'warm twin should return a result');
  assert.ok(benign.score >= 0 && benign.score <= 1, 'score should be in [0, 1]');
  assert.ok(['allow', 'alert', 'throttle', 'suspend', 'kill'].includes(benign.action));
});

test('unknown capability lifts anomaly score', () => {
  const twin = new RuntimeTwin('anomaly-agent');
  twin._setBaselineForTest({
    eventTypeCounts: { TOOL_CALL: 500 },
    avgTimingDelta: 100,
    stdTimingDelta: 20,
    capabilitySet: new Set(['db:read']),
    avgResponseSize: 512,
    totalEvents: 500,
    errorRate: 0.0,
  });

  const unknown = twin.scoreARPEvent(
    makeEvent({ data: { capability: 'admin:delete_all' } }),
  );
  assert.ok(unknown, 'should return a result');
  // The baseline does not know 'admin:delete_all', so the capability
  // novelty rule adds 0.3 to the score.
  assert.ok(unknown.score >= 0.3, `score ${unknown.score} should be at least 0.3`);
});

test('threat category lifts anomaly score via l0Decision alert path', () => {
  const twin = new RuntimeTwin('threat-agent');
  twin._setBaselineForTest({
    eventTypeCounts: { TOOL_CALL: 500 },
    avgTimingDelta: 100,
    stdTimingDelta: 20,
    capabilitySet: new Set(['db:read']),
    avgResponseSize: 512,
    totalEvents: 500,
    errorRate: 0.0,
  });

  const threatEvent = twin.scoreARPEvent(
    makeEvent({
      category: 'threat',
      severity: 'critical',
      data: { capability: 'db:read' },
    }),
  );
  assert.ok(threatEvent, 'should return a result');
  // l0Decision resolves to 'alert' on category='threat', adding 0.15.
  assert.ok(threatEvent.score >= 0.15, `score ${threatEvent.score} should be at least 0.15`);
});
