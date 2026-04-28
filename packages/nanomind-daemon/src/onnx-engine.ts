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

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import * as ort from 'onnxruntime-node';
import type { AttackClass } from './server.ts';

const MODEL_DIR_DEFAULT = join(homedir(), '.nanomind', 'models');
const ONNX_FILE = 'nanomind-tme.onnx';
const ONNX_DATA_FILE = 'nanomind-tme.onnx.data';
const TOKENIZER_FILE = 'tokenizer.json';

// Canonical SHA-256 hashes for nanomind-security-classifier v0.5.0.
// Source of truth: nanomind-models.json `models.nanomind-security-classifier.versions.0.5.0.sha256`.
// Update in lockstep with the registry on every model bump; mismatched hashes
// fail loudly on daemon start to detect tampering or stale local artifacts.
const EXPECTED_SHA256: Readonly<Record<string, string>> = Object.freeze({
  [ONNX_FILE]: '1c9c6db00385e0e871ee6d2508d90a3210eddd4abf45365151fb859d8abab9eb',
  [ONNX_DATA_FILE]: '1367c0d3086b8d5c698dc37ae309c3afdb41ffa4d35ecac9b8f1882ffeb1d018',
  [TOKENIZER_FILE]: '5ace7e6441505cf24dfb84d10b237c66edccaece075b3c5b0736c007d65355ce',
});

// Ordered raw labels — index in this array IS the model's logit position.
// Source of truth: HuggingFace `opena2a/nanomind-security-classifier` config.json
// `id2label`. Order is load-bearing; do not reorder.
const ID2LABEL: readonly string[] = Object.freeze([
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
const RAW_TO_CANONICAL: Readonly<Record<string, AttackClass>> = Object.freeze({
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

export class OnnxEngine {
  /** Identifies the loaded model in InferResponse.modelVersion. */
  readonly modelVersion = 'nanomind-tme-v0.5.0';

  private readonly modelDir: string;
  private readonly skipIntegrityCheck: boolean;
  private session: ort.InferenceSession | null = null;
  private vocab: Map<string, number> | null = null;

  constructor(config: OnnxEngineConfig = {}) {
    this.modelDir = config.modelDir ?? MODEL_DIR_DEFAULT;
    this.skipIntegrityCheck = config.skipIntegrityCheck ?? false;
  }

  isLoaded(): boolean {
    return this.session !== null && this.vocab !== null;
  }

  async ensureReady(): Promise<void> {
    if (this.isLoaded()) return;

    const modelPath = join(this.modelDir, ONNX_FILE);
    const dataPath = join(this.modelDir, ONNX_DATA_FILE);
    const tokenizerPath = join(this.modelDir, TOKENIZER_FILE);

    for (const [label, p] of [
      ['model', modelPath],
      ['model external data', dataPath],
      ['tokenizer', tokenizerPath],
    ] as const) {
      if (!existsSync(p)) {
        throw new Error(
          `NanoMind ${label} not found at ${p}. ` +
            `Download v0.5.0 from huggingface.co/opena2a/nanomind-security-classifier ` +
            `into ${this.modelDir}/ before starting the daemon.`,
        );
      }
    }

    if (!this.skipIntegrityCheck) {
      for (const [name, expected] of Object.entries(EXPECTED_SHA256)) {
        const path = join(this.modelDir, name);
        const actual = await fileSha256(path);
        if (actual !== expected) {
          throw new Error(
            `NanoMind integrity check failed for ${name}: ` +
              `expected ${expected}, got ${actual}. ` +
              `File may be corrupted or replaced; re-download v0.5.0 from HuggingFace.`,
          );
        }
      }
    }

    const tokenizerJSON = JSON.parse(await readFile(tokenizerPath, 'utf-8')) as Record<string, number>;
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
  async infer(text: string): Promise<OnnxInferResult> {
    const start = Date.now();
    await this.ensureReady();

    const ids = tokenize(text, this.vocab!);
    const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, MAX_SEQ_LEN]);

    const outputs = await this.session!.run({ input_ids: inputIds });
    const logitsTensor = outputs.logits ?? Object.values(outputs)[0];
    const logits = Array.from(logitsTensor.data as Float32Array);
    const probs = softmax(logits);

    let argmax = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[argmax]) argmax = i;
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

/**
 * Mirrors `training/scripts/train-tme-mlx.py:tokenize_batch` exactly:
 * lowercase, split on ASCII whitespace, vocab lookup with <UNK> fallback,
 * truncate to MAX_SEQ_LEN, zero-pad to MAX_SEQ_LEN. Drift here breaks the
 * model — keep this in lockstep with the trainer.
 */
export function tokenize(text: string, vocab: Map<string, number>): number[] {
  const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const ids = tokens.slice(0, MAX_SEQ_LEN).map((t) => vocab.get(t) ?? UNK_ID);
  while (ids.length < MAX_SEQ_LEN) ids.push(PAD_ID);
  return ids;
}

function softmax(xs: readonly number[]): number[] {
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

async function fileSha256(path: string): Promise<string> {
  await stat(path);
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (c: Buffer) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
