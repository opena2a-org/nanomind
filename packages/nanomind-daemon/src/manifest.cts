const { readFileSync }: typeof import('node:fs') = require('node:fs');
const { join }: typeof import('node:path') = require('node:path');

/**
 * The daemon's own manifest, read once at start-up. This module is .cts so it
 * is CommonJS in every runtime: the NodeNext build, where server.ts compiles
 * to CommonJS and requires it as manifest.cjs, and `node --test
 * --experimental-strip-types`, which runs the .ts sources as ES modules that
 * import it. A CommonJS module that requires an ES module fails with
 * ERR_REQUIRE_ESM on a Node runtime without require(esm); this one is
 * CommonJS on both sides. In both runtimes `__dirname` is the directory
 * holding this file (src/ or dist/), directly under the package root.
 *
 * Type stripping leaves `export` as it is, and CommonJS cannot parse it, so
 * the value is assigned to `exports` and declared for TypeScript.
 *
 * `gitHead` is stamped by `npm publish` into the installed manifest; a source
 * checkout has none, so `/health/ready` reports `commit: null` there.
 */
export interface DaemonManifest {
  version: string;
  gitHead?: unknown;
}

export declare const manifest: DaemonManifest;

exports.manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
