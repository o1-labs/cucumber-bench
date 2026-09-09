import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { FILES, TOKENIZER_DIR, TOKENIZER_VERSION } from './src/tokenizer.js';

// usage: npx tsx harnesses/lb2-direct/fetch-tokenizer.ts
// downloads the tokenizer files of the harness's model at the pinned commit into
// harnesses/lb2-direct/tokenizer/ (13 MB, gitignored) and checks their sha256. a file that is
// there and passes the check is kept. needed once before a run, and before npm run sandbox:build
await mkdir(TOKENIZER_DIR, { recursive: true });
for (let [name, { url, sha256 }] of Object.entries(FILES)) {
  let path = new URL(name, TOKENIZER_DIR);
  let raw = await readFile(path).catch(() => undefined);
  if (raw && sha(raw) === sha256) {
    console.log(`${name}: present, checksum ok`);
    continue;
  }
  console.log(`downloading ${url}`);
  let res = await fetch(url);
  assert(res.ok, `download failed: ${res.status} ${res.statusText}`);
  raw = Buffer.from(await res.arrayBuffer());
  assert(sha(raw) === sha256, `${name}: sha256 ${sha(raw)}, expected ${sha256}`);
  await writeFile(path, raw);
  console.log(`${name}: ${raw.length} bytes, checksum ok`);
}
console.log(`tokenizer ${TOKENIZER_VERSION} in ${TOKENIZER_DIR.pathname}`);

function sha(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}
