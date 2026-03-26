#!/usr/bin/env node

/**
 * Collect public skills corpus from the OpenA2A Registry.
 * Target: ~50,000 skills for NanoMind v3 pre-training.
 *
 * Usage: node collect-skills-corpus.js --registry-url=https://api.oa2a.org --limit=50000 --output=corpus/pretrain/skills/
 */

const { parseArgs } = require('node:util');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const { values } = parseArgs({
  options: {
    'registry-url': { type: 'string', default: 'https://api.oa2a.org' },
    limit: { type: 'string', default: '50000' },
    output: { type: 'string', default: 'corpus/pretrain/skills/' },
    'dry-run': { type: 'boolean', default: false },
  },
});

async function main() {
  const registryUrl = values['registry-url'];
  const limit = parseInt(values.limit, 10);
  const outputDir = values.output;
  const dryRun = values['dry-run'];

  console.log(`Collecting skills corpus from ${registryUrl}`);
  console.log(`Limit: ${limit}, Output: ${outputDir}, Dry run: ${dryRun}`);

  mkdirSync(outputDir, { recursive: true });

  // Fetch skill packages from Registry
  let offset = 0;
  const batchSize = 100;
  let total = 0;

  while (total < limit) {
    const url = `${registryUrl}/api/v1/registry/packages?type=skill&limit=${batchSize}&offset=${offset}&sort=trust_score:desc`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`Registry returned ${resp.status}. Stopping.`);
        break;
      }

      const data = await resp.json();
      const packages = data.packages || data.data || [];

      if (packages.length === 0) break;

      for (const pkg of packages) {
        if (total >= limit) break;

        // Extract skill content (description + metadata as training sample)
        const sample = {
          id: pkg.id,
          name: pkg.name,
          type: pkg.packageType,
          description: pkg.description || '',
          trustScore: pkg.trustScore || 0,
          trustLevel: pkg.trustLevel || 0,
          label: 'benign', // Registry packages are default benign
        };

        if (!dryRun) {
          writeFileSync(
            join(outputDir, `${total.toString().padStart(6, '0')}.json`),
            JSON.stringify(sample, null, 2)
          );
        }

        total++;
      }

      offset += batchSize;
      process.stdout.write(`\rCollected: ${total}/${limit}`);
    } catch (err) {
      console.error(`\nFetch error at offset ${offset}:`, err.message);
      break;
    }
  }

  console.log(`\nDone. Collected ${total} skill samples.`);

  // Write corpus manifest
  const manifest = {
    source: registryUrl,
    type: 'skills',
    totalSamples: total,
    collectedAt: new Date().toISOString(),
    format: 'json',
  };
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

main().catch(console.error);
