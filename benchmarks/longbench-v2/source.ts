import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { PrivateCase, PublicCase } from '../../src/types.js';

export { REVISION, DATA_URL, DATA_SHA256, DATA_PATH, COUNT, FIELDS, loadData, toCase, seededSample, type Item };

// LongBench v2 (Bai et al. 2024, https://arxiv.org/abs/2412.15204): the published evaluation data,
// one data.json of 503 items. the hub calls its split "train"; that does not make it training data
// for our experiments. pinned to a commit of https://huggingface.co/datasets/zai-org/LongBench-v2
// (apache-2.0; older docs say THUDM/LongBench-v2) and to the sha256 of the file. the file is
// 465 MB and stays out of git: fetch.ts downloads it, import.ts builds the cases from it
const REVISION = '2b48e494f2c7a2f0af81aae178e05c7e1dde0fe9';
const DATA_URL = `https://huggingface.co/datasets/zai-org/LongBench-v2/resolve/${REVISION}/data.json`;
const DATA_SHA256 = '15d61c22d92c96900b3c4948b6aeea218d3214b676a65df48e7b8555604c7fe2';
const DATA_PATH = 'benchmarks/longbench-v2/data/data.json';
const COUNT = 503;
// prettier-ignore
const FIELDS = ['_id', 'domain', 'sub_domain', 'difficulty', 'length', 'question', 'choice_A', 'choice_B', 'choice_C', 'choice_D', 'answer', 'context'] as const;

type Item = { [k in (typeof FIELDS)[number]]: string };

// the items, after the checksum and shape checks. fixture: a small test file, no checksum or count
async function loadData(path = DATA_PATH, opts: { fixture?: boolean } = {}): Promise<Item[]> {
  let raw = await readFile(path).catch((err) => {
    assert(err.code !== 'ENOENT', `${path} is missing: run npx tsx benchmarks/longbench-v2/fetch.ts`);
    throw err;
  });
  if (!opts.fixture) {
    let sha = createHash('sha256').update(raw).digest('hex');
    assert(sha === DATA_SHA256, `${path}: sha256 ${sha}, expected ${DATA_SHA256} (revision ${REVISION}); run npx tsx benchmarks/longbench-v2/fetch.ts`);
  }
  let items: Item[] = JSON.parse(raw.toString('utf8'));
  if (!opts.fixture) assert(items.length === COUNT, `${path}: ${items.length} items, expected ${COUNT}`);
  let seen = new Set<string>();
  for (let it of items) {
    for (let f of FIELDS) assert(typeof it[f] === 'string', `item ${it._id}: ${f} is not a string`);
    assert(/^[A-D]$/.test(it.answer), `item ${it._id}: answer ${JSON.stringify(it.answer)} is not A-D`);
    assert(!seen.has(it._id), `item ${it._id} appears twice`);
    seen.add(it._id);
  }
  return items;
}

// one item as a case pair. the system sees the context, the question and the four choices in their
// original order; the answer and the metadata (domain, sub_domain, difficulty, length) are private.
// the context is kept verbatim: the harness trims it as the reference implementation does
function toCase(it: Item, suite: string): { pub: PublicCase; priv: PrivateCase } {
  let id = `${suite}-${it._id}`;
  let pub = {
    id,
    suite,
    task: 'longbench-v2',
    instructions: 'Please read the following text and answer the question below.',
    input: it.context,
    question: it.question,
    choices: [it.choice_A, it.choice_B, it.choice_C, it.choice_D],
    _source: `zai-org/LongBench-v2 data.json at ${REVISION}, item ${it._id}`,
  };
  let priv = {
    id,
    graders: ['mc-answer'],
    answer: it.answer,
    meta: { _id: it._id, domain: it.domain, sub_domain: it.sub_domain, difficulty: it.difficulty, length: it.length },
  };
  return { pub, priv };
}

// n of the items, chosen by a seeded shuffle of their ids (Fisher-Yates over mulberry32), so a
// sample is the same on every machine and does not depend on the order of the input
function seededSample<T extends { _id: string }>(items: T[], n: number, seed: number): T[] {
  let sorted = [...items].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  let rand = mulberry32(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    let j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, n);
}

// internal helpers

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
