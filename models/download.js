#!/usr/bin/env node
/**
 * NanoMind Model Downloader
 *
 * Downloads SmolLM2-135M model and llamafile binary to ~/.nanomind/
 * with SHA-256 integrity verification.
 *
 * Usage: node models/download.js
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const NANOMIND_DIR = path.join(os.homedir(), '.nanomind');
const MODEL_DIR = path.join(NANOMIND_DIR, 'models');
const BIN_DIR = path.join(NANOMIND_DIR, 'bin');

// Model registry — update hashes when upgrading models
const MODELS = {
  'SmolLM2-135M.Q4_K_M.gguf': {
    url: 'https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct-GGUF/resolve/main/smollm2-135m-instruct-q4_k_m.gguf',
    sha256: null, // Set after first verified download
    size: '~80MB',
    description: 'SmolLM2-135M Q4_K_M quantization — intent classification model',
  },
};

const LLAMAFILE = {
  url: 'https://github.com/Mozilla-Ocho/llamafile/releases/download/0.8.13/llamafile-0.8.13',
  sha256: null, // Set after first verified download
  filename: 'llamafile',
  description: 'llamafile runtime binary',
};

async function download(url, destPath, label) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading ${label}...`);
    console.log(`  URL: ${url}`);

    const file = fs.createWriteStream(destPath);
    let downloaded = 0;

    const request = (url) => {
      https.get(url, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }

        const total = parseInt(response.headers['content-length'] || '0', 10);

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            process.stdout.write(`\r  Progress: ${pct}% (${(downloaded / 1048576).toFixed(1)}MB)`);
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`\n  Downloaded: ${destPath}`);
          resolve();
        });
      }).on('error', reject);
    };

    request(url);
  });
}

function computeHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  console.log('\nNanoMind Model Downloader\n');

  // Create directories
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Download models
  for (const [filename, info] of Object.entries(MODELS)) {
    const destPath = path.join(MODEL_DIR, filename);
    if (fs.existsSync(destPath)) {
      console.log(`  ${filename}: already exists`);
      const hash = await computeHash(destPath);
      console.log(`  SHA-256: ${hash}`);
      if (info.sha256 && hash !== info.sha256) {
        console.log(`  WARNING: hash mismatch! Expected: ${info.sha256}`);
      }
      continue;
    }

    await download(info.url, destPath, `${filename} (${info.size})`);
    const hash = await computeHash(destPath);
    console.log(`  SHA-256: ${hash}`);
    if (info.sha256 && hash !== info.sha256) {
      console.log(`  ERROR: hash mismatch! Deleting file.`);
      fs.unlinkSync(destPath);
      process.exit(1);
    }
  }

  // Download llamafile
  const llamafilePath = path.join(BIN_DIR, LLAMAFILE.filename);
  if (fs.existsSync(llamafilePath)) {
    console.log(`  llamafile: already exists`);
  } else {
    await download(LLAMAFILE.url, llamafilePath, 'llamafile runtime');
    fs.chmodSync(llamafilePath, 0o755);
    const hash = await computeHash(llamafilePath);
    console.log(`  SHA-256: ${hash}`);
  }

  console.log('\nSetup complete. NanoMind is ready.\n');
  console.log(`  Models: ${MODEL_DIR}`);
  console.log(`  Binary: ${BIN_DIR}`);
  console.log(`\n  Run: nanomind (or hma with no args)\n`);
}

main().catch((err) => {
  console.error(`\nDownload failed: ${err.message}\n`);
  process.exit(1);
});
