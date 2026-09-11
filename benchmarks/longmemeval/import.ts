import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { buildCase, splitIds, type Item } from './build.js';

// usage: npm run import:longmemeval [-- --variant s,oracle] [--dev 15] [--count 100] [--seed longmemeval-v1] [--data benchmarks/longmemeval/data]
// the cases are not tracked (see .gitignore): this script rebuilds them from the pinned source.
//
// LongMemEval (Wu et al., ICLR 2025), MIT: https://github.com/xiaowu0162/LongMemEval, commit 9e0b455f4ef0e2ab8f2e582289761153549043fc.
// the data is the cleaned release on Hugging Face (MIT), pinned to its commit and sha256 below:
// https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned. a file already under --data is
// verified, not downloaded again.
//
// variants: s (about 48 sessions, about 120k tokens per case: the benchmark) and oracle (the
// evidence sessions only: the upper bound, cheap to tune on). m (about 500 sessions, over 1M tokens
// per case) exceeds every lane's context and is not supported.
// suites: s -> longmemeval-dev (--dev cases) and longmemeval (--count cases, 'all' for the rest);
// oracle -> longmemeval-oracle-dev and longmemeval-oracle, with the same question ids, so a dev
// case has the same split in both variants. the split is stratified by question type from --seed.
const DATA_COMMIT = '98d7416c24c778c2fee6e6f3006e7a073259d48f';
const SOURCES = {
  s: { file: 'longmemeval_s_cleaned.json', sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442', suite: 'longmemeval' },
  oracle: { file: 'longmemeval_oracle.json', sha256: '821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c', suite: 'longmemeval-oracle' },
};
const EXPECTED_ITEMS = 500;

let { values } = parseArgs({
  options: {
    variant: { type: 'string', default: 's,oracle' },
    dev: { type: 'string', default: '15' },
    count: { type: 'string', default: '100' },
    seed: { type: 'string', default: 'longmemeval-v1' },
    data: { type: 'string', default: 'benchmarks/longmemeval/data' },
  },
});
let dev = Number(values.dev);
let count: number | 'all' = values.count === 'all' ? 'all' : Number(values.count);
assert(Number.isInteger(dev) && (count === 'all' || Number.isInteger(count)), 'usage: --dev n --count n|all');
let variants = values.variant.split(',').map((v) => v.trim()) as (keyof typeof SOURCES)[];
for (let v of variants) assert(SOURCES[v], `unknown variant ${v}: s or oracle`);

await mkdir(values.data, { recursive: true });
// the split is decided once, from the ids, so every variant gets the same cases
let split: { dev: string[]; test: string[] } | undefined;
for (let variant of variants) {
  let src = SOURCES[variant];
  let path = join(values.data, src.file);
  await fetchPinned(src.file, path);
  let sha = await sha256Of(path);
  assert(sha === src.sha256, `${path}: sha256 ${sha}, expected ${src.sha256}. delete the file to download it again`);
  let items: Item[] = JSON.parse(await readFile(path, 'utf8'));
  assert(items.length === EXPECTED_ITEMS, `${path}: ${items.length} items, expected ${EXPECTED_ITEMS}`);
  let byId = new Map(items.map((it) => [it.question_id, it]));
  assert(byId.size === items.length, `${path}: duplicate question ids`);
  split ??= splitIds(items, { seed: values.seed, dev, count });
  let source = `${src.file} at ${DATA_COMMIT} (sha256 ${src.sha256.slice(0, 12)}), seed ${values.seed}`;
  for (let [suite, ids] of [[`${src.suite}-dev`, split.dev], [src.suite, split.test]] as const) {
    let out = join('benchmarks', suite, 'cases');
    // the folder is generated: an older import with another count must not leave cases behind
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (let id of ids) {
      let item = byId.get(id);
      assert(item, `${path}: the question ${id} of the split is missing`);
      let { pub, priv } = buildCase(item, suite, `${source}, question ${id}`);
      await writeFile(join(out, `${pub.id}.public.json`), JSON.stringify(pub, null, 2) + '\n');
      await writeFile(join(out, `${pub.id}.private.json`), JSON.stringify(priv, null, 2) + '\n');
    }
    console.log(`${suite}: ${ids.length} cases in ${out}`);
  }
}

// internal helpers

// the file from the dataset at its pinned commit, unless it is already there
async function fetchPinned(file: string, path: string) {
  if (await access(path).then(() => true, () => false)) return;
  let url = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${DATA_COMMIT}/${file}`;
  console.log(`downloading ${url}`);
  let res = await fetch(url);
  assert(res.ok && res.body, `download failed: ${res.status} ${url}`);
  let tmp = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
  await rm(path, { force: true });
  await pipeline(createReadStream(tmp), createWriteStream(path));
  await rm(tmp);
}

async function sha256Of(path: string): Promise<string> {
  let hash = createHash('sha256');
  for await (let chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
