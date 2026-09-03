"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NanoMindDaemon = exports.DEFAULT_CONFIG = exports.ABSTAIN_CONFIDENCE_FLOOR = void 0;
const node_http_1 = require("node:http");
const router_1 = require("@nanomind/router");
const node_events_1 = require("node:events");
const onnx_engine_ts_1 = require("./onnx-engine.js");
const manifest_mts_1 = require("./manifest.mjs");
const SERVICE_NAME = 'nanomind-daemon';
const SERVICE_COMMIT = typeof manifest_mts_1.manifest.gitHead === 'string' && /^[0-9a-f]{40}$/.test(manifest_mts_1.manifest.gitHead)
    ? manifest_mts_1.manifest.gitHead
    : null;
/**
 * Stage-1 abstain floor (issue #131, [CHIEF-CDS]). When the predicted class's
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
exports.ABSTAIN_CONFIDENCE_FLOOR = 0.5;
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
        // Readiness: the model is the daemon's single required dependency.
        // The unavailable reason is a fixed string — never an engine error or
        // filesystem path, which must not leak onto this surface.
        if (url === '/health/ready' && method === 'GET') {
            const modelOk = this.modelLoaded;
            res.setHeader('Cache-Control', 'no-store');
            res.writeHead(modelOk ? 200 : 503);
            res.end(JSON.stringify({
                ready: modelOk,
                service: SERVICE_NAME,
                commit: SERVICE_COMMIT,
                version: manifest_mts_1.manifest.version,
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
            const hasConfidence = typeof result.confidence === 'number' && !Number.isNaN(result.confidence);
            const confidence = hasConfidence ? result.confidence : 0;
            const rawAttackClass = result.attackClass ?? '';
            const classification = hasConfidence && confidence >= exports.ABSTAIN_CONFIDENCE_FLOOR ? 'classified' : 'abstain';
            const response = {
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
            if (result.rawLabel)
                response.evidence = result.rawLabel;
            res.writeHead(200);
            res.end(JSON.stringify(response));
        }
        catch (err) {
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
                classification: 'abstain',
                confidence: 0,
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
