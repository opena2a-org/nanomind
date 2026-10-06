import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ATCIntentHandler } from './index.ts';

const REGISTRY = 'https://registry.test';

const FULL_ATC = {
  agentId: 'acme/agent',
  trustLevel: 3,
  trustScore: 420,
  version: '1.2.0',
  expiresAt: '2027-01-01T00:00:00Z',
  issuerDid: 'did:web:registry.test',
  signatures: [{}, {}],
  scanSummary: { hma: 'passed', criticalFindings: 0, highFindings: 1 },
  buildAttestation: { builder: 'ci' },
  publisherDid: 'did:web:acme.test',
  behavioralProfile: { samples: 10 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ATCIntentHandler', () => {
  it('requests the ATX path for the encoded agent id without auth by default', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    await handler.getTrustLevel('acme/agent');

    assert.strictEqual(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(url, `${REGISTRY}/api/v1/atx/acme%2Fagent`);
    assert.deepStrictEqual(init.headers, { Accept: 'application/json' });
  });

  it('sends the API key as a bearer token when one is configured', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY, apiKey: 'test-key' });

    await handler.getTrustLevel('acme/agent');

    const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual((init.headers as Record<string, string>).Authorization, 'Bearer test-key');
  });

  it('summarises the ATC and counts its signatures', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    const summary = await handler.getTrustLevel('acme/agent');

    assert.deepStrictEqual(summary, {
      agentId: 'acme/agent',
      trustLevel: 3,
      trustScore: 420,
      version: '1.2.0',
      expiresAt: '2027-01-01T00:00:00Z',
      issuerDid: 'did:web:registry.test',
      signatureCount: 2,
      scanSummary: { hma: 'passed', criticalFindings: 0, highFindings: 1 },
    });
  });

  it('returns null when the registry answers with an error status', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'not found' }, 404));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    assert.strictEqual(await handler.getTrustLevel('acme/missing'), null);
  });

  it('returns null when the registry cannot be reached', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    assert.strictEqual(await handler.getTrustLevel('acme/agent'), null);
  });

  it('serves a repeat query from the cache within the TTL', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    await handler.getTrustLevel('acme/agent');
    await handler.explainTrustLevel('acme/agent');

    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  it('queries the registry again once the cached entry has expired', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY, cacheTTLMs: -1 });

    await handler.getTrustLevel('acme/agent');
    await handler.getTrustLevel('acme/agent');

    assert.strictEqual(fetchMock.mock.callCount(), 2);
  });

  it('explains an ATC with every factor present', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    const explanation = await handler.explainTrustLevel('acme/agent');

    assert.strictEqual(explanation.currentLevel, 3);
    assert.strictEqual(explanation.currentScore, 420);
    assert.strictEqual(explanation.projectedScore, 500);
    assert.strictEqual(explanation.projectedLevel, 4);
    assert.ok(explanation.factors.every(f => f.status === 'present' && f.fix === ''));
    assert.ok(explanation.summary.startsWith('Your agent acme/agent is trust level 3 because:'));
    assert.ok(!explanation.summary.includes('Missing:'));
  });

  it('marks a failed scan and a single signature as partial, with a fix for each', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      jsonResponse({
        agentId: 'acme/agent',
        trustLevel: 1,
        trustScore: 40,
        signatures: [{}],
        scanSummary: { hma: 'failed', criticalFindings: 2, highFindings: 0 },
        publisherDid: 'did:web:acme.test',
      }),
    );
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    const explanation = await handler.explainTrustLevel('acme/agent');
    const byName = Object.fromEntries(explanation.factors.map(f => [f.name, f]));

    assert.strictEqual(byName['HMA scan'].status, 'partial');
    assert.strictEqual(byName['Threshold signatures'].status, 'partial');
    assert.strictEqual(byName['Build attestation'].status, 'missing');
    assert.strictEqual(byName['Runtime behavioral data'].status, 'missing');
    assert.strictEqual(byName['Publisher verified'].status, 'present');
    assert.ok(explanation.factors.filter(f => f.status !== 'present').every(f => f.fix !== ''));
    assert.strictEqual(explanation.projectedScore, 40);
    assert.strictEqual(explanation.projectedLevel, 1);
    assert.ok(explanation.summary.includes('Missing: HMA scan'));
  });

  it('explains how to get started when the registry has no ATC', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, 404));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    const explanation = await handler.explainTrustLevel('acme/new');

    assert.strictEqual(explanation.currentLevel, 0);
    assert.strictEqual(explanation.currentScore, 0);
    assert.strictEqual(explanation.projectedScore, 0);
    assert.strictEqual(explanation.projectedLevel, 1);
    assert.ok(explanation.factors.every(f => f.status === 'missing'));
    assert.ok(explanation.summary.startsWith('No ATC found for agent acme/new. To get started:'));
  });
});
