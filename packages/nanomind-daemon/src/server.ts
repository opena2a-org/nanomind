import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { classifyIntent } from '@nanomind/router';
import { EventEmitter } from 'node:events';
import { OnnxEngine } from './onnx-engine.ts';

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
  readonly modelVersion?: string;
}

export interface DaemonConfig {
  httpPort: number;
  ipcPath: string;
  maxConcurrent: number;
  idleUnloadSeconds: number;
}

export interface InferRequest {
  intent: string;
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

export interface InferResponse {
  intent: string;
  result: string;
  confidence: number;
  attackClass: AttackClass;
  evidence?: string;
  remediation?: string;
  latencyMs: number;
  modelVersion: string;
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
  private activeTasks = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private modelLoaded = false;
  private startedAt: Date | null = null;

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
    this.emit('model_loaded');

    // Now safe to start the HTTP server on localhost only (non-routable).
    this.httpServer = createServer((req, res) => this.handleHTTP(req, res));
    this.httpServer.listen(this.config.httpPort, '127.0.0.1', () => {
      this.startedAt = new Date();
      this.emit('started', { port: this.config.httpPort });
    });

    this.resetIdleTimer();
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
    this.modelLoaded = false;
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

    // Health check
    if (url === '/health' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(this.getStatus()));
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

  private async handleInfer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Queue check
    if (this.activeTasks >= this.config.maxConcurrent) {
      res.writeHead(429);
      res.end(JSON.stringify({
        error: 'queue_full',
        message: `Maximum ${this.config.maxConcurrent} concurrent requests. Try again shortly.`,
        activeTasks: this.activeTasks,
      }));
      return;
    }

    // Parse body
    let body: InferRequest;
    try {
      body = await parseJSON<InferRequest>(req);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_request', message: 'Invalid JSON body' }));
      return;
    }

    if (!body.intent && !body.input) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_request', message: 'intent or input is required' }));
      return;
    }

    // Reject empty / whitespace-only input. A pure-pad token sequence
    // produces noisy argmax results (the model was not trained on
    // padding-only inputs), so the classifier must not see it. Without
    // this guard, requests like `{intent:"X",input:""}` or `"   "`
    // would emit a non-empty attackClass and poison FGA telemetry.
    if (typeof body.input !== 'string' || body.input.trim().length === 0) {
      res.writeHead(400);
      res.end(JSON.stringify({
        error: 'invalid_request',
        message: 'input must be a non-empty, non-whitespace string',
      }));
      return;
    }

    this.activeTasks++;
    this.resetIdleTimer();
    const startMs = Date.now();

    try {
      // Ensure model is loaded on first request
      if (!this.modelLoaded) {
        await this.engine.ensureReady();
        this.modelLoaded = true;
        this.emit('model_loaded');
      }

      // Route intent if not provided
      let intent = body.intent;
      if (!intent && body.input) {
        const routed = classifyIntent(body.input);
        intent = routed.intent;
      }

      // Run inference. The OnnxEngine consumes the raw input text; the
      // legacy text-generation path still wraps it with INTENT/CONTEXT
      // markers for prompting. We pass the unwrapped input to the engine
      // and let each implementation decide how to use it.
      const classifierInput = body.input ?? '';
      const result = await this.engine.infer(classifierInput, {
        maxTokens: 128,
        temperature: 0.0,
      });

      // Pass through the ONNX classifier fields when present; fall back
      // to the Bug 1 contract defaults (attackClass:"", confidence:0.85)
      // so any engine that doesn't classify (legacy llamafile, test stubs)
      // still emits a valid InferResponse.
      const response: InferResponse = {
        intent: intent ?? 'UNKNOWN',
        result: result.text,
        confidence: typeof result.confidence === 'number' ? result.confidence : 0.85,
        attackClass: result.attackClass ?? '',
        latencyMs: Date.now() - startMs,
        modelVersion: this.engine.modelVersion ?? 'unknown',
      };
      if (result.rawLabel) response.evidence = result.rawLabel;

      res.writeHead(200);
      res.end(JSON.stringify(response));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Inference failed';
      res.writeHead(500);
      // Bug 1 wire contract: attackClass is ALWAYS a string. Even on the
      // engine-error path the response carries `attackClass: ''` so FGA
      // Step 5 doesn't have to special-case missing fields. The 500
      // status code is what tells the consumer that classification did
      // not run; the empty attackClass is a no-block hint.
      res.end(JSON.stringify({
        error: 'inference_error',
        message,
        attackClass: '',
        confidence: 0,
        latencyMs: Date.now() - startMs,
      }));
    } finally {
      this.activeTasks--;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.activeTasks === 0) {
        this.emit('idle_unload');
        this.modelLoaded = false;
      }
    }, this.config.idleUnloadSeconds * 1000);
  }
}

// Parse JSON body from IncomingMessage
function parseJSON<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
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
