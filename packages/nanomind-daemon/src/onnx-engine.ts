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
 * surrounding token (`'﻿ignore'.isspace()` → False in Python), so a
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
  /**
   * Test-only override that skips the SHA-256 integrity check on load.
   * Honored only when `process.env.NODE_ENV !== 'production'`. Setting
   * this in a production build is a no-op — verification still runs.
   */
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
    // skipIntegrityCheck is honored only outside production builds.
    // In production NODE_ENV the integrity check always runs regardless
    // of what callers pass.
    this.skipIntegrityCheck =
      (config.skipIntegrityCheck ?? false) && process.env.NODE_ENV !== 'production';
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
    if (!(rawLabel in RAW_TO_CANONICAL)) {
      // Defensive: a future model bump that adds an 11th label without
      // updating the mapping table would silently bucket the new class as
      // benign. Fail loudly instead so the regression is caught at first
      // inference rather than weeks later in production telemetry.
      throw new Error(
        `NanoMind classifier returned unknown label "${rawLabel}" (logit index ${argmax}). ` +
          `Update RAW_TO_CANONICAL mapping in onnx-engine.ts and the README mapping table.`,
      );
    }
    const attackClass = RAW_TO_CANONICAL[rawLabel];
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
 * trainer-faithful tokenizer would treat `"﻿ignore"` as `<UNK>` and
 * miss zero-width-cloaked prompt injections. Stripping reveals the
 * underlying word for classification. Benign training data does not
 * contain zero-width characters, so this cannot regress recall on
 * legitimate inputs.
 *
 * Returns an empty array (length 0) for empty or whitespace-only input;
 * callers must reject those upstream so the model never sees a pure-pad
 * input (which produces noisy argmax results).
 */
export function tokenize(text: string, vocab: Map<string, number>): number[] {
  const cleaned = text.replace(/[\u{FEFF}\u{200B}\u{200C}\u{200D}]/gu, '').toLowerCase();
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
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
