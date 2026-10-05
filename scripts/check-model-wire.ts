import { checkModelWire } from '../server/model-check.ts';
import { mkdir } from 'node:fs/promises';
// Explicit opt-in: one short request using the existing ChatGPT login.
const dir = new URL('../.model-check-runtime/', import.meta.url).pathname;
await mkdir(dir, { recursive: true, mode: 0o700 });
console.log(JSON.stringify(await checkModelWire(dir, { model: process.argv[2] || 'gpt-6-astra', effort: process.argv[3] || 'low', mode: 'default' }), null, 2));
