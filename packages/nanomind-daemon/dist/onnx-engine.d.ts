/**
 * @nanomind/daemon — ONNX inference engine
 *
 * Loads the production NanoMind security classifier (Mamba-TME, ~9MB) from
 * `~/.nanomind/models/` and runs sequence-classification inference inside the
 * daemon process. Replaces the old llamafile/SmolLM2 path that produced
 * template-token spam instead of real classifications.
 *
 * Wire shape stays identical to what server.ts expects from `engine.infer()`:
 * `{text, latencyMs, ...}` plus the new ONNX-only fields `attackClass`,
 * `confidence`, `rawLabel`. Server passes those through when present, and the
 * Bug 1 contract (`attackClass` always emitted as a string with `""` default)
 * is preserved for engines that don't produce them.
 *
 * Tokenizer mirrors `training/scripts/train-tme-mlx.py:tokenize_batch`
 * exactly: lowercase, whitespace split, lookup in 6000-entry vocab,
 * unknown → <UNK>, truncate or zero-pad to 128. The vocab lives in
 * `tokenizer.json`. Drift between this code and the trainer breaks the
 * model — keep them in lockstep.
 *
 * Integrity: SHA-256 of all three files (model, model-data, tokenizer) is
 * verified against the v0.5.0 hashes recorded in `nanomind-models.json` on
 * first load. Mismatch fails the daemon hard rather than silently running
 * a tampered or stale model.
 */
import type { AttackClass } from './server.ts';
export interface OnnxEngineConfig {
    modelDir?: string;
    /** Override for tests — skip SHA-256 check. NEVER set in production. */
    skipIntegrityCheck?: boolean;
}
export interface OnnxInferResult {
    /** Raw human-readable label (e.g. "exfiltration"). Convenience for logs. */
    text: string;
    tokensUsed: number;
    latencyMs: number;
    tier: 'local-fast';
    /** Canonical bucket from the AttackClass enum; empty for benign. */
    attackClass: AttackClass;
    /** Original 10-way model label. Goes into InferResponse.evidence. */
    rawLabel: string;
    /** Softmax probability of the predicted class, in [0, 1]. */
    confidence: number;
}
export declare class OnnxEngine {
    /** Identifies the loaded model in InferResponse.modelVersion. */
    readonly modelVersion = "nanomind-tme-v0.5.0";
    private readonly modelDir;
    private readonly skipIntegrityCheck;
    private session;
    private vocab;
    constructor(config?: OnnxEngineConfig);
    isLoaded(): boolean;
    ensureReady(): Promise<void>;
    /**
     * Run sequence classification on `text`. Same return shape as the legacy
     * llamafile engine plus `attackClass` / `rawLabel` / `confidence`.
     */
    infer(text: string): Promise<OnnxInferResult>;
}
/**
 * Mirrors `training/scripts/train-tme-mlx.py:tokenize_batch` exactly:
 * lowercase, split on ASCII whitespace, vocab lookup with <UNK> fallback,
 * truncate to MAX_SEQ_LEN, zero-pad to MAX_SEQ_LEN. Drift here breaks the
 * model — keep this in lockstep with the trainer.
 */
export declare function tokenize(text: string, vocab: Map<string, number>): number[];
