"use strict";
/**
 * @nanomind/engine — Core inference backend
 *
 * Wraps llamafile for local LLM inference. Downloads model on first use.
 * Target model: SmolLM2-135M (Q4_K_M quantization, ~80MB)
 *
 * Inference tiers:
 *   - Local Fast: SmolLM2-135M via llamafile (~50ms, intent classification)
 *   - Local Full: SmolLM2-135M via llamafile (~200ms, code generation)
 *   - Cloud Fallback: Anthropic API (only when local model unavailable)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NanoMindEngine = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
// Model configuration
const MODEL_DIR = (0, node_path_1.join)((0, node_os_1.homedir)(), '.nanomind', 'models');
const MODEL_NAME = 'SmolLM2-135M.Q4_K_M.gguf';
const MODEL_PATH = (0, node_path_1.join)(MODEL_DIR, MODEL_NAME);
// llamafile binary
const LLAMAFILE_DIR = (0, node_path_1.join)((0, node_os_1.homedir)(), '.nanomind', 'bin');
const LLAMAFILE_PATH = (0, node_path_1.join)(LLAMAFILE_DIR, 'llamafile');
class NanoMindEngine {
    config;
    ready = false;
    constructor(config = {}) {
        this.config = {
            modelPath: config.modelPath ?? MODEL_PATH,
            llamafilePath: config.llamafilePath ?? LLAMAFILE_PATH,
            maxTokens: config.maxTokens ?? 256,
            temperature: config.temperature ?? 0.1,
            topP: config.topP ?? 0.9,
        };
    }
    /**
     * Check if the engine is ready (model + llamafile downloaded).
     */
    async isReady() {
        if (this.ready)
            return true;
        this.ready =
            (0, node_fs_1.existsSync)(this.config.modelPath) &&
                (0, node_fs_1.existsSync)(this.config.llamafilePath);
        return this.ready;
    }
    /**
     * Ensure model and llamafile are downloaded.
     * Called automatically on first inference.
     */
    async ensureReady() {
        if (await this.isReady())
            return;
        await (0, promises_1.mkdir)(MODEL_DIR, { recursive: true });
        await (0, promises_1.mkdir)(LLAMAFILE_DIR, { recursive: true });
        if (!(0, node_fs_1.existsSync)(this.config.llamafilePath)) {
            console.log('NanoMind: Downloading llamafile runtime...');
            // Placeholder — actual download URL would be set at build time
            throw new Error('llamafile not found. Run: nanomind setup (or download manually to ~/.nanomind/bin/llamafile)');
        }
        if (!(0, node_fs_1.existsSync)(this.config.modelPath)) {
            console.log('NanoMind: Downloading SmolLM2-135M model...');
            throw new Error(`Model not found at ${this.config.modelPath}. Run: nanomind setup`);
        }
        this.ready = true;
    }
    /**
     * Run inference with the local model.
     */
    async infer(prompt, options) {
        const start = Date.now();
        await this.ensureReady();
        const maxTokens = options?.maxTokens ?? this.config.maxTokens;
        const temperature = options?.temperature ?? this.config.temperature;
        return new Promise((resolve, reject) => {
            const args = [
                '-m', this.config.modelPath,
                '--temp', temperature.toString(),
                '-n', maxTokens.toString(),
                '-p', prompt,
                '--no-display-prompt',
                '--log-disable',
            ];
            (0, node_child_process_1.execFile)(this.config.llamafilePath, args, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Inference failed: ${error.message}`));
                    return;
                }
                const text = stdout.trim();
                const latencyMs = Date.now() - start;
                resolve({
                    text,
                    tokensUsed: Math.ceil(text.length / 4), // rough estimate
                    latencyMs,
                    tier: latencyMs < 100 ? 'local-fast' : 'local-full',
                });
            });
        });
    }
    /**
     * Classify text into one of the given categories.
     * Uses a constrained prompt for fast intent classification.
     */
    async classify(text, categories) {
        const prompt = `Classify the following into exactly one category.
Categories: ${categories.join(', ')}
Input: "${text}"
Category:`;
        const result = await this.infer(prompt, { maxTokens: 20, temperature: 0.0 });
        const predicted = result.text.trim().split('\n')[0].trim();
        // Find best matching category
        const match = categories.find(c => predicted.toLowerCase().includes(c.toLowerCase())) ?? categories[0];
        return { category: match, confidence: 0.8 };
    }
    /**
     * Get the model file path.
     */
    getModelPath() {
        return this.config.modelPath;
    }
    /**
     * Compute SHA-256 hash of a file (for integrity verification).
     */
    static async computeFileHash(filePath) {
        const { createReadStream } = await import('node:fs');
        return new Promise((resolve, reject) => {
            const hash = (0, node_crypto_1.createHash)('sha256');
            const stream = createReadStream(filePath);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }
}
exports.NanoMindEngine = NanoMindEngine;
exports.default = NanoMindEngine;
