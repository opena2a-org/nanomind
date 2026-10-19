import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ATCIntentHandler, ATCLookupError } from './index.ts';

const REGISTRY = 'https://registry.test';

// A registry on 127.0.0.1 that records each request and hands its response to
// `answer`, which may leave it unanswered. Closed, with every connection it
// holds, when the test ends.
async function localRegistry(
  t: TestContext,
  answer: (res: ServerResponse) => void,
): Promise<{ address: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    answer(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

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

  // The test timeout ends a lookup that never settles, so a hang fails these tests.
  it('throws a lookup error that names the time it waited when the registry takes the request and never answers', { timeout: 10_000 }, async (t) => {
    const registry = await localRegistry(t, () => {});
    const handler = new ATCIntentHandler({ registryUrl: registry.address, timeoutMs: 100 });
    const message = `Could not look up agent "acme/agent": the registry at ${registry.address} did not answer within 0.1 seconds.`;

    await assert.rejects(handler.getTrustLevel('acme/agent'), (err: unknown) => {
      assert.ok(err instanceof ATCLookupError, String(err));
      assert.strictEqual(err.message, message);
      assert.strictEqual(err.status, undefined);
      assert.strictEqual((err.cause as Error)?.name, 'TimeoutError');
      return true;
    });
    // In place of the how-to-get-started summary.
    await assert.rejects(handler.explainTrustLevel('acme/agent'), { name: 'ATCLookupError', message });
    assert.deepStrictEqual(registry.requests, ['GET /api/v1/atx/acme%2Fagent', 'GET /api/v1/atx/acme%2Fagent']);
  });

  it('throws a lookup error when the registry answers with a status and never finishes the body', { timeout: 10_000 }, async (t) => {
    const registry = await localRegistry(t, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"agentId":');
    });
    const handler = new ATCIntentHandler({ registryUrl: registry.address, timeoutMs: 1000 });

    await assert.rejects(handler.getTrustLevel('acme/agent'), (err: unknown) => {
      assert.ok(err instanceof ATCLookupError, String(err));
      assert.strictEqual(
        err.message,
        `Could not look up agent "acme/agent": the registry at ${registry.address} answered with status 200 but did not finish its answer within 1 second.`,
      );
      assert.strictEqual(err.status, 200);
      assert.strictEqual((err.cause as Error)?.name, 'TimeoutError');
      return true;
    });
  });

  it('refuses a timeoutMs that is not a whole number of milliseconds from 0 to 2147483647 when the handler is made', () => {
    const accepted = 'timeoutMs must be a whole number of milliseconds from 0 to 2147483647';
    const refused: [unknown, string, string][] = [
      [1500.5, 'RangeError', `${accepted}, received 1500.5`],
      [Infinity, 'RangeError', `${accepted}, received Infinity`],
      [NaN, 'RangeError', `${accepted}, received NaN`],
      [-1, 'RangeError', `${accepted}, received -1`],
      // AbortSignal.timeout takes these two, but sets the timeout to 1 millisecond.
      [2147483648, 'RangeError', `${accepted}, received 2147483648`],
      [4294967295, 'RangeError', `${accepted}, received 4294967295`],
      [4294967296, 'RangeError', `${accepted}, received 4294967296`],
      ['300', 'TypeError', `${accepted}, received the string "300"`],
      [true, 'TypeError', `${accepted}, received a value of type boolean`],
    ];
    for (const [timeoutMs, name, message] of refused) {
      assert.throws(
        () => new ATCIntentHandler({ registryUrl: REGISTRY, timeoutMs: timeoutMs as number }),
        { name, message },
        `timeoutMs ${String(timeoutMs)}`,
      );
    }
  });

  it('makes a handler with a timeoutMs of 0', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(FULL_ATC));
    const handler = new ATCIntentHandler({ registryUrl: REGISTRY, timeoutMs: 0 });

    assert.strictEqual((await handler.getTrustLevel('acme/agent'))?.trustLevel, 3);
  });

  it('waits for a registry that answers after 50 ms with the longest timeoutMs, 2147483647', { timeout: 10_000 }, async (t) => {
    const registry = await localRegistry(t, (res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FULL_ATC));
      }, 50);
    });
    const handler = new ATCIntentHandler({ registryUrl: registry.address, timeoutMs: 2147483647 });

    assert.strictEqual((await handler.getTrustLevel('acme/agent'))?.trustLevel, 3);
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

describe('ATCLookupError', () => {
  // The text with each run of whitespace made one space, so a sentence reads
  // the same wherever its lines break.
  const oneSpace = (text: string) => text.replace(/\s+/g, ' ').trim();

  it('documents status as the README does: undefined when the registry sent no status, as for a lookup the registry took and never answered', { timeout: 10_000 }, async (t) => {
    const registry = await localRegistry(t, () => {});
    const handler = new ATCIntentHandler({ registryUrl: registry.address, timeoutMs: 100 });

    await assert.rejects(handler.getTrustLevel('a'), (err: unknown) => {
      assert.ok(err instanceof ATCLookupError, String(err));
      assert.strictEqual(err.status, undefined);
      return true;
    });
    assert.deepStrictEqual(registry.requests, ['GET /api/v1/atx/a']);

    // The doc comment on status, which tsc copies into dist/index.d.ts, with its comment prefixes dropped.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const comment = source.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*readonly status\b/)?.[1];
    assert.ok(comment, 'index.ts has a doc comment on ATCLookupError.status');
    const doc = oneSpace(comment.replace(/^\s*\*\s?/gm, ''));
    const readme = oneSpace(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
    const stated = readme.match(/`status`, which is (undefined when [^.]+)\./)?.[1];
    assert.ok(stated, 'README.md says when status is undefined');
    assert.ok(doc.includes(stated), `The doc comment on status does not say "${stated}", as README.md does: ${doc}`);
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
