const { join }: typeof import('node:path') = require('node:path');

/**
 * What `OnnxProcessEngine` needs to start a model host. This module is .cts
 * for the same reason as manifest.cts: it is CommonJS in every runtime, so
 * onnx-process-engine.ts loads it without require(esm) and imports nothing
 * but types from onnx-host.mts. Type stripping leaves `export` as it is, so
 * the values are assigned to `exports` and declared for TypeScript.
 */

/**
 * The model host file, beside this one: src/onnx-host.mts beside
 * src/onnx-host-path.cts under the test runner, dist/onnx-host.mjs beside
 * dist/onnx-host-path.cjs in the build.
 */
export declare const ONNX_HOST_PATH: string;

/** First argument of a forked host; the second is its `HostConfig` as JSON. */
export declare const HOST_ARG: string;

exports.ONNX_HOST_PATH = join(__dirname, __filename.endsWith('.cts') ? 'onnx-host.mts' : 'onnx-host.mjs');
exports.HOST_ARG = '--nanomind-onnx-host';
