// Sends out/run.json (written by run.mjs) to the web backend's ingest endpoint.
// Env: PUSH_URL (e.g. https://kiuas.example.workers.dev/api/ingest), PUSH_TOKEN.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PUSH_URL, PUSH_TOKEN } = process.env;
if (!PUSH_URL || !PUSH_TOKEN) {
  console.log('PUSH_URL/PUSH_TOKEN not set; skipping push');
  process.exit(0);
}

const body = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'run.json'));
const res = await fetch(PUSH_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PUSH_TOKEN}` },
  body,
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
console.log(`push: HTTP ${res.status} ${text.slice(0, 500)}`);
if (!res.ok) process.exit(1);
