import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

// usage: npx tsx benchmarks/asqa/import.ts --data <path to asqa_eval_gtr_top100.json> [--count 15] [--offset 0] [--ndoc 5] [--shot 2] [--suite asqa] [--out benchmarks/asqa/cases]
// a development set: --offset 500 --suite asqa-dev --out benchmarks/asqa-dev/cases
// the data file is inside ALCE-data.tar, see https://github.com/princeton-nlp/ALCE (bash download_data.sh).
// the prompt (instruction + demonstrations) is fetched from the ALCE repository at a fixed
// commit and checked against its sha256, so a later import gives the same cases.
const PROMPT_COMMIT = '8f5b3baa0f1742729203d2f8ed5a4c4e3857d756';
const PROMPT_URL = `https://raw.githubusercontent.com/princeton-nlp/ALCE/${PROMPT_COMMIT}/prompts/asqa_default.json`;
const PROMPT_SHA256 = 'a5d1085a4745897d34138b8b3d9781dafaa9e8b8ff00140c4521d43ba8c7b5c1';

let { values } = parseArgs({
  options: {
    data: { type: 'string' },
    count: { type: 'string', default: '15' },
    offset: { type: 'string', default: '0' },
    ndoc: { type: 'string', default: '5' },
    shot: { type: 'string', default: '2' },
    suite: { type: 'string', default: 'asqa' },
    out: { type: 'string', default: 'benchmarks/asqa/cases' },
  },
});
assert(values.data, 'usage: npx tsx benchmarks/asqa/import.ts --data <asqa_eval_gtr_top100.json> [--count n] [--ndoc n] [--shot n]');
let count = Number(values.count), offset = Number(values.offset), ndoc = Number(values.ndoc), shot = Number(values.shot);

let items: any[] = JSON.parse(await readFile(values.data, 'utf8'));
let res = await fetch(PROMPT_URL);
assert(res.ok, `prompt fetch failed: ${res.status}`);
let promptText = await res.text();
let promptSha = createHash('sha256').update(promptText).digest('hex');
assert(promptSha === PROMPT_SHA256, `prompt file changed: sha256 ${promptSha}, expected ${PROMPT_SHA256}`);
let prompt: any = JSON.parse(promptText);

type Doc = { title: string; text: string };
let formatDocs = (docs: Doc[]) => docs.map((d, i) => `Document [${i + 1}](Title: ${d.title}): ${d.text}`).join('\n');
let pick = (docs: any[]): Doc[] => docs.slice(0, ndoc).map(({ title, text }) => ({ title, text }));

// the demonstrations become worked examples: the same question + documents shape as the input
let examples = prompt.demos.slice(0, shot).map((d: any) => ({
  q: `Question: ${d.question}\n\n${formatDocs(pick(d.docs))}`,
  a: d.answer,
}));

await mkdir(values.out, { recursive: true });
for (let i = offset; i < Math.min(offset + count, items.length); i++) {
  let item = items[i];
  let docs = pick(item.docs);
  let id = `${values.suite}-${String(i).padStart(3, '0')}`;
  let pub = {
    id,
    suite: values.suite,
    task: 'asqa',
    instructions: prompt.instruction,
    examples,
    input: `Question: ${item.question}\n\n${formatDocs(docs)}`,
    docs,
    _source: `princeton-nlp/ALCE-data asqa_eval_gtr_top100.json, item ${i}, top-${ndoc} GTR passages, ${shot} demonstrations from prompts/asqa_default.json at ${PROMPT_COMMIT}`,
  };
  let priv = {
    id,
    graders: ['str-em', 'citation-recall', 'citation-precision'],
    qaPairs: item.qa_pairs.map((p: any) => ({ question: p.question, shortAnswers: p.short_answers })),
  };
  await writeFile(join(values.out, `${id}.public.json`), JSON.stringify(pub, null, 2) + '\n');
  await writeFile(join(values.out, `${id}.private.json`), JSON.stringify(priv, null, 2) + '\n');
  console.log(`${id}: ${item.question} (${priv.qaPairs.length} sub-questions)`);
}
console.log(`written to ${values.out}`);
