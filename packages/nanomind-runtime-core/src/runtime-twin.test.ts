/**
 * Unit tests for @nanomind/runtime-core. These exercise the RuntimeTwin
 * class in isolation from any ARP integration and are deliberately
 * standalone: the package has no dependency on hackmyagent, and the
 * tests use a minimal EventEngineLike stub.
 *
 * No test in this repository runs the twin inside a real ARP EventEngine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

// === Gradient submission ===
//
// These tests replace globalThis.fetch, so no gradient leaves the machine,
// and point HOME at a temporary directory, because processEvent appends
// each event to ~/.opena2a/arp/events.jsonl.

type BehavioralEventInput = Parameters<RuntimeTwin['processEvent']>[0];

// The registry refuses a gradient whose L2 norm exceeds 1.0 by more than 1e-9.
const REGISTRY_NORM_LIMIT = 1.0 + 1e-9;

// Gaussian-mechanism sigma for L2 sensitivity 1, epsilon 1.0 and delta 1e-5.
const SIGMA = Math.sqrt(2 * Math.log(1.25 / 1e-5));

function l2Norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((s, g) => s + g * g, 0));
}

function assertClose(actual: number[], expected: number[], tolerance = 1e-12): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(
      Math.abs(value - expected[i]) <= tolerance,
      `coordinate ${i}: ${value} should be within ${tolerance} of ${expected[i]}`,
    );
  });
}

function behavioralEvent(overrides: Partial<BehavioralEventInput> = {}): BehavioralEventInput {
  return {
    agentId: 'gradient-agent',
    sessionId: 'gradient-session',
    sequenceNum: 1,
    eventType: 'TOOL_CALL',
    capability: 'db:read',
    toolName: null,
    argHash: '0000000000000000',
    timestampDelta: 100,
    wallClock: Date.now(),
    responseSize: 0,
    responseCode: 0,
    l0Decision: 'allow',
    ...overrides,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Run `drive` against a twin with fleetEnabled and return the
 * gradientVector of each request the twin posted meanwhile.
 */
async function capturePostedGradients(
  drive: (twin: RuntimeTwin) => Promise<void>,
): Promise<number[][]> {
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-twin-'));
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await drive(new RuntimeTwin('gradient-agent', { fleetEnabled: true }));
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv('HOME', realHome);
    restoreEnv('USERPROFILE', realUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
  return bodies.map(body => JSON.parse(body).gradientVector);
}

/** Call shutdown() with Math.random returning `value` on each call. */
async function shutdownWithRandom(twin: RuntimeTwin, value: number): Promise<void> {
  const realRandom = Math.random;
  Math.random = () => value;
  try {
    await twin.shutdown();
  } finally {
    Math.random = realRandom;
  }
}

test('gradients posted at shutdown stay within the registry L2 norm bound of 1', async () => {
  const gradients = await capturePostedGradients(async twin => {
    for (let round = 0; round < 50; round++) {
      // An error on each event averages to 1 in two dimensions, so the
      // gradient is also above the bound before the noise.
      for (let i = 0; i < 5; i++) twin.processEvent(behavioralEvent({ responseCode: 1 }));
      await twin.shutdown();
    }
  });
  assert.equal(gradients.length, 50);
  for (const gradient of gradients) {
    assert.equal(gradient.length, 9);
    const norm = l2Norm(gradient);
    assert.ok(norm <= REGISTRY_NORM_LIMIT, `L2 norm ${norm} should be at most 1`);
  }
});

test('a noised gradient above L2 norm 1 is divided by its norm before it is posted', async () => {
  const gradients = await capturePostedGradients(async twin => {
    for (let i = 0; i < 4; i++) twin.processEvent(behavioralEvent());
    await shutdownWithRandom(twin, 0.5);
  });
  // Four TOOL_CALL events average to 1 in dimension 0. With Math.random
  // pinned at 0.5, the Box-Muller draw is the same z for each coordinate.
  const z = Math.sqrt(-2 * Math.log(0.5)) * Math.cos(2 * Math.PI * 0.5);
  const noised = [1, 0, 0, 0, 0, 0, 0, 0, 0].map(g => g + SIGMA * z);
  assert.ok(l2Norm(noised) > 1, 'the noised gradient should be above the bound');
  assert.equal(gradients.length, 1);
  assertClose(gradients[0], noised.map(g => g / l2Norm(noised)));
});

test('a noised gradient within L2 norm 1 is posted unchanged', async () => {
  const gradients = await capturePostedGradients(async twin => {
    twin.processEvent(behavioralEvent({ eventType: 'TOOL_CALL' }));
    twin.processEvent(behavioralEvent({ eventType: 'MCP_CALL' }));
    await shutdownWithRandom(twin, 0.25);
  });
  // With Math.random pinned at 0.25, cos(2 * pi * 0.25) is about 6e-17,
  // so the noise on each coordinate is below 1e-15. One TOOL_CALL and one
  // MCP_CALL average to 0.5 in dimensions 0 and 2, an L2 norm of about
  // 0.707, which is posted as it is rather than scaled up to 1.
  assert.equal(gradients.length, 1);
  assertClose(gradients[0], [0.5, 0, 0.5, 0, 0, 0, 0, 0, 0]);
});
