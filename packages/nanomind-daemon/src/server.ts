import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { NanoMindEngine } from '@nanomind/engine';
import { classifyIntent } from '@nanomind/router';
import { EventEmitter } from 'node:events';

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

export interface InferResponse {
  intent: string;
  result: string;
  confidence: number;
  attackClass?: string;
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
  private engine: NanoMindEngine;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private activeTasks = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private modelLoaded = false;
  private startedAt: Date | null = null;

  constructor(config: Partial<DaemonConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.engine = new NanoMindEngine();
  }

  async start(): Promise<void> {
    // Start HTTP server on localhost only (non-routable)
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

      // Run inference
      const result = await this.engine.infer(
        `[INTENT: ${intent}]\n[CONTEXT: ${JSON.stringify(body.context ?? {})}]\n${body.input}`,
        { maxTokens: 128, temperature: 0.0 }
      );

      const response: InferResponse = {
        intent: intent ?? 'UNKNOWN',
        result: result.text,
        confidence: 0.85, // Pattern-matched intents have high confidence
        latencyMs: Date.now() - startMs,
        modelVersion: 'SmolLM2-135M-Q4_K_M',
      };

      res.writeHead(200);
      res.end(JSON.stringify(response));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Inference failed';
      res.writeHead(500);
      res.end(JSON.stringify({
        error: 'inference_error',
        message,
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
