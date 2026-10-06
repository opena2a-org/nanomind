import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NanoMindEngine } from './index.ts';

describe('NanoMindEngine', () => {
  let dir: string;
  let modelPath: string;

  // A stand-in llamafile: a shell script that runs `body` with the
  // arguments the engine passes.
  async function fakeLlamafile(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanomind-engine-test-'));
    modelPath = join(dir, 'model.gguf');
    await writeFile(modelPath, 'not a real model');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is not ready when the model or the llamafile is missing', async () => {
    const llamafilePath = await fakeLlamafile('present', 'exit 0');
    const noModel = new NanoMindEngine({ modelPath: join(dir, 'absent.gguf'), llamafilePath });
    const noLlamafile = new NanoMindEngine({ modelPath, llamafilePath: join(dir, 'absent') });

    assert.strictEqual(await noModel.isReady(), false);
    assert.strictEqual(await noLlamafile.isReady(), false);
  });

  it('is ready when both the model and the llamafile exist', async () => {
    const llamafilePath = await fakeLlamafile('ready', 'exit 0');
    const engine = new NanoMindEngine({ modelPath, llamafilePath });

    assert.strictEqual(await engine.isReady(), true);
    assert.strictEqual(engine.getModelPath(), modelPath);
  });

  it('runs the llamafile with the configured settings and returns its trimmed output', async () => {
    const llamafilePath = await fakeLlamafile('echo-args', 'echo; printf "%s\\n" "$@"; echo');
    const engine = new NanoMindEngine({ modelPath, llamafilePath });

    const result = await engine.infer('scan this project');

    const expected = [
      '-m', modelPath,
      '--temp', '0.1',
      '-n', '256',
      '-p', 'scan this project',
      '--no-display-prompt',
      '--log-disable',
    ].join('\n');
    assert.strictEqual(result.text, expected);
    assert.strictEqual(result.tokensUsed, Math.ceil(expected.length / 4));
    assert.ok(result.latencyMs >= 0);
    assert.ok(['local-fast', 'local-full'].includes(result.tier));
  });

  it('lets a call override the temperature and token limit', async () => {
    const llamafilePath = await fakeLlamafile('echo-settings', 'echo "$4 $6"');
    const engine = new NanoMindEngine({ modelPath, llamafilePath, temperature: 0.7, maxTokens: 64 });

    assert.strictEqual((await engine.infer('hi')).text, '0.7 64');
    assert.strictEqual((await engine.infer('hi', { temperature: 0, maxTokens: 8 })).text, '0 8');
  });

  it('rejects when the llamafile exits with an error', async () => {
    const llamafilePath = await fakeLlamafile('fails', 'echo "model load failed" >&2; exit 3');
    const engine = new NanoMindEngine({ modelPath, llamafilePath });

    await assert.rejects(engine.infer('hi'), /^Error: Inference failed: /);
  });

  it('classifies into the category the model names on its first line', async () => {
    const llamafilePath = await fakeLlamafile('names-scan', 'echo "  Scan"; echo "trust_query"');
    const engine = new NanoMindEngine({ modelPath, llamafilePath });

    const result = await engine.classify('check my agent', ['trust_query', 'scan']);

    assert.deepStrictEqual(result, { category: 'scan', confidence: 0.8 });
  });

  it('falls back to the first category when the model names none of them', async () => {
    const llamafilePath = await fakeLlamafile('names-none', 'echo "unknown"');
    const engine = new NanoMindEngine({ modelPath, llamafilePath });

    const result = await engine.classify('check my agent', ['trust_query', 'scan']);

    assert.strictEqual(result.category, 'trust_query');
  });

  it('hashes a file with SHA-256', async () => {
    const expected = createHash('sha256').update('not a real model').digest('hex');

    assert.strictEqual(await NanoMindEngine.computeFileHash(modelPath), expected);
  });
});

describe('test script', () => {
  it('loads the TypeScript sources on a Node release that leaves type stripping off', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const nodeFlags = pkg.scripts.test.split(' ').filter((arg: string) => arg.startsWith('--') && arg !== '--test');

    // Node 22 before 22.18 does not strip types by default; a flag in the script overrides NODE_OPTIONS.
    const run = spawnSync(process.execPath, [...nodeFlags, fileURLToPath(new URL('./index.ts', import.meta.url))], {
      env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' },
      encoding: 'utf8',
    });

    assert.strictEqual(run.status, 0, run.stderr);
  });
});
