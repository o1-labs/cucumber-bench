import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { loadCases } from './caseStore.js';

// usage: npm run import -- --task hearsay [--count 5] [--out cases/legalbench]
// pulls new test-split rows for a task we already have cases for; task metadata
// (instructions, examples, question, choices) is copied from an existing case
let { values } = parseArgs({
  options: {
    task: { type: 'string' },
    count: { type: 'string', default: '5' },
    out: { type: 'string', default: 'cases/legalbench' },
  },
});
assert(values.task, 'usage: npm run import -- --task <legalbench task> [--count n] [--out dir]');
let task = values.task;
let count = Number(values.count);
assert(count >= 1, `import: count must be >= 1, got ${values.count}`);

let existing = await loadCases('cases');
let template = existing.find((c) => c.pub.task === task)?.pub;
assert(template, `import: no case with task ${task} under cases/ to copy instructions from`);

// skip ids we already have, in cases/ or in the output dir
let have = new Set(existing.map((c) => c.pub.id));
try {
  for (let f of await readdir(values.out)) {
    let m = f.match(/^(.+)\.public\.json$/);
    if (m) have.add(m[1]);
  }
} catch {}

// datasets-server caps one request at 100 rows; every current task fits
let url =
  'https://datasets-server.huggingface.co/rows?dataset=nguha%2Flegalbench' +
  `&config=${encodeURIComponent(task)}&split=test&offset=0&length=100`;
let res = await fetch(url);
assert(res.ok, `import: datasets-server returned ${res.status}`);
let data: any = await res.json();

// group fresh rows by gold answer, then pick round-robin so labels stay balanced
let groups = new Map<string, any[]>();
for (let { row } of data.rows) {
  let id = caseId(task, row.index);
  if (have.has(id)) continue;
  let g = groups.get(row.answer) ?? [];
  g.push(row);
  groups.set(row.answer, g);
}
let picked: any[] = [];
picking: while (picked.length < count) {
  let before = picked.length;
  for (let g of groups.values()) {
    let row = g.shift();
    if (!row) continue;
    picked.push(row);
    if (picked.length >= count) break picking;
  }
  if (picked.length === before) break; // task exhausted
}

await mkdir(values.out, { recursive: true });
for (let row of picked) {
  let id = caseId(task, row.index);
  let pub = {
    id,
    suite: template.suite,
    task,
    instructions: template.instructions,
    examples: template.examples,
    input: row.text.trim(),
    question: template.question,
    choices: template.choices,
    _source: `nguha/legalbench, config ${task}, test split, row index ${row.index}`,
  };
  let priv = { id, graders: ['exact'], answer: row.answer };
  await writeFile(join(values.out, `${id}.public.json`), JSON.stringify(pub, null, 2) + '\n');
  await writeFile(join(values.out, `${id}.private.json`), JSON.stringify(priv, null, 2) + '\n');
  console.log(`${id}: ${row.answer}`);
}
console.log(`${picked.length} new cases written to ${values.out}`);

// internal helpers

function caseId(task: string, index: number): string {
  return `${task}-${String(index).padStart(3, '0')}`;
}
