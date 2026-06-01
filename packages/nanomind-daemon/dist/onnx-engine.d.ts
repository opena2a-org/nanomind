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
 * Tokenizer is functionally aligned with
 * `training/scripts/train-tme-mlx.py:tokenize_batch` (lowercase, split on
 * whitespace, lookup in 6000-entry vocab, unknown → <UNK>, truncate or
 * zero-pad to 128) plus one intentional, defense-in-depth divergence:
 * zero-width characters (U+FEFF BOM, U+200B-200D ZWSP/ZWNJ/ZWJ) are
 * stripped before splitting. The trainer treats those as part of the
 * surrounding token (`'\uFEFFignore'.isspace()` → False in Python), so a
 * zero-width-cloaked attack would tokenize to `<UNK>` against a faithful
 * tokenizer and bypass classification. Stripping reveals the underlying
 * word and lets the classifier see it. Benign training inputs do not
 * carry zero-width characters, so the divergence cannot regress recall.
 * If model retraining ever changes the tokenizer rule, update this file
 * and the trainer in lockstep.
 *
 * Integrity: SHA-256 of all three files (model, model-data, tokenizer) is
 * verified against the v0.5.0 hashes recorded in `nanomind-models.json` on
 * first load. Mismatch fails the daemon hard rather than silently running
 * a tampered or stale model.
 */
import type { AttackClass } from './server.ts';
export interface OnnxEngineConfig {
    modelDir?: string;
    /**
     * Test-only override that skips the SHA-256 integrity check on load.
     * Honored only when `process.env.NODE_ENV !== 'production'`. Setting
     * this in a production build is a no-op — verification still runs.
     */
    skipIntegrityCheck?: boolean;
    /**
     * When true, `ensureReady()` will NOT attempt to fetch missing files
     * from HuggingFace; instead it throws the original "not found" error
     * so the operator can stage the artifacts manually. Useful in
     * air-gapped or otherwise network-restricted environments. Defaults
     * to false (auto-download enabled).
     */
    noAutoDownload?: boolean;
    /**
     * Override the base URL the model files are fetched from. Defaults
     * to `https://huggingface.co/opena2a/nanomind-security-classifier/resolve/main`.
     * Primarily a test seam — point at a local fixture server to
     * exercise the download path without hitting HuggingFace.
     */
    downloadBaseUrl?: string;
    /**
     * Optional callback for download progress / status. Defaults to
     * writing one line per file to stderr ("downloading <name> ..."
     * and "verified <name>"). Set to `() => {}` to silence the daemon.
     */
    onDownloadProgress?: (event: DownloadProgressEvent) => void;
}
/**
 * Event surfaced by the download flow so callers can render progress.
 * `phase` is the only field guaranteed across all events; `bytesDone`
 * and `bytesTotal` are present when the upstream advertises a
 * Content-Length header.
 */
export type DownloadProgressEvent = {
    phase: 'start';
    file: string;
    url: string;
} | {
    phase: 'bytes';
    file: string;
    bytesDone: number;
    bytesTotal: number | null;
} | {
    phase: 'verifying';
    file: string;
} | {
    phase: 'done';
    file: string;
    bytes: number;
} | {
    phase: 'error';
    file: string;
    message: string;
};
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
    private readonly noAutoDownload;
    private readonly downloadBaseUrl;
    private readonly onDownloadProgress;
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
    /**
     * Stream-download a single file from the configured base URL,
     * verify its SHA-256, and atomically rename into place. Writes to a
     * `.part` sibling first so a crash or signal mid-download never
     * leaves a partial file at the canonical path.
     */
    private downloadAndVerify;
}
/**
 * Tokenize an input string for the Mamba-TME classifier.
 *
 * Functional alignment with the trainer (`tokenize_batch` in
 * `training/scripts/train-tme-mlx.py`): lowercase, split on whitespace,
 * vocab lookup with <UNK> fallback, truncate to MAX_SEQ_LEN, zero-pad to
 * MAX_SEQ_LEN.
 *
 * Defense-in-depth divergence (intentional): zero-width characters
 * (U+FEFF BOM, U+200B-U+200D ZWSP/ZWNJ/ZWJ) are stripped before
 * splitting. Python's `str.isspace()` returns False for these, so a
 * trainer-faithful tokenizer would treat `"\uFEFFignore"` as `<UNK>` and
 * miss zero-width-cloaked prompt injections. Stripping reveals the
 * underlying word for classification. Benign training data does not
 * contain zero-width characters, so this cannot regress recall on
 * legitimate inputs.
 *
 * Returns an empty array (length 0) for empty or whitespace-only input;
 * callers must reject those upstream so the model never sees a pure-pad
 * input (which produces noisy argmax results).
 */
export declare function tokenize(text: string, vocab: Map<string, number>): number[];
