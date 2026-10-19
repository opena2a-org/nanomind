import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATCIntentHandler } from '@nanomind/atc';
import { handleInput, type NanoMindSession } from './index.ts';
import { listArtifactTypes } from './codegen.ts';

const REGISTRY = 'https://registry.test';
const dirs: string[] = [];

function projectDir(files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-cli-'));
  dirs.push(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
}

async function run(input: string, dir: string): Promise<{ output: string; commands: string[] }> {
  const commands: string[] = [];
  const session: NanoMindSession = {
    cliName: 'hma',
    cliVersion: '0.0.0',
    registryUrl: REGISTRY,
    projectDir: dir,
    onCommand: async (cmd, args) => {
      commands.push(`${cmd} ${args.join(' ')}`);
      return '';
    },
  };
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await handleInput(input, session, new ATCIntentHandler({ registryUrl: REGISTRY }));
  } finally {
    log.mock.restore();
  }
  return { output: lines.join('\n'), commands };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('handleInput: GENERATE', () => {
  it('prints the GitHub Actions workflow for "generate a github action"', async () => {
    const dir = projectDir();
    const { output, commands } = await run('generate a github action', dir);
    assert.ok(!output.includes("I'm not sure how to help"), output);
    assert.ok(output.includes('github-action'), output);
    assert.ok(output.includes('name: Security Scan'), output);
    assert.ok(output.includes('npx hackmyagent secure . --ci'), output);
    assert.ok(output.includes(`package-name: ${path.basename(dir)}`), output);
    assert.deepStrictEqual(commands, [], 'generation runs no CLI command');
  });

  it('uses the type named in the request over the project files', async () => {
    const dir = projectDir(['.gitlab-ci.yml']);
    const { output } = await run('generate a github action', dir);
    assert.ok(output.includes('name: Security Scan'), output);
    assert.ok(!output.includes('security-scan:'), output);
  });

  it('detects the type from the project files when none is named', async () => {
    const dir = projectDir(['.gitlab-ci.yml']);
    const { output } = await run('generate a ci config', dir);
    assert.ok(output.includes('gitlab-ci'), output);
    assert.ok(output.includes('No type named'), output);
    assert.ok(output.includes('security-scan:'), output);
  });

  it('generates every listed type when asked by name as the hint suggests', async () => {
    for (const type of listArtifactTypes()) {
      const { output } = await run(`generate a ${type} config`, projectDir());
      assert.ok(output.includes(`> Generating ${type} config`), `${type}: ${output}`);
    }
  });

  it('passes the session registry URL to the build action', async () => {
    const { output } = await run('create a build action config', projectDir());
    assert.ok(output.includes('opena2a-registry/action'), output);
    assert.ok(output.includes(`registry-url: ${REGISTRY}`), output);
  });
});

describe('handleInput: trust lookups', () => {
  // A trust question and a question about why an agent has its level.
  const REQUESTS = ['what is the trust level of agent:test-agent', 'why is agent:test-agent level 2'];

  it('says no ATC was found when the registry answers 404', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
    for (const request of REQUESTS) {
      const { output } = await run(request, projectDir());
      assert.ok(output.includes('No ATC found for agent'), output);
      assert.ok(!output.includes('Could not look up'), output);
    }
  });

  it('reports a registry error status as a failed lookup that names the registry address', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
    for (const request of REQUESTS) {
      const { output } = await run(request, projectDir());
      assert.strictEqual(
        output,
        `\n  Could not look up agent "test-agent": the registry at ${REGISTRY} answered with status 500.\n`,
      );
    }
  });

  it('reports a registry it cannot reach as a failed lookup that names the registry address', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND registry.test') });
    });
    for (const request of REQUESTS) {
      const { output } = await run(request, projectDir());
      assert.strictEqual(
        output,
        `\n  Could not look up agent "test-agent": the registry at ${REGISTRY} could not be reached` +
          ' (fetch failed: getaddrinfo ENOTFOUND registry.test).\n',
      );
    }
  });
});
