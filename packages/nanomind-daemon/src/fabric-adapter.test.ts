import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { BaseFabricAdapter } from './fabric-adapter.ts';
import { NanoMindDaemon, RATE_LIMIT_PER_SECOND, TokenBucketRateLimiter } from './server.ts';
import type { DaemonEngine } from './server.ts';

// A port that was free a moment ago, for the daemon a suite starts. Another
// socket on the machine can hold a fixed port, and the daemon's start() on it
// then rejects with EADDRINUSE.
async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

describe('BaseFabricAdapter.infer() on a 429', () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'nmd-'));
  let daemon: NanoMindDaemon;
  let adapter: BaseFabricAdapter;

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
    const daemonPort = await freePort();
    adapter = new BaseFabricAdapter('test', { daemonUrl: `http://127.0.0.1:${daemonPort}` });
    daemon = new NanoMindDaemon({
      httpPort: daemonPort,
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
  let adapter: BaseFabricAdapter;
  let retryAfter: string | null = null;
  const server = createServer((_req, res) => {
    if (retryAfter !== null) res.setHeader('Retry-After', retryAfter);
    res.writeHead(429);
    res.end('Too Many Requests');
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

// The lines of `file`, a file in src/, whose @ts-expect-error directive no
// type error uses, under the compiler options of the package's tsconfig.json.
async function unusedTsExpectErrorLines(file: string): Promise<number[]> {
  const ts = (await import('typescript')).default;
  const config = ts.getParsedCommandLineOfConfigFile(
    join(dirname(file), '..', 'tsconfig.json'),
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  const program = ts.createProgram([file], config.options);
  const source = program.getSourceFile(file);
  assert.ok(source, `the type check did not load ${file}`);
  return ts
    .getPreEmitDiagnostics(program, source)
    // 2578: Unused '@ts-expect-error' directive.
    .filter((d) => d.code === 2578 && d.file === source)
    .map((d) => source.getLineAndCharacterOfPosition(d.start).line + 1);
}

describe('BaseFabricAdapter registry credential', () => {
  type AdapterOptions = NonNullable<ConstructorParameters<typeof BaseFabricAdapter>[1]>;
  interface RecordedRequest { method: string; url: string; headers: [string, string][]; body: string }

  const agentId = '00000000-0000-0000-0000-000000000000';
  // Both values are built at run time from fragments and have no credential format.
  const planted = ['planted', 'value', 'for', 'the', 'absence', 'cells'].join('-');
  const signal = ['planted', 'signal', 'for', 'the', 'control', 'cell'].join('-');
  // `planted` goes to the constructor as internalApiKey through a cast. The
  // URLs are local, and the fetch stub below answers every request.
  const options = {
    registryUrl: 'http://127.0.0.1:9',
    daemonUrl: 'http://127.0.0.1:9',
    internalApiKey: planted,
  } as AdapterOptions;
  const recorded: RecordedRequest[] = [];

  // One run of every adapter method, with fetch replaced by a stub that
  // records each request. new Request() reads the URL, headers and body the
  // way fetch does, whatever form the adapter passes them in.
  before(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      recorded.push({
        method: request.method,
        url: request.url,
        headers: [...request.headers],
        body: await request.text(),
      });
      if (request.method === 'PATCH') return new Response(null, { status: 204 });
      if (request.method === 'POST') {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };
    try {
      const adapter = new BaseFabricAdapter('test', options);
      await adapter.writeASC(agentId, { driftScore: 0.1, note: signal });
      assert.strictEqual(await adapter.readRiskSummary(agentId), null);
      await adapter.infer('INTENT_CHECK', 'list users');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('takes no internalApiKey option: the @ts-expect-error line in this cell is a type error', async (t) => {
    // @ts-expect-error The constructor's options have no internalApiKey property.
    const typed: AdapterOptions = { internalApiKey: planted };
    void typed;
    // node --test strips the types without checking them, and tsconfig.json
    // leaves the test files out of the build, so the cell runs the check.
    assert.ok(t.filePath, 'node:test gave no path for this test file');
    assert.deepStrictEqual(await unusedTsExpectErrorLines(t.filePath), []);
  });

  it('sends a value passed as internalApiKey in no URL, header name, header value or body', () => {
    const carriers = recorded.flatMap(({ method, url, headers, body }) => [
      ...(url.includes(planted) ? [`${method} URL`] : []),
      ...headers
        .filter(([name, value]) => name.includes(planted) || value.includes(planted))
        .map(([name]) => `${method} header ${name}`),
      ...(body.includes(planted) ? [`${method} body`] : []),
    ]);
    assert.deepStrictEqual(carriers, []);
  });

  it('records all three requests, and the Content-Type header and signals of writeASC, in the same run', () => {
    assert.deepStrictEqual(
      recorded.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      [`PATCH /internal/asc/${agentId}`, `GET /api/v1/asc/${agentId}/risk-summary`, 'POST /v1/infer'],
    );
    const [write] = recorded;
    assert.ok(write.body.includes(signal), write.body);
    assert.ok(
      write.headers.some(([name, value]) => name === 'content-type' && value === 'application/json'),
      JSON.stringify(write.headers),
    );
  });

  it('keeps a value passed as internalApiKey out of util.inspect and JSON.stringify output of the adapter', () => {
    const adapter = new BaseFabricAdapter('test', options);
    assert.ok(!inspect(adapter, { showHidden: true }).includes(planted), inspect(adapter));
    assert.ok(!JSON.stringify(adapter).includes(planted), JSON.stringify(adapter));
  });
});

describe('BaseFabricAdapter.writeASC() on a redirect', () => {
  const agentId = '00000000-0000-0000-0000-000000000000';
  let registryUrl: string;
  let otherUrl: string;
  // The registry answers every request with this redirect.
  let redirect = { status: 0, location: '' };
  const requests: string[] = [];
  const otherRequests: string[] = [];
  const registry = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(redirect.status, { Location: redirect.location });
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

  it('does not follow a redirect, so the signals are not sent to the address it names', async () => {
    const adapter = new BaseFabricAdapter('test', { registryUrl });
    for (const status of [301, 302, 303, 307, 308]) {
      requests.length = 0;
      otherRequests.length = 0;
      redirect = { status, location: `${otherUrl}/internal/asc/${agentId}` };
      await assert.rejects(adapter.writeASC(agentId, {}), { message: new RegExp(`^ASC write failed: ${status} `) });
      assert.deepStrictEqual(requests, [`PATCH /internal/asc/${agentId}`]);
      assert.deepStrictEqual(otherRequests, [], `writeASC followed a ${status}`);
    }
  });
});
