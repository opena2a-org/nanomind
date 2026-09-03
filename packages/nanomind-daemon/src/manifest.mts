import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The daemon's own manifest, read once at start-up. This module is .mts so it
 * is ESM in every runtime — `node --test --experimental-strip-types` (which
 * runs the .ts sources as ESM) and the NodeNext build (where server.ts
 * compiles to CommonJS and `import.meta` would be a compile error, but this
 * file emits as manifest.mjs and is loaded via require(esm)). In both,
 * `../package.json` resolves from the directory holding this file (src/ or
 * dist/), each directly under the package root.
 *
 * `gitHead` is stamped by `npm publish` into the installed manifest; a source
 * checkout has none, so `/health/ready` reports `commit: null` there.
 */
export interface DaemonManifest {
  version: string;
  gitHead?: unknown;
}

export const manifest: DaemonManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
);
