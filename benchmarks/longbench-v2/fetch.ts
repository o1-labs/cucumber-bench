import { createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { DATA_PATH, DATA_URL, REVISION, loadData } from './source.js';

// usage: npx tsx benchmarks/longbench-v2/fetch.ts [--out benchmarks/longbench-v2/data/data.json]
// downloads data.json (465 MB) at the pinned revision and checks its sha256 and shape. a file that
// is already there is checked, not downloaded again. then build the cases with import.ts
let { values } = parseArgs({ options: { out: { type: 'string', default: DATA_PATH } } });
let out = values.out!;

let present = await access(out).then(() => true, () => false);
if (present) {
  console.log(`${out} exists; checking it`);
} else {
  console.log(`downloading ${DATA_URL}`);
  await mkdir(dirname(out), { recursive: true });
  let res = await fetch(DATA_URL);
  assert(res.ok && res.body, `download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(out));
}
let items = await loadData(out);
console.log(`${out}: ${items.length} items, revision ${REVISION}, checksum ok`);
