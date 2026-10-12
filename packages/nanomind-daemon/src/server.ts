import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { classifyIntent } from '@nanomind/router';
import { EventEmitter } from 'node:events';
import { OnnxEngine } from './onnx-engine.ts';
import { manifest } from './manifest.mts';

const SERVICE_NAME = 'nanomind-daemon';
const SERVICE_COMMIT: string | null =
  typeof manifest.gitHead === 'string' && /^[0-9a-f]{40}$/.test(manifest.gitHead)
    ? manifest.gitHead
    : null;

/**
 * Minimal engine surface the daemon relies on. Both the production
 * `OnnxEngine` and stubs used in tests satisfy it. Optional fields are
 * passed through to InferResponse when produced; absent fields fall back
 * to the empty/0.85 defaults that preserve the Bug 1 wire contract.
 */
export interface DaemonEngine {
  ensureReady(): Promise<void>;
  infer(prompt: string, opts?: unknown): Promise<{
    text: string;
    attackClass?: AttackClass;
    rawLabel?: string;
    confidence?: number;
  }>;
  /**
   * Release the loaded model; the next `ensureReady()` loads it again.
   * An engine without `unload` is never idle-unloaded, because the daemon
   * would otherwise report a resident model as unloaded.
   */
  unload?(): Promise<void> | void;
  readonly modelVersion?: string;
}

export interface DaemonConfig {
  httpPort: number;
  ipcPath: string;
  maxConcurrent: number;
  idleUnloadSeconds: number;
}

export interface InferRequest {
  intent?: string; // routed from input when absent or empty
  input: string;
  context?: {
    agentId?: string;
    driftScore?: number;
    declaredPurpose?: string;
  };
  priority?: 'high' | 'medium' | 'low';
}

/**
 * Canonical attackClass enum. The empty string is the always-emitted default
 * when no malicious intent is detected. Non-empty values are produced by the
 * production NanoMind classifier; until that ships, the daemon always emits "".
 *
 * AIM FGA Step 5 (`fga_engine.go::checkIntentSync`) blocks when:
 *   attackClass != "" && confidence > 0.8
 *
 * Empty string therefore means "no block" — preserving fail-open for the
 * pre-classifier daemon while making the wire contract explicit.
 */
export type AttackClass =
  | ''
  | 'exfiltration_pattern'
  | 'prompt_injection'
  | 'tool_misuse'
  | 'data_extraction';

/**
 * Classification status — the explicit abstain signal added in 0.4.0 (FGA Step 5
 * Stage 1, issue #131). It tells the consumer whether `attackClass` is a usable
 * verdict or a deterministic fallback:
 *   - "classified": the model produced a usable verdict (benign OR an attack
 *     class) at or above ABSTAIN_CONFIDENCE_FLOOR. `attackClass` is authoritative
 *     ("" means a confident benign).
 *   - "abstain": the model could not produce a usable verdict — inference threw,
 *     or the predicted-class confidence was below the floor. `attackClass` is
 *     forced to "" and MUST NOT be read as "benign". Any raw low-confidence guess
 *     is preserved in `evidence` for audit.
 *
 * The daemon never emits a transport-level "fail_open" — that is the consumer's
 * status for "couldn't reach / couldn't decode the daemon" (see AIM
 * `fga_engine.go::checkIntentSync`). `classification` is what distinguishes a
 * confident benign ("classified", attackClass "") from "model couldn't answer"
 * ("abstain", attackClass "") — the exact conflation issue #131 is about.
 */
export type ClassificationStatus = 'classified' | 'abstain';

export interface InferResponse {
  intent: string;
  result: string;
  confidence: number;
  attackClass: AttackClass;
  /**
   * Explicit classified/abstain signal (0.4.0+). Older consumers that do not
   * read this field still get a deterministic `attackClass` ("" on abstain), so
   * the addition is backward compatible.
   */
  classification: ClassificationStatus;
  evidence?: string;
  remediation?: string;
  latencyMs: number;
  modelVersion: string;
}

/**
 * Stage-1 abstain floor (issue #131). When the predicted class's
 * softmax probability is below this, `/v1/infer` emits classification:"abstain"
 * + attackClass:"" instead of a verdict, so a low-confidence guess can never
 * masquerade as a confident benign downstream.
 *
 * 0.5 is a deliberately conservative Stage-1 heuristic, NOT a calibrated value:
 * below even odds the top-of-10 class is not trustworthy. The v0.5.0 classifier
 * saturates confidence near 1.0 on most inputs (see README "Known model-quality
 * limitations"), so this rarely trips today — the dominant Stage-1 fix is the
 * explicit `classification` field, not this threshold. Stage 2 (selective-risk
 * calibration) replaces this constant with a tuned floor.
 */
export const ABSTAIN_CONFIDENCE_FLOOR = 0.5;

/**
 * Largest request body `/v1/infer` reads: 1 MB (1,048,576 bytes). A body that
 * declares a larger Content-Length, or that streams more bytes than this, is
 * answered 413 before any of it is parsed; the bytes past the cap are
 * discarded, never buffered.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

class RequestTooLargeError extends Error {
  constructor() {
    super('request_too_large');
  }
}

/**
 * Requests per second each client address may make, counted across every
 * route. Also the bucket size, so an idle client can send one second of
 * requests at once. A request over the limit is answered with HTTP 429.
 */
export const RATE_LIMIT_PER_SECOND = 100;

/**
 * Most client addresses the rate limiter keeps a bucket for. The daemon binds
 * to loopback, but a local client can pick any 127.0.0.0/8 source address, so
 * the table is bounded: addresses past the bound share one bucket.
 */
const RATE_LIMIT_MAX_CLIENTS = 1024;

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per client. Each bucket holds up to `ratePerSecond` tokens and
 * refills continuously at `ratePerSecond`; a request spends one token and is
 * refused when the bucket is empty. `now` returns milliseconds on a monotonic
 * clock and is injectable so tests can step time.
 */
export class TokenBucketRateLimiter {
  private readonly ratePerSecond: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, TokenBucket>();
  private overflow: TokenBucket | null = null;

  constructor(ratePerSecond: number, now: () => number = () => performance.now()) {
    this.ratePerSecond = ratePerSecond;
    this.now = now;
  }

  /** Spend one token for `client`. Returns false when its bucket is empty. */
  tryRemove(client: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(client);
    if (!bucket) {
      if (this.buckets.size >= RATE_LIMIT_MAX_CLIENTS) this.dropRefilled(now);
      if (this.buckets.size >= RATE_LIMIT_MAX_CLIENTS) {
        this.overflow ??= { tokens: this.ratePerSecond, updatedAt: now };
        bucket = this.overflow;
      } else {
        bucket = { tokens: this.ratePerSecond, updatedAt: now };
        this.buckets.set(client, bucket);
      }
    }

    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.ratePerSecond, bucket.tokens + elapsedSeconds * this.ratePerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Forget every bucket idle for a second or more. Such a bucket has refilled
   * completely, so dropping it changes no decision.
   */
  private dropRefilled(now: number): void {
    for (const [client, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= 1000) this.buckets.delete(client);
    }
  }
}

/**
 * Why `infer()` refused a request before the model ran. `/v1/infer` answers
 * `queue_full` with 429 and `invalid_request` with 400.
 */
export type InferRequestErrorCode = 'queue_full' | 'invalid_request';

/**
 * Thrown by `NanoMindDaemon.infer()` when a request is refused before the
 * model runs. An inference failure is not wrapped in this class: `infer()`
 * rejects with the engine's own error.
 */
export class InferRequestError extends Error {
  readonly code: InferRequestErrorCode;

  constructor(code: InferRequestErrorCode, message: string) {
    super(message);
    this.name = 'InferRequestError';
    this.code = code;
  }
}

export const DEFAULT_CONFIG: DaemonConfig = {
  httpPort: 47200,
  ipcPath: process.platform === 'win32'
    ? '\\\\.\\pipe\\nanomind'
    : '/tmp/nanomind.sock',  // /var/run requires root; /tmp is accessible
  maxConcurrent: 4,
  idleUnloadSeconds: 300,
};

export class NanoMindDaemon extends EventEmitter {
  private config: DaemonConfig;
  private engine: DaemonEngine;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private ipcServer: ReturnType<typeof createServer> | null = null;
  private activeTasks = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private modelLoaded = false;
  // True while the model is released by the idle timer and has not failed
  // to reload since. The daemon can still serve in that state: the next
  // /v1/infer loads the model again.
  private idleUnloaded = false;
  private startedAt: Date | null = null;
  private rateLimiter = new TokenBucketRateLimiter(RATE_LIMIT_PER_SECOND);

  constructor(config: Partial<DaemonConfig> & { engine?: DaemonEngine } = {}) {
    super();
    const { engine, ...daemonConfig } = config;
    this.config = { ...DEFAULT_CONFIG, ...daemonConfig };
    // Default to ONNX (production NanoMind v0.5.0). Tests inject stubs;
    // legacy `NanoMindEngine` (llamafile) still satisfies DaemonEngine
    // structurally for callers that need it.
    this.engine = engine ?? new OnnxEngine();
  }

  async start(): Promise<void> {
    // Eagerly resolve model artifacts BEFORE binding the HTTP listener.
    // This means `/health` never returns 200 when classification will
    // fail at first /v1/infer call. Previously the daemon would happily
    // accept connections while the engine had no model loaded, return
    // HTTP 500 with `attackClass: ''` on every infer call, and consumers
    // saw a "Guard isn't firing" symptom with no diagnostic signal.
    //
    // OnnxEngine.ensureReady() auto-downloads missing artifacts from
    // HuggingFace unless `noAutoDownload` is set on the engine.
    await this.engine.ensureReady();
    this.modelLoaded = true;
    this.idleUnloaded = false;
    this.emit('model_loaded');

    // Bind the IPC socket before HTTP, so a socket that cannot be bound
    // (another daemon owns ipcPath, or the path is not a socket) rejects
    // start() with nothing left listening.
    this.ipcServer = await this.listenIPC();

    // Now safe to start the HTTP server on localhost only (non-routable).
    this.httpServer = createServer((req, res) => this.handleHTTP(req, res));
    this.httpServer.listen(this.config.httpPort, '127.0.0.1', () => {
      this.startedAt = new Date();
      this.emit('started', { port: this.config.httpPort, ipcPath: this.config.ipcPath });
    });

    this.resetIdleTimer();
  }

  /**
   * Serves the HTTP request handler on a Unix socket (a named pipe on
   * Windows) at `ipcPath`, so a local client gets the same routes and
   * `/v1/infer` contract without a TCP port. The socket is created with
   * mode 0600: only the user running the daemon can connect. A socket file
   * left by a daemon that exited without cleanup is replaced; a socket with
   * a live listener, or a path that is not a socket, is never removed and
   * start() rejects instead.
   */
  private async listenIPC(): Promise<ReturnType<typeof createServer>> {
    const ipcPath = this.config.ipcPath;
    const isUnixSocket = process.platform !== 'win32';
    if (isUnixSocket) await removeStaleSocket(ipcPath);

    const server = createServer((req, res) => this.handleHTTP(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        resolve();
      });
      // listen() binds the socket synchronously, so a 0177 umask held
      // around the call creates it as 0600 with no moment at a wider mode.
      // Worker threads cannot set the umask; the chmod below still applies.
      let previousUmask: number | null = null;
      if (isUnixSocket) {
        try {
          previousUmask = process.umask(0o177);
        } catch {
          previousUmask = null;
        }
      }
      try {
        server.listen(ipcPath);
      } finally {
        if (previousUmask !== null) process.umask(previousUmask);
      }
    });
    if (isUnixSocket) chmodSync(ipcPath, 0o600);
    return server;
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.ipcServer) {
      // Closing a Unix socket server also removes its socket file.
      this.ipcServer.close();
      this.ipcServer = null;
    }
    this.modelLoaded = false;
    this.idleUnloaded = false;
    this.startedAt = null;
    this.emit('stopped');
  }

  getStatus(): { running: boolean; port: number; activeTasks: number; modelLoaded: boolean; startedAt: Date | null; uptime: number } {
    return {
      running: this.httpServer !== null,
      port: this.config.httpPort,
      activeTasks: this.activeTasks,
      modelLoaded: this.modelLoaded,
      startedAt: this.startedAt,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
    };
  }

  private async handleHTTP(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS and content type
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');

    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Rate limit: one token bucket per client address, shared by every route.
    // A Unix socket connection has no address, so the socket's callers share
    // one bucket.
    if (!this.rateLimiter.tryRemove(req.socket.remoteAddress ?? '')) {
      res.setHeader('Retry-After', '1');
      res.writeHead(429);
      res.end(JSON.stringify({
        error: 'rate_limited',
        message: `Rate limit of ${RATE_LIMIT_PER_SECOND} requests/second exceeded. Try again shortly.`,
      }));
      return;
    }

    // Health check
    if (url === '/health' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(this.getStatus()));
      return;
    }

    // Readiness: the model is the daemon's single required dependency.
    // An idle-unloaded model counts as available because the next
    // /v1/infer reloads it; only a model that failed to load does not.
    // The unavailable reason is a fixed string — never an engine error or
    // filesystem path, which must not leak onto this surface.
    if (url === '/health/ready' && method === 'GET') {
      const modelOk = this.modelLoaded || this.idleUnloaded;
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(modelOk ? 200 : 503);
      res.end(JSON.stringify({
        ready: modelOk,
        service: SERVICE_NAME,
        commit: SERVICE_COMMIT,
        version: manifest.version,
        checkedAt: new Date().toISOString(),
        degraded: false,
        dependencies: {
          model: modelOk
            ? { status: 'ok', required: true }
            : { status: 'unavailable', required: true, reason: 'model not loaded' },
        },
      }));
      return;
    }

    // Status
    if (url === '/v1/status' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(this.getStatus()));
      return;
    }

    // Inference endpoint
    if (url === '/v1/infer' && method === 'POST') {
      await this.handleInfer(req, res);
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found', message: `${method} ${url} not found` }));
  }

  /**
   * Run one inference in-process, without the HTTP server. `/v1/infer` calls
   * this method, so both paths share the request validation, the
   * `maxConcurrent` cap and the classified/abstain contract. A daemon that was
   * never started loads the model on the first call.
   *
   * Rejects with `InferRequestError` when the request is refused before the
   * model runs (`queue_full`, `invalid_request`) and with the engine's own
   * error when inference fails. A rejection means classification did not run:
   * treat it as an abstain, never as a benign verdict.
   */
  async infer(request: InferRequest): Promise<InferResponse> {
    // Queue check
    if (this.activeTasks >= this.config.maxConcurrent) {
      throw this.queueFullError();
    }

    if (!request || typeof request !== 'object' || (!request.intent && !request.input)) {
      throw new InferRequestError('invalid_request', 'intent or input is required');
    }

    // Reject empty / whitespace-only input. A pure-pad token sequence
    // produces noisy argmax results (the model was not trained on
    // padding-only inputs), so the classifier must not see it. Without
    // this guard, requests like `{intent:"X",input:""}` or `"   "`
    // would emit a non-empty attackClass and poison FGA telemetry.
    if (typeof request.input !== 'string' || request.input.trim().length === 0) {
      throw new InferRequestError('invalid_request', 'input must be a non-empty, non-whitespace string');
    }

    this.activeTasks++;
    this.resetIdleTimer();
    const startMs = Date.now();

    try {
      // Load the model if the idle timer released it or an earlier load failed
      if (!this.modelLoaded) {
        try {
          await this.engine.ensureReady();
        } catch (err) {
          // The daemon cannot serve until the load succeeds, so it is no
          // longer ready.
          this.idleUnloaded = false;
          throw err;
        }
        this.modelLoaded = true;
        this.idleUnloaded = false;
        this.emit('model_loaded');
      }

      // Route intent if not provided
      let intent = request.intent;
      if (!intent && request.input) {
        const routed = classifyIntent(request.input);
        intent = routed.intent;
      }

      // Run inference. The OnnxEngine consumes the raw input text; the
      // legacy text-generation path still wraps it with INTENT/CONTEXT
      // markers for prompting. We pass the unwrapped input to the engine
      // and let each implementation decide how to use it.
      const classifierInput = request.input ?? '';
      const result = await this.engine.infer(classifierInput, {
        maxTokens: 128,
        temperature: 0.0,
      });

      // Pass through the ONNX classifier fields when present; fall back
      // to the Bug 1 contract defaults (attackClass:"", confidence:0.85)
      // so any engine that doesn't classify (legacy llamafile, test stubs)
      // still emits a valid InferResponse.
      // Deterministic fallback (issue #131, Stage 1): a verdict is only usable
      // when the engine reports a real confidence AND it is at least
      // ABSTAIN_CONFIDENCE_FLOOR. A missing / NaN confidence means the engine
      // could not produce a usable score (a non-classifying legacy/stub engine,
      // or a malformed result) — that is "model couldn't answer", so it abstains
      // rather than masquerading as a confident benign. Below the floor we also
      // abstain and force attackClass to "" so a low-confidence guess can read
      // downstream as neither an attack nor a confident benign. Either way the
      // explicit `classification` lets the consumer tell "model says benign"
      // ("classified", "") from "model couldn't answer" ("abstain", "").
      const hasConfidence =
        typeof result.confidence === 'number' && !Number.isNaN(result.confidence);
      const confidence = hasConfidence ? (result.confidence as number) : 0;
      const rawAttackClass = result.attackClass ?? '';
      const classification: ClassificationStatus =
        hasConfidence && confidence >= ABSTAIN_CONFIDENCE_FLOOR ? 'classified' : 'abstain';

      const response: InferResponse = {
        intent: intent ?? 'UNKNOWN',
        result: result.text,
        confidence,
        attackClass: classification === 'classified' ? rawAttackClass : '',
        classification,
        latencyMs: Date.now() - startMs,
        modelVersion: this.engine.modelVersion ?? 'unknown',
      };
      // Preserve the raw label for audit even on abstain, so an abstained
      // low-confidence guess stays inspectable in telemetry.
      if (result.rawLabel) response.evidence = result.rawLabel;

      return response;
    } finally {
      this.activeTasks--;
    }
  }

  private queueFullError(): InferRequestError {
    return new InferRequestError(
      'queue_full',
      `Maximum ${this.config.maxConcurrent} concurrent requests. Try again shortly.`,
    );
  }

  // Writes the HTTP answer for a request infer() refused: 429 for a full
  // queue, 400 for an invalid request.
  private respondRefused(res: ServerResponse, err: InferRequestError): void {
    if (err.code === 'queue_full') {
      res.writeHead(429);
      res.end(JSON.stringify({
        error: 'queue_full',
        message: err.message,
        activeTasks: this.activeTasks,
      }));
      return;
    }
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid_request', message: err.message }));
  }

  private async handleInfer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Queue check, before the body is read. infer() checks again once the
    // body is in, because the last slot can be taken in between.
    if (this.activeTasks >= this.config.maxConcurrent) {
      this.respondRefused(res, this.queueFullError());
      return;
    }

    // Parse body
    let body: InferRequest;
    try {
      body = await parseJSON<InferRequest>(req);
    } catch (err) {
      if (err instanceof RequestTooLargeError) {
        // The connection stays open while the client finishes sending, and
        // the rest of the body is discarded unread. Closing the socket here
        // resets a connection that still has unread bytes, and the client
        // then sees EPIPE or ECONNRESET instead of this 413.
        res.writeHead(413);
        res.end(JSON.stringify({
          error: 'request_too_large',
          message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
        }));
        return;
      }
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_request', message: 'Invalid JSON body' }));
      return;
    }

    const startMs = Date.now();

    try {
      const response = await this.infer(body);
      res.writeHead(200);
      res.end(JSON.stringify(response));
    } catch (err) {
      if (err instanceof InferRequestError) {
        this.respondRefused(res, err);
        return;
      }
      const message = err instanceof Error ? err.message : 'Inference failed';
      res.writeHead(500);
      // Bug 1 wire contract: attackClass is ALWAYS a string. Even on the
      // engine-error path the response carries `attackClass: ''` so FGA
      // Step 5 doesn't have to special-case missing fields. The 500
      // status code is what tells the consumer that classification did
      // not run; the empty attackClass is a no-block hint. Stage 1 (#131)
      // adds `classification: "abstain"` to the body so a consumer that
      // reads the body without checking the status code STILL sees an
      // explicit abstain instead of a clean benign.
      res.end(JSON.stringify({
        error: 'inference_error',
        message,
        attackClass: '',
        classification: 'abstain' as ClassificationStatus,
        confidence: 0,
        latencyMs: Date.now() - startMs,
      }));
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.activeTasks === 0 && this.modelLoaded && this.engine.unload) {
        // Flip the flags before releasing so a request that arrives while
        // the release runs takes the reload path. OnnxEngine drops its
        // references before releasing, so a failed release does not block
        // that reload.
        this.modelLoaded = false;
        this.idleUnloaded = true;
        this.emit('idle_unload');
        Promise.resolve()
          .then(() => this.engine.unload?.())
          .catch(() => undefined);
      }
    }, this.config.idleUnloadSeconds * 1000);
    // A daemon used only through infer() has no HTTP server keeping the
    // process open, and this timer must not keep it open either.
    this.idleTimer.unref();
  }
}

// Removes a socket file at `path` that no process is listening on, so a
// daemon that exited without closing its socket does not block the next
// start. Throws when the path is not a socket or a listener answers on it.
async function removeStaleSocket(path: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!isSocket) {
    throw new Error(`ipcPath ${path} exists and is not a socket; refusing to replace it`);
  }

  const probe = await new Promise<string>((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
  });
  if (probe === 'ENOENT') return;
  if (probe === 'connected') {
    throw new Error(`ipcPath ${path} is in use by another process`);
  }
  if (probe !== 'ECONNREFUSED') {
    throw new Error(`ipcPath ${path} exists and could not be probed (${probe})`);
  }
  unlinkSync(path);
}

// Parse JSON body from IncomingMessage. Rejects with RequestTooLargeError,
// and stops buffering, once the declared or received size passes
// MAX_REQUEST_BODY_BYTES.
function parseJSON<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_REQUEST_BODY_BYTES) {
      reject(new RequestTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new RequestTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        resolve(body as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);

    // Timeout after 30 seconds
    setTimeout(() => reject(new Error('request_timeout')), 30000);
  });
}
