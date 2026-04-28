"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NanoMindDaemon = exports.DEFAULT_CONFIG = void 0;
const node_http_1 = require("node:http");
const router_1 = require("@nanomind/router");
const node_events_1 = require("node:events");
const onnx_engine_ts_1 = require("./onnx-engine.js");
exports.DEFAULT_CONFIG = {
    httpPort: 47200,
    ipcPath: process.platform === 'win32'
        ? '\\\\.\\pipe\\nanomind'
        : '/tmp/nanomind.sock', // /var/run requires root; /tmp is accessible
    maxConcurrent: 4,
    idleUnloadSeconds: 300,
};
class NanoMindDaemon extends node_events_1.EventEmitter {
    config;
    engine;
    httpServer = null;
    activeTasks = 0;
    idleTimer = null;
    modelLoaded = false;
    startedAt = null;
    constructor(config = {}) {
        super();
        const { engine, ...daemonConfig } = config;
        this.config = { ...exports.DEFAULT_CONFIG, ...daemonConfig };
        // Default to ONNX (production NanoMind v0.5.0). Tests inject stubs;
        // legacy `NanoMindEngine` (llamafile) still satisfies DaemonEngine
        // structurally for callers that need it.
        this.engine = engine ?? new onnx_engine_ts_1.OnnxEngine();
    }
    async start() {
        // Start HTTP server on localhost only (non-routable)
        this.httpServer = (0, node_http_1.createServer)((req, res) => this.handleHTTP(req, res));
        this.httpServer.listen(this.config.httpPort, '127.0.0.1', () => {
            this.startedAt = new Date();
            this.emit('started', { port: this.config.httpPort });
        });
        this.resetIdleTimer();
    }
    async stop() {
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
    getStatus() {
        return {
            running: this.httpServer !== null,
            port: this.config.httpPort,
            activeTasks: this.activeTasks,
            modelLoaded: this.modelLoaded,
            startedAt: this.startedAt,
            uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
        };
    }
    async handleHTTP(req, res) {
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
    async handleInfer(req, res) {
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
        let body;
        try {
            body = await parseJSON(req);
        }
        catch {
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
                const routed = (0, router_1.classifyIntent)(body.input);
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
            const response = {
                intent: intent ?? 'UNKNOWN',
                result: result.text,
                confidence: typeof result.confidence === 'number' ? result.confidence : 0.85,
                attackClass: result.attackClass ?? '',
                latencyMs: Date.now() - startMs,
                modelVersion: this.engine.modelVersion ?? 'unknown',
            };
            if (result.rawLabel)
                response.evidence = result.rawLabel;
            res.writeHead(200);
            res.end(JSON.stringify(response));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Inference failed';
            res.writeHead(500);
            res.end(JSON.stringify({
                error: 'inference_error',
                message,
                latencyMs: Date.now() - startMs,
            }));
        }
        finally {
            this.activeTasks--;
        }
    }
    resetIdleTimer() {
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
exports.NanoMindDaemon = NanoMindDaemon;
// Parse JSON body from IncomingMessage
function parseJSON(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                resolve(body);
            }
            catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
        // Timeout after 30 seconds
        setTimeout(() => reject(new Error('request_timeout')), 30000);
    });
}
