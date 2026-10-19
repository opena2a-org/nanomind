import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ATCIntentHandler, ATCLookupError } from './index.ts';

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

  it('returns null when the registry answers 404, that it has no ATC for the agent', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'not found' }, 404));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    assert.strictEqual(await handler.getTrustLevel('acme/missing'), null);
  });

  it('throws a lookup error that names the registry and the status for an error status other than 404', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch');
    for (const status of [500, 503, 403]) {
      fetchMock.mock.mockImplementation(async () => jsonResponse({ error: 'unavailable' }, status));
      const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

      await assert.rejects(handler.getTrustLevel('acme/agent'), (err: unknown) => {
        assert.ok(err instanceof ATCLookupError, String(err));
        assert.strictEqual(
          err.message,
          `Could not look up agent "acme/agent": the registry at ${REGISTRY} answered with status ${status}.`,
        );
        assert.strictEqual(err.name, 'ATCLookupError');
        assert.strictEqual(err.agentId, 'acme/agent');
        assert.strictEqual(err.registryUrl, REGISTRY);
        assert.strictEqual(err.status, status);
        return true;
      });
    }
  });

  it('throws a lookup error that names the registry and the cause when the registry cannot be reached', async (t) => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND registry.test'), { code: 'ENOTFOUND' });
    // Node's fetch to a host with several addresses fails with an AggregateError that has a code and no message.
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    const cases = [
      { error: new TypeError('fetch failed', { cause: notFound }), reason: 'fetch failed: getaddrinfo ENOTFOUND registry.test' },
      { error: new TypeError('fetch failed', { cause: refused }), reason: 'fetch failed: ECONNREFUSED' },
      { error: new TypeError('fetch failed'), reason: 'fetch failed' },
    ];
    const fetchMock = t.mock.method(globalThis, 'fetch');
    for (const { error, reason } of cases) {
      fetchMock.mock.mockImplementation(async () => {
        throw error;
      });
      const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

      await assert.rejects(handler.getTrustLevel('acme/agent'), (err: unknown) => {
        assert.ok(err instanceof ATCLookupError, String(err));
        assert.strictEqual(
          err.message,
          `Could not look up agent "acme/agent": the registry at ${REGISTRY} could not be reached (${reason}).`,
        );
        assert.strictEqual(err.status, undefined);
        assert.strictEqual(err.cause, error);
        return true;
      });
    }
  });

  it('throws a lookup error when the registry answers with a body that is not JSON', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      new Response('<html>sign in to continue</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    await assert.rejects(handler.getTrustLevel('acme/agent'), (err: unknown) => {
      assert.ok(err instanceof ATCLookupError, String(err));
      assert.strictEqual(
        err.message,
        `Could not look up agent "acme/agent": the registry at ${REGISTRY} answered with status 200 and a body that could not be read as JSON.`,
      );
      assert.strictEqual(err.status, 200);
      assert.ok(err.cause instanceof SyntaxError, String(err.cause));
      return true;
    });
  });

  it('queries the registry again after a failed lookup and after a 404', async (t) => {
    const answers = [jsonResponse({}, 500), jsonResponse({}, 404), jsonResponse(FULL_ATC)];
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => answers.shift());
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    await assert.rejects(handler.getTrustLevel('acme/agent'), ATCLookupError);
    assert.strictEqual(await handler.getTrustLevel('acme/agent'), null);
    assert.strictEqual((await handler.getTrustLevel('acme/agent'))?.trustLevel, 3);
    assert.strictEqual(fetchMock.mock.callCount(), 3);
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
    assert.strictEqual(explanation.projectedScore, 500);
    assert.strictEqual(explanation.projectedLevel, 4);
    assert.ok(explanation.summary.includes('Missing: HMA scan'));
  });

  it('projects the score after fixes as the present points plus the missing points', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ trustLevel: 2, scanSummary: { hma: 'passed' }, signatures: [{}, {}] }),
    );
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    const explanation = await handler.explainTrustLevel('billing-agent');

    assert.strictEqual(explanation.currentLevel, 2);
    assert.strictEqual(explanation.currentScore, 0);
    assert.deepStrictEqual(
      explanation.factors.filter(f => f.status === 'present').map(f => f.name),
      ['HMA scan', 'Threshold signatures'],
    );
    assert.strictEqual(explanation.projectedScore, 500);
    assert.strictEqual(explanation.projectedLevel, 4);
    assert.ok(
      explanation.summary.endsWith('\n  Projected level 4 after fixes: 500 pts (230 present + 270 from fixes)'),
      explanation.summary,
    );
  });

  it('explains how to get started when the registry has no ATC', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, 404));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

    const explanation = await handler.explainTrustLevel('acme/new');

    assert.strictEqual(explanation.currentLevel, 0);
    assert.strictEqual(explanation.currentScore, 0);
    assert.strictEqual(explanation.projectedScore, 500);
    assert.strictEqual(explanation.projectedLevel, 4);
    assert.ok(explanation.factors.every(f => f.status === 'missing'));
    assert.ok(explanation.summary.startsWith('No ATC found for agent acme/new. To get started:'));
  });

  it('throws the lookup error, not the how-to-get-started summary, when the registry could not answer', async (t) => {
    const cases = [
      { answer: async () => jsonResponse({}, 500), reason: 'answered with status 500' },
      {
        answer: async () => new Response('not json', { status: 200 }),
        reason: 'answered with status 200 and a body that could not be read as JSON',
      },
      {
        answer: async (): Promise<Response> => {
          throw new TypeError('fetch failed');
        },
        reason: 'could not be reached (fetch failed)',
      },
    ];
    const fetchMock = t.mock.method(globalThis, 'fetch');
    for (const { answer, reason } of cases) {
      fetchMock.mock.mockImplementation(answer);
      const handler = new ATCIntentHandler({ registryUrl: REGISTRY });

      await assert.rejects(handler.explainTrustLevel('acme/agent'), {
        name: 'ATCLookupError',
        message: `Could not look up agent "acme/agent": the registry at ${REGISTRY} ${reason}.`,
      });
    }
  });
});

describe('test script', () => {
  // The options Node reads from a `node ...` script: every token after `node` up to
  // the first argument that is not an option. Node does not read later tokens as options.
  function nodeOptions(script: string): string[] {
    const [, ...args] = script.split(' ');
    const end = args.findIndex(arg => !arg.startsWith('-') || arg === '--');
    return end === -1 ? args : args.slice(0, end);
  }

  it('counts only the options that come before the test file pattern', () => {
    assert.deepStrictEqual(nodeOptions('node --test src/**/*.test.ts --experimental-strip-types'), ['--test']);
    assert.deepStrictEqual(
      nodeOptions('node --test --experimental-strip-types src/**/*.test.ts'),
      ['--test', '--experimental-strip-types'],
    );
  });

  it('loads the TypeScript sources on a Node release that leaves type stripping off', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const nodeFlags = nodeOptions(pkg.scripts.test).filter(arg => arg !== '--test');

    // Node 22 before 22.18 does not strip types by default; a flag in the script overrides NODE_OPTIONS.
    const run = spawnSync(process.execPath, [...nodeFlags, fileURLToPath(new URL('./index.ts', import.meta.url))], {
      env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' },
      encoding: 'utf8',
    });

    assert.strictEqual(run.status, 0, run.stderr);
  });
});
