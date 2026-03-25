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
export interface InferenceResult {
    text: string;
    tokensUsed: number;
    latencyMs: number;
    tier: 'local-fast' | 'local-full' | 'cloud-fallback';
}
export interface EngineConfig {
    modelPath?: string;
    llamafilePath?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
}
export declare class NanoMindEngine {
    private config;
    private ready;
    constructor(config?: EngineConfig);
    /**
     * Check if the engine is ready (model + llamafile downloaded).
     */
    isReady(): Promise<boolean>;
    /**
     * Ensure model and llamafile are downloaded.
     * Called automatically on first inference.
     */
    ensureReady(): Promise<void>;
    /**
     * Run inference with the local model.
     */
    infer(prompt: string, options?: Partial<EngineConfig>): Promise<InferenceResult>;
    /**
     * Classify text into one of the given categories.
     * Uses a constrained prompt for fast intent classification.
     */
    classify(text: string, categories: string[]): Promise<{
        category: string;
        confidence: number;
    }>;
    /**
     * Get the model file path.
     */
    getModelPath(): string;
    /**
     * Compute SHA-256 hash of a file (for integrity verification).
     */
    static computeFileHash(filePath: string): Promise<string>;
}
export default NanoMindEngine;
