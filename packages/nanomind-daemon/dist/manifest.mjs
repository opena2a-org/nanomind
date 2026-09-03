import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'));
