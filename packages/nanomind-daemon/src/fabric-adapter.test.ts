import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { BaseFabricAdapter } from './fabric-adapter.ts';
import { NanoMindDaemon, RATE_LIMIT_PER_SECOND, TokenBucketRateLimiter } from './server.ts';
import type { DaemonEngine } from './server.ts';

describe('BaseFabricAdapter.infer() on a 429', () => {
  const DAEMON_PORT = 47286; // distinct from the other suites' ports
  const socketDir = mkdtempSync(join(tmpdir(), 'nmd-'));
  let daemon: NanoMindDaemon;
  const adapter = new BaseFabricAdapter('test', { daemonUrl: `http://127.0.0.1:${DAEMON_PORT}` });

  // While `gate` is set, inference waits for it, so a test can hold the
  // daemon's only inference slot.
  let gate: Promise<void> | null = null;
  const engine: DaemonEngine = {
    ensureReady: async () => {},
    infer: async () => {
      if (gate) await gate;
      return { text: 'benign', attackClass: '', confidence: 0.99 };
    },
  };

  before(async () => {
    daemon = new NanoMindDaemon({
      httpPort: DAEMON_PORT,
      ipcPath: join(socketDir, 'adapter.sock'),
      idleUnloadSeconds: 60,
      maxConcurrent: 1,
      engine,
    });
    await daemon.start();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  after(async () => {
    await daemon.stop();
    rmSync(socketDir, { recursive: true, force: true });
  });

  it('rejects with rate_limited when the daemon answers rate_limited', async () => {
    // A limiter on a clock that does not move, so no token comes back.
    (daemon as unknown as { rateLimiter: TokenBucketRateLimiter }).rateLimiter =
      new TokenBucketRateLimiter(RATE_LIMIT_PER_SECOND, () => 0);
    for (let i = 0; i < RATE_LIMIT_PER_SECOND; i++) {
      assert.strictEqual((await adapter.infer('INTENT_CHECK', 'list users')).classification, 'classified');
    }

    await assert.rejects(adapter.infer('INTENT_CHECK', 'list users'), { message: 'rate_limited' });

    (daemon as unknown as { rateLimiter: TokenBucketRateLimiter }).rateLimiter =
      new TokenBucketRateLimiter(RATE_LIMIT_PER_SECOND);
  });

  it('rejects with queue_full when the daemon answers queue_full', async () => {
    let release: () => void = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    const held = daemon.infer({ intent: 'INTENT_CHECK', input: 'holds the only slot' });
    try {
      await assert.rejects(adapter.infer('INTENT_CHECK', 'list users'), { message: 'queue_full' });
    } finally {
      release();
      gate = null;
      await held;
    }
  });
});

describe('BaseFabricAdapter.infer() on a 429 without an error code', () => {
  const PORT = 47287; // distinct from the other suites' ports
  const adapter = new BaseFabricAdapter('test', { daemonUrl: `http://127.0.0.1:${PORT}` });
  let retryAfter: string | null = null;
  const server = createServer((_req, res) => {
    if (retryAfter !== null) res.setHeader('Retry-After', retryAfter);
    res.writeHead(429);
    res.end('Too Many Requests');
  });

  before(async () => {
    server.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
  });

  after(() => {
    server.close();
  });

  it('reads rate_limited from a Retry-After header, and queue_full from its absence', async () => {
    retryAfter = '1';
    await assert.rejects(adapter.infer('INTENT_CHECK', 'list users'), { message: 'rate_limited' });
    retryAfter = null;
    await assert.rejects(adapter.infer('INTENT_CHECK', 'list users'), { message: 'queue_full' });
  });
});

describe('BaseFabricAdapter.infer() on a 429 whose error code and Retry-After header disagree', () => {
  let adapter: BaseFabricAdapter;
  let answer = { error: 'queue_full', retryAfter: true };
  const server = createServer((_req, res) => {
    if (answer.retryAfter) res.setHeader('Retry-After', '1');
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: answer.error }));
  });

  before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    adapter = new BaseFabricAdapter('test', { daemonUrl: `http://127.0.0.1:${port}` });
  });

  after(() => {
    server.close();
  });

  it('rejects with queue_full when the body says queue_full and a Retry-After header is present', async () => {
    answer = { error: 'queue_full', retryAfter: true };
    await assert.rejects(adapter.infer('INTENT_CHECK', 'list users'), { message: 'queue_full' });
  });

  it('rejects with rate_limited when the body says rate_limited and no Retry-After header is present', async () => {
    answer = { error: 'rate_limited', retryAfter: false };
    await assert.rejects(adapter.infer('INTENT_CHECK', 'list users'), { message: 'rate_limited' });
  });
});

describe('BaseFabricAdapter registry paths', () => {
  let adapter: BaseFabricAdapter;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(404);
    res.end();
  });

  before(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    adapter = new BaseFabricAdapter('test', { registryUrl: `http://127.0.0.1:${port}` });
  });

  after(() => {
    server.close();
  });

  it('sends a UUID agentId to the paths in docs/SPECIFICATION.md section 3.4', async () => {
    requests.length = 0;
    const agentId = '00000000-0000-0000-0000-000000000000';
    assert.strictEqual(await adapter.readRiskSummary(agentId), null);
    await assert.rejects(adapter.writeASC(agentId, {}), { message: /^ASC write failed: 404/ });
    assert.deepStrictEqual(requests, [
      `GET /api/v1/asc/${agentId}/risk-summary`,
      `PATCH /internal/asc/${agentId}`,
    ]);
  });

  it('keeps an agentId containing ../, /, ? or # inside one path segment', async () => {
    requests.length = 0;
    assert.strictEqual(await adapter.readRiskSummary('../../api/v1/x'), null);
    await assert.rejects(adapter.writeASC('a/b?c#d', {}), { message: /^ASC write failed: 404/ });
    assert.deepStrictEqual(requests, [
      'GET /api/v1/asc/..%2F..%2Fapi%2Fv1%2Fx/risk-summary',
      'PATCH /internal/asc/a%2Fb%3Fc%23d',
    ]);
  });

  it('refuses an empty agentId, . and .. without sending a request', async () => {
    requests.length = 0;
    for (const agentId of ['', '.', '..']) {
      await assert.rejects(adapter.readRiskSummary(agentId), TypeError);
      await assert.rejects(adapter.writeASC(agentId, {}), TypeError);
    }
    assert.deepStrictEqual(requests, []);
  });

  it('refuses an agentId that is not a string without sending a request', async () => {
    requests.length = 0;
    // The first four turn into "..", "." or "" when they are put into the path.
    const notStrings: unknown[] = [['..'], ['.'], [], { toString: () => '..' }, 42, undefined];
    for (const agentId of notStrings) {
      const invalid = { name: 'TypeError', message: /^Invalid agentId/ };
      await assert.rejects(adapter.readRiskSummary(agentId as string), invalid);
      await assert.rejects(adapter.writeASC(agentId as string, {}), invalid);
    }
    assert.deepStrictEqual(requests, []);
  });

  it('refuses an agentId with a lone surrogate with a TypeError, not a URIError', async () => {
    requests.length = 0;
    for (const agentId of ['a\uD800', '\uDC00a']) {
      const invalid = { name: 'TypeError', message: /^Invalid agentId/ };
      await assert.rejects(adapter.readRiskSummary(agentId), invalid);
      await assert.rejects(adapter.writeASC(agentId, {}), invalid);
    }
    assert.deepStrictEqual(requests, []);
  });
});

describe('BaseFabricAdapter internal API key', () => {
  const KEY = 'FAKE-KEY-1234';
  const agentId = '00000000-0000-0000-0000-000000000000';
  let registryUrl: string;
  let otherUrl: string;
  // While set, the registry answers every request with this redirect.
  let redirect: { status: number; location: string } | null = null;
  const requests: { request: string; internalKey: string | undefined }[] = [];
  const otherRequests: string[] = [];
  const registry = createServer((req, res) => {
    const key = req.headers['x-internal-key'];
    requests.push({ request: `${req.method} ${req.url}`, internalKey: typeof key === 'string' ? key : undefined });
    if (redirect !== null) {
      res.writeHead(redirect.status, { Location: redirect.location });
    } else {
      res.writeHead(req.method === 'PATCH' ? 204 : 404);
    }
    res.end();
  });
  // The address a redirect names. It answers 204, so a write that followed
  // the redirect would resolve.
  const other = createServer((req, res) => {
    otherRequests.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });

  before(async () => {
    registry.listen(0, '127.0.0.1');
    other.listen(0, '127.0.0.1');
    await Promise.all([once(registry, 'listening'), once(other, 'listening')]);
    registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  });

  after(() => {
    registry.close();
    other.close();
  });

  it('sends the internalApiKey option in the X-Internal-Key header of writeASC and not of readRiskSummary', async () => {
    requests.length = 0;
    const adapter = new BaseFabricAdapter('test', { registryUrl, internalApiKey: KEY });
    await adapter.writeASC(agentId, { driftScore: 0.1 });
    assert.strictEqual(await adapter.readRiskSummary(agentId), null);
    assert.deepStrictEqual(requests, [
      { request: `PATCH /internal/asc/${agentId}`, internalKey: KEY },
      { request: `GET /api/v1/asc/${agentId}/risk-summary`, internalKey: undefined },
    ]);
  });

  it('sends no X-Internal-Key header without the option', async () => {
    requests.length = 0;
    await new BaseFabricAdapter('test', { registryUrl }).writeASC(agentId, {});
    assert.deepStrictEqual(requests, [{ request: `PATCH /internal/asc/${agentId}`, internalKey: undefined }]);
  });

  it('does not follow a redirect from writeASC, so the key is not sent to the address it names', async () => {
    const adapter = new BaseFabricAdapter('test', { registryUrl, internalApiKey: KEY });
    for (const status of [301, 302, 303, 307, 308]) {
      requests.length = 0;
      otherRequests.length = 0;
      redirect = { status, location: `${otherUrl}/internal/asc/${agentId}` };
      try {
        await assert.rejects(adapter.writeASC(agentId, {}), { message: new RegExp(`^ASC write failed: ${status} `) });
      } finally {
        redirect = null;
      }
      assert.deepStrictEqual(requests, [{ request: `PATCH /internal/asc/${agentId}`, internalKey: KEY }]);
      assert.deepStrictEqual(otherRequests, [], `writeASC followed a ${status}`);
    }
  });

  it('keeps the key out of util.inspect and JSON.stringify output of the adapter', () => {
    const adapter = new BaseFabricAdapter('test', { registryUrl, internalApiKey: KEY });
    assert.ok(!inspect(adapter, { showHidden: true }).includes(KEY), inspect(adapter));
    assert.ok(!JSON.stringify(adapter).includes(KEY), JSON.stringify(adapter));
  });
});
