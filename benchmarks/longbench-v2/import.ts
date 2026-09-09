import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { DATA_PATH, REVISION, loadData, seededSample, toCase } from './source.js';

// usage: npx tsx benchmarks/longbench-v2/import.ts [--data benchmarks/longbench-v2/data/data.json] [--suite longbench-v2] [--out benchmarks/longbench-v2/cases] [--sample n --seed s]
// the full set: all 503 items. a development set: --suite longbench-v2-dev --out benchmarks/longbench-v2-dev/cases --sample 30 --seed 1;
// it also writes sample.json (revision, seed, ids) next to the suite's benchmark.json, tracked in git,
// so the dev set is known without the data. the cases stay out of git (465 MB); the out folder is
// rebuilt from scratch, so a stale case never survives. the data comes from fetch.ts
let { values } = parseArgs({
  options: {
    data: { type: 'string', default: DATA_PATH },
    suite: { type: 'string', default: 'longbench-v2' },
    out: { type: 'string', default: 'benchmarks/longbench-v2/cases' },
    sample: { type: 'string' },
    seed: { type: 'string' },
  },
});
let { suite, out } = values as { suite: string; out: string };
assert((values.sample === undefined) === (values.seed === undefined), '--sample and --seed go together');

let items = await loadData(values.data);
if (values.sample !== undefined) {
  let n = Number(values.sample), seed = Number(values.seed);
  assert(n >= 1 && n <= items.length, `--sample must be between 1 and ${items.length}`);
  items = seededSample(items, n, seed);
  let record = { revision: REVISION, seed, count: n, ids: items.map((it) => it._id) };
  await writeFile(join(out, '..', 'sample.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`sample of ${n} with seed ${seed}, ids in ${join(out, '..', 'sample.json')}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (let it of items) {
  let { pub, priv } = toCase(it, suite);
  await writeFile(join(out, `${pub.id}.public.json`), JSON.stringify(pub) + '\n');
  await writeFile(join(out, `${pub.id}.private.json`), JSON.stringify(priv, null, 2) + '\n');
}
console.log(`${items.length} cases written to ${out} (revision ${REVISION})`);
