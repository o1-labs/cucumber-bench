import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { seededSample } from './source.js';

// usage: npx tsx benchmarks/longbench-v2/select.ts [--suite longbench-v2] [--domain d] [--sub-domain s] [--difficulty easy|hard] [--length short|medium|long] [--sample n --seed s]
// prints the ids of the matching cases, comma separated, for the runner's --cases:
//   npm run bench -- --systems lb2-direct --cases $(npx tsx benchmarks/longbench-v2/select.ts --length short --sample 10 --seed 1)
// the filters read the private cases' metadata, so the selection is reproducible from the case
// files; the runner records the chosen ids in run.json
let { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'longbench-v2' },
    domain: { type: 'string' },
    'sub-domain': { type: 'string' },
    difficulty: { type: 'string' },
    length: { type: 'string' },
    sample: { type: 'string' },
    seed: { type: 'string' },
  },
});
assert((values.sample === undefined) === (values.seed === undefined), '--sample and --seed go together');
let dir = join('benchmarks', values.suite!, 'cases');
let files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.private.json')).sort();
assert(files.length > 0, `no cases in ${dir}: run fetch.ts and import.ts first`);

let wanted = { domain: values.domain, sub_domain: values['sub-domain'], difficulty: values.difficulty, length: values.length };
let picked: { _id: string; id: string }[] = [];
for (let f of files) {
  let priv = JSON.parse(await readFile(join(dir, f), 'utf8'));
  let meta = priv.meta ?? {};
  let ok = Object.entries(wanted).every(([k, v]) => v === undefined || meta[k] === v);
  if (ok) picked.push({ _id: meta._id, id: priv.id });
}
if (values.sample !== undefined) picked = seededSample(picked, Math.min(Number(values.sample), picked.length), Number(values.seed));
assert(picked.length > 0, 'no case matches the filters');
console.error(`${picked.length} case(s)`);
console.log(picked.map((p) => p.id).join(','));
