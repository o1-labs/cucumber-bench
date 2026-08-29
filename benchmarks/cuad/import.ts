import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

// usage: npx tsx benchmarks/cuad/import.ts --data <path to CUADv1.json> [--count 100] [--skip 0] [--suite cuad] [--out benchmarks/cuad/cases]
// a development set: --count 15 --skip 100 --suite cuad-dev --out benchmarks/cuad-dev/cases
// the data file is data.zip from https://github.com/TheAtticusProject/cuad (CC BY 4.0), Hendrycks et al. 2021.
// one case = one contract split into numbered passages + one clause question. the cases form one
// deterministic sequence (seeded shuffle of the contracts); --skip takes the dev set from later in it,
// so test and dev never share a contract. every third-ish case asks about a clause the contract
// does not have (ABSENT_AT), the majority situation in CUAD.

let { values } = parseArgs({
  options: {
    data: { type: 'string' },
    count: { type: 'string', default: '100' },
    skip: { type: 'string', default: '0' },
    suite: { type: 'string', default: 'cuad' },
    out: { type: 'string', default: 'benchmarks/cuad/cases' },
  },
});
assert(values.data, 'usage: npx tsx benchmarks/cuad/import.ts --data <CUADv1.json> [--count n] [--skip n] [--suite s] [--out dir]');
let count = Number(values.count), skip = Number(values.skip);

// contracts longer than this are left out: about 30 passages, the size of an asqa prompt
const MAX_WORDS = 6000;
const PASSAGE_WORDS = 200;
// the clause types with enough answered questions among the short contracts; the five
// metadata types (document name, parties, dates) are not clauses and are left out
const TYPES = [
  'Governing Law', 'Anti-Assignment', 'License Grant', 'Cap On Liability', 'Termination For Convenience',
  'Renewal Term', 'Revenue/Profit Sharing', 'Exclusivity', 'Audit Rights', 'Post-Termination Services',
  'Minimum Commitment', 'Non-Compete',
];
// case indexes i with i % 10 in this set ask about a clause the contract does not have: 30%
const ABSENT_AT = [2, 5, 8];

const INSTRUCTIONS =
  'Instruction: You are given a contract, split into numbered passages, and a question about one type of clause. ' +
  'Write an accurate and concise answer that states what the contract says on this point and quotes the relevant clause. ' +
  'Cite the passages that contain the clause inline as [1][2]. Cite at least one passage for every factual claim, ' +
  'and only passages that contain the clause. If the contract contains no such clause, say so and cite nothing.';

type Doc = { title: string; text: string };
type Contract = { title: string; context: string; qas: { category: string; details: string; answers: { text: string; answer_start: number }[] }[] };

let raw: any = JSON.parse(await readFile(values.data, 'utf8'));
let contracts: Contract[] = raw.data.map((d: any) => ({
  title: d.title,
  context: d.paragraphs[0].context,
  qas: d.paragraphs[0].qas.map((q: any) => ({
    category: q.id.split('__').pop(),
    details: q.question.replace(/^.*?Details: /s, ''),
    answers: q.answers,
  })),
}));
contracts = contracts.filter((c) => c.context.split(/\s+/).length <= MAX_WORDS);
contracts.sort((a, b) => (a.title < b.title ? -1 : 1));
shuffle(contracts, 20260829);

// the worked examples: the shortest contract with one of the clauses, and the shortest other
// contract without one
let byLength = [...contracts].sort((a, b) => a.context.length - b.context.length);
let demoContracts: Contract[] = [];
let examples = [true, false].map((want) => {
  let c = byLength.find((c) => !demoContracts.includes(c) && c.qas.some((q) => TYPES.includes(q.category) && (q.answers.length > 0) === want))!;
  demoContracts.push(c);
  let q = c.qas.find((q) => TYPES.includes(q.category) && (q.answers.length > 0) === want)!;
  let { docs, clauses } = build(c, q);
  return { q: prompt(c, q, docs), a: demoAnswer(q, clauses) };
});
contracts = contracts.filter((c) => !demoContracts.includes(c));

await mkdir(values.out, { recursive: true });
let used = new Map<string, number>();
let emitted = 0, written = 0;
for (let c of contracts) {
  if (written >= count) break;
  let i = emitted;
  let absent = ABSENT_AT.includes(i % 10);
  // of the types this contract can serve, the one used least so far (ties: TYPES order), so
  // the set stays balanced; counted over skipped cases too, so --skip continues the same sequence
  let fitting = c.qas.filter((q) => TYPES.includes(q.category) && (q.answers.length > 0) !== absent);
  if (fitting.length === 0) continue;
  let q = fitting.sort((a, b) => (used.get(a.category) ?? 0) - (used.get(b.category) ?? 0) || TYPES.indexOf(a.category) - TYPES.indexOf(b.category))[0];
  used.set(q.category, (used.get(q.category) ?? 0) + 1);
  emitted++;
  if (i < skip) continue;

  let { docs, clauses } = build(c, q);
  let id = `${values.suite}-${String(i).padStart(3, '0')}`;
  let pub = {
    id,
    suite: values.suite,
    task: 'cuad',
    instructions: INSTRUCTIONS,
    examples,
    input: prompt(c, q, docs),
    docs,
    _source: `TheAtticusProject/cuad CUADv1.json, contract "${c.title}", question "${q.category}", ${PASSAGE_WORDS}-word passages`,
  };
  let priv = { id, graders: ['clause-recall', 'clause-precision', 'citation-support'], clauses };
  await writeFile(join(values.out, `${id}.public.json`), JSON.stringify(pub, null, 2) + '\n');
  await writeFile(join(values.out, `${id}.private.json`), JSON.stringify(priv, null, 2) + '\n');
  written++;
  console.log(`${id}: ${q.category}, ${docs.length} passages, ${clauses.length} clause(s)`);
}
assert(written === count, `only ${written} of ${count} cases could be built`);
console.log(`written to ${values.out}`);

// internal helpers

// the contract as passages of about PASSAGE_WORDS words, cut at sentence ends, with the
// gold clauses mapped to the passages that contain them (by character offsets)
function build(c: Contract, q: Contract['qas'][number]) {
  let bounds: { start: number; end: number }[] = [];
  let start = 0, words = 0;
  for (let m of c.context.matchAll(/[^.!?]*[.!?]+\s*|[^.!?]+$/g)) {
    words += m[0].split(/\s+/).filter(Boolean).length;
    if (words >= PASSAGE_WORDS) {
      bounds.push({ start, end: m.index! + m[0].length });
      start = m.index! + m[0].length;
      words = 0;
    }
  }
  if (start < c.context.length) bounds.push({ start, end: c.context.length });
  let docs: Doc[] = bounds.map((b, i) => ({
    title: `${c.title}, part ${i + 1} of ${bounds.length}`,
    text: c.context.slice(b.start, b.end).replace(/\s+/g, ' ').trim(),
  }));
  let clauses = q.answers.map((a) => {
    let s = a.answer_start, e = s + a.text.length;
    let passages = bounds.map((b, i) => (b.start < e && s < b.end ? i : -1)).filter((i) => i >= 0);
    assert(passages.length > 0, `clause not mapped in ${c.title}`);
    return { text: a.text.replace(/\s+/g, ' ').trim(), passages };
  });
  return { docs, clauses };
}

function prompt(c: Contract, q: Contract['qas'][number], docs: Doc[]) {
  let passages = docs.map((d, i) => `Document [${i + 1}](Title: ${d.title}): ${d.text}`).join('\n');
  return `Question: Does the contract "${c.title}" contain a "${q.category}" clause? (${q.category}: ${q.details})\n\n${passages}`;
}

// a worked answer built from the gold: quote the clause and cite its passages, or state the absence
function demoAnswer(q: Contract['qas'][number], clauses: { text: string; passages: number[] }[]) {
  if (clauses.length === 0) return `The contract contains no "${q.category}" clause.`;
  let parts = clauses.map((cl) => `"${cl.text}" ${cl.passages.map((p) => `[${p + 1}]`).join('')}`);
  return `Yes. The contract contains a "${q.category}" clause: ${parts.join(' It also states: ')}.`;
}

// deterministic in-place shuffle (mulberry32), so the same seed gives the same case sequence
function shuffle<T>(a: T[], seed: number) {
  let s = seed >>> 0;
  let rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    let j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
