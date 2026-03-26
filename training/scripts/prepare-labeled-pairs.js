#!/usr/bin/env node

/**
 * Prepare labeled training pairs from DVAA attack corpus + HMA adversarial payloads.
 * These become the supervised fine-tuning dataset for NanoMind v3.
 *
 * Output format:
 * { input: string, label: string, attackClass: string, evidenceSpans: [start, end][] }
 *
 * Usage: node prepare-labeled-pairs.js --dvaa-path=../../damn-vulnerable-ai-agent --hma-path=../../hackmyagent --output=corpus/sft/
 */

const { parseArgs } = require('node:util');
const { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const { values } = parseArgs({
  options: {
    'dvaa-path': { type: 'string', default: '../../damn-vulnerable-ai-agent' },
    'hma-path': { type: 'string', default: '../../hackmyagent' },
    output: { type: 'string', default: 'corpus/sft/' },
  },
});

const ATTACK_CLASSES = [
  'exfiltration',
  'injection',
  'privilege_escalation',
  'persistence',
  'credential_abuse',
  'lateral_movement',
  'social_engineering',
  'policy_violation',
];

async function main() {
  const dvaaPath = values['dvaa-path'];
  const hmaPath = values['hma-path'];
  const outputDir = values.output;

  mkdirSync(outputDir, { recursive: true });

  const pairs = [];

  // 1. Extract from DVAA vulnerable scenarios
  const dvaaScenarios = join(dvaaPath, 'src', 'scenarios');
  if (existsSync(dvaaScenarios)) {
    const files = readdirSync(dvaaScenarios).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    console.log(`Found ${files.length} DVAA scenario files`);

    for (const file of files) {
      const content = readFileSync(join(dvaaScenarios, file), 'utf-8');
      const attackClass = inferAttackClass(file, content);

      pairs.push({
        input: content.slice(0, 2048), // Truncate to max seq length
        label: 'malicious',
        attackClass,
        source: 'dvaa',
        file,
      });
    }
  } else {
    console.log(`DVAA scenarios not found at ${dvaaScenarios}`);
  }

  // 2. Extract from HMA adversarial payloads
  const hmaPayloads = join(hmaPath, 'src', 'payloads');
  if (existsSync(hmaPayloads)) {
    const files = readdirSync(hmaPayloads, { recursive: true })
      .filter(f => typeof f === 'string' && (f.endsWith('.ts') || f.endsWith('.json')));
    console.log(`Found ${files.length} HMA payload files`);

    for (const file of files) {
      const content = readFileSync(join(hmaPayloads, String(file)), 'utf-8');
      const attackClass = inferAttackClass(String(file), content);

      pairs.push({
        input: content.slice(0, 2048),
        label: 'malicious',
        attackClass,
        source: 'hma_payload',
        file: String(file),
      });
    }
  } else {
    console.log(`HMA payloads not found at ${hmaPayloads}`);
  }

  // 3. Generate benign samples from clean agent configs
  // (Placeholder -- actual benign samples come from Registry corpus)
  pairs.push({
    input: 'This agent reads customer support tickets and provides helpful responses. It has access to the ticketing system API and can update ticket status.',
    label: 'benign',
    attackClass: 'benign',
    source: 'synthetic',
    file: 'synthetic-benign-001',
  });

  // Write output
  writeFileSync(join(outputDir, 'labeled-pairs.json'), JSON.stringify(pairs, null, 2));
  console.log(`\nWrote ${pairs.length} labeled pairs to ${outputDir}`);

  // Write split for evaluation
  const shuffled = pairs.sort(() => Math.random() - 0.5);
  const splitIdx = Math.floor(shuffled.length * 0.8);
  writeFileSync(join(outputDir, 'train.json'), JSON.stringify(shuffled.slice(0, splitIdx), null, 2));
  writeFileSync(join(outputDir, 'eval.json'), JSON.stringify(shuffled.slice(splitIdx), null, 2));
  console.log(`Train: ${splitIdx}, Eval: ${shuffled.length - splitIdx}`);
}

function inferAttackClass(filename, content) {
  const lower = (filename + ' ' + content.slice(0, 500)).toLowerCase();
  if (lower.includes('exfiltrat')) return 'exfiltration';
  if (lower.includes('inject')) return 'injection';
  if (lower.includes('privilege') || lower.includes('escalat')) return 'privilege_escalation';
  if (lower.includes('persist')) return 'persistence';
  if (lower.includes('credential') || lower.includes('cred-')) return 'credential_abuse';
  if (lower.includes('lateral')) return 'lateral_movement';
  if (lower.includes('social') || lower.includes('phish')) return 'social_engineering';
  if (lower.includes('policy') || lower.includes('violat')) return 'policy_violation';
  return 'injection'; // default for unclassified attack scenarios
}

main().catch(console.error);
