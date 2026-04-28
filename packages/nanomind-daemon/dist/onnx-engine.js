"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnnxEngine = void 0;
exports.tokenize = tokenize;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_fs_2 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
const ort = __importStar(require("onnxruntime-node"));
const MODEL_DIR_DEFAULT = (0, node_path_1.join)((0, node_os_1.homedir)(), '.nanomind', 'models');
const ONNX_FILE = 'nanomind-tme.onnx';
const ONNX_DATA_FILE = 'nanomind-tme.onnx.data';
const TOKENIZER_FILE = 'tokenizer.json';
// Canonical SHA-256 hashes for nanomind-security-classifier v0.5.0.
// Source of truth: nanomind-models.json `models.nanomind-security-classifier.versions.0.5.0.sha256`.
// Update in lockstep with the registry on every model bump; mismatched hashes
// fail loudly on daemon start to detect tampering or stale local artifacts.
const EXPECTED_SHA256 = Object.freeze({
    [ONNX_FILE]: '1c9c6db00385e0e871ee6d2508d90a3210eddd4abf45365151fb859d8abab9eb',
    [ONNX_DATA_FILE]: '1367c0d3086b8d5c698dc37ae309c3afdb41ffa4d35ecac9b8f1882ffeb1d018',
    [TOKENIZER_FILE]: '5ace7e6441505cf24dfb84d10b237c66edccaece075b3c5b0736c007d65355ce',
});
// Ordered raw labels — index in this array IS the model's logit position.
// Source of truth: HuggingFace `opena2a/nanomind-security-classifier` config.json
// `id2label`. Order is load-bearing; do not reorder.
const ID2LABEL = Object.freeze([
    'exfiltration',
    'injection',
    'privilege_escalation',
    'persistence',
    'credential_abuse',
    'lateral_movement',
    'social_engineering',
    'policy_violation',
    'benign',
    'steganography',
]);
// Raw model label → canonical attackClass enum.
// `evidence` carries the raw label separately so audit fidelity is preserved.
// See README §"attackClass mapping" for the rationale (CHIEF-CDS-032 hybrid).
const RAW_TO_CANONICAL = Object.freeze({
    benign: '',
    injection: 'prompt_injection',
    social_engineering: 'prompt_injection',
    exfiltration: 'exfiltration_pattern',
    steganography: 'exfiltration_pattern',
    credential_abuse: 'data_extraction',
    privilege_escalation: 'tool_misuse',
    persistence: 'tool_misuse',
    lateral_movement: 'tool_misuse',
    policy_violation: 'tool_misuse',
});
const MAX_SEQ_LEN = 128;
const PAD_ID = 0;
const UNK_ID = 1;
class OnnxEngine {
    /** Identifies the loaded model in InferResponse.modelVersion. */
    modelVersion = 'nanomind-tme-v0.5.0';
    modelDir;
    skipIntegrityCheck;
    session = null;
    vocab = null;
    constructor(config = {}) {
        this.modelDir = config.modelDir ?? MODEL_DIR_DEFAULT;
        this.skipIntegrityCheck = config.skipIntegrityCheck ?? false;
    }
    isLoaded() {
        return this.session !== null && this.vocab !== null;
    }
    async ensureReady() {
        if (this.isLoaded())
            return;
        const modelPath = (0, node_path_1.join)(this.modelDir, ONNX_FILE);
        const dataPath = (0, node_path_1.join)(this.modelDir, ONNX_DATA_FILE);
        const tokenizerPath = (0, node_path_1.join)(this.modelDir, TOKENIZER_FILE);
        for (const [label, p] of [
            ['model', modelPath],
            ['model external data', dataPath],
            ['tokenizer', tokenizerPath],
        ]) {
            if (!(0, node_fs_1.existsSync)(p)) {
                throw new Error(`NanoMind ${label} not found at ${p}. ` +
                    `Download v0.5.0 from huggingface.co/opena2a/nanomind-security-classifier ` +
                    `into ${this.modelDir}/ before starting the daemon.`);
            }
        }
        if (!this.skipIntegrityCheck) {
            for (const [name, expected] of Object.entries(EXPECTED_SHA256)) {
                const path = (0, node_path_1.join)(this.modelDir, name);
                const actual = await fileSha256(path);
                if (actual !== expected) {
                    throw new Error(`NanoMind integrity check failed for ${name}: ` +
                        `expected ${expected}, got ${actual}. ` +
                        `File may be corrupted or replaced; re-download v0.5.0 from HuggingFace.`);
                }
            }
        }
        const tokenizerJSON = JSON.parse(await (0, promises_1.readFile)(tokenizerPath, 'utf-8'));
        this.vocab = new Map(Object.entries(tokenizerJSON));
        if (!this.vocab.has('<PAD>') || !this.vocab.has('<UNK>')) {
            throw new Error('NanoMind tokenizer.json is missing required <PAD>/<UNK> tokens.');
        }
        this.session = await ort.InferenceSession.create(modelPath);
    }
    /**
     * Run sequence classification on `text`. Same return shape as the legacy
     * llamafile engine plus `attackClass` / `rawLabel` / `confidence`.
     */
    async infer(text) {
        const start = Date.now();
        await this.ensureReady();
        const ids = tokenize(text, this.vocab);
        const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, MAX_SEQ_LEN]);
        const outputs = await this.session.run({ input_ids: inputIds });
        const logitsTensor = outputs.logits ?? Object.values(outputs)[0];
        const logits = Array.from(logitsTensor.data);
        const probs = softmax(logits);
        let argmax = 0;
        for (let i = 1; i < probs.length; i++) {
            if (probs[i] > probs[argmax])
                argmax = i;
        }
        const rawLabel = ID2LABEL[argmax];
        const attackClass = RAW_TO_CANONICAL[rawLabel] ?? '';
        const tokensUsed = ids.findIndex((id) => id === PAD_ID);
        return {
            text: rawLabel,
            tokensUsed: tokensUsed === -1 ? MAX_SEQ_LEN : tokensUsed,
            latencyMs: Date.now() - start,
            tier: 'local-fast',
            attackClass,
            rawLabel,
            confidence: probs[argmax],
        };
    }
}
exports.OnnxEngine = OnnxEngine;
/**
 * Mirrors `training/scripts/train-tme-mlx.py:tokenize_batch` exactly:
 * lowercase, split on ASCII whitespace, vocab lookup with <UNK> fallback,
 * truncate to MAX_SEQ_LEN, zero-pad to MAX_SEQ_LEN. Drift here breaks the
 * model — keep this in lockstep with the trainer.
 */
function tokenize(text, vocab) {
    const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const ids = tokens.slice(0, MAX_SEQ_LEN).map((t) => vocab.get(t) ?? UNK_ID);
    while (ids.length < MAX_SEQ_LEN)
        ids.push(PAD_ID);
    return ids;
}
function softmax(xs) {
    const max = Math.max(...xs);
    const exps = xs.map((x) => Math.exp(x - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
}
async function fileSha256(path) {
    await (0, promises_1.stat)(path);
    return new Promise((resolve, reject) => {
        const h = (0, node_crypto_1.createHash)('sha256');
        const s = (0, node_fs_2.createReadStream)(path);
        s.on('data', (c) => h.update(c));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}
