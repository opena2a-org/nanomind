import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
