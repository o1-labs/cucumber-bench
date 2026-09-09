import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { RunRecord } from '../../src/runner.js';
import { breakdown, tally, truncationOf, type Counts } from './tally.js';

// usage: npx tsx benchmarks/longbench-v2/summary.ts runs/<runId>
// the LongBench v2 numbers of a run: per system, the outcome counts behind the accuracy, the
// coverage, and the accuracy by difficulty, length, domain and sub-domain, with the sample sizes;
// for a truncating system, complete and truncated documents apart. the metadata comes from the
// private cases, the outcomes from results.jsonl. written to summary.md in the run folder
let runDir = process.argv[2];
assert(runDir, 'usage: npx tsx benchmarks/longbench-v2/summary.ts runs/<runId>');
let run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
let records: RunRecord[] = (await readFile(join(runDir, 'results.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// the metadata of every case in the run's suites; a dev sample's ids for the "without dev" row
let meta = new Map<string, { [k: string]: string }>();
for (let suite of run.suites as string[]) {
  let dir = join('benchmarks', suite, 'cases');
  for (let f of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.private.json'))) {
    let priv = JSON.parse(await readFile(join(dir, f), 'utf8'));
    if (priv.meta) meta.set(priv.id, priv.meta);
  }
}
let devIds = new Set<string>(await readFile('benchmarks/longbench-v2-dev/sample.json', 'utf8').then((t) => JSON.parse(t).ids, () => []));
let metaOf = (r: RunRecord) => meta.get(r.run.caseId) ?? {};

let lines = [`# LongBench v2 summary`, '', `Run: ${run.runId}${run.complete ? '' : ' **(INCOMPLETE)**'}; suites ${run.suites.join(', ')}; cases ${run.cases.length}; reps ${run.reps}`, ''];
lines.push(
  'Accuracy is correct / eligible. Eligible is every run but the unsupported ones: failed and invalid runs stay in the denominator. ' +
    'Coverage is eligible / runs: the share of the selected cases the system took whole. Unsupported: the document did not fit the context (context_overflow).',
  '',
);
for (let sys of run.systems as { name: string; models: { main: string }; options?: any }[]) {
  let rs = records.filter((r) => r.run.system === sys.name);
  let selected = run.cases.length * run.reps;
  let o = sys.options ?? {};
  lines.push(`## ${sys.name}`, '');
  lines.push(`Model ${sys.models.main}; overflow ${o.overflow ?? 'n/a'}; context ${o.contextTokens ?? 'n/a'} tokens, output ${o.outputTokens ?? 'n/a'}; reasoning ${JSON.stringify(o.reasoning ?? null)}; prompt ${o.prompt ?? 'n/a'}; harness version ${o.version ?? 'n/a'}.`, '');
  lines.push('| selected | runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  let all = tally(rs, selected);
  lines.push(countsRow(all));
  if (all.notRun > 0) lines.push('', `**${all.notRun} of ${selected} jobs have no record: the run is incomplete.**`);
  lines.push('');

  // complete and truncated documents apart, for a truncating system
  let cut = rs.filter((r) => truncationOf(r));
  if (cut.length > 0) {
    let whole = rs.filter((r) => !truncationOf(r));
    let retained = cut.map((r) => truncationOf(r)!).map((t) => t.retained / t.original);
    lines.push(`### Complete vs truncated documents`, '', '| documents | n | correct | invalid | failed | accuracy | mean retained |', '| --- | --- | --- | --- | --- | --- | --- |');
    let w = tally(whole), c = tally(cut);
    lines.push(`| complete | ${w.eligible} | ${w.correct} | ${w.invalid} | ${w.failed} | ${pct(w.accuracy)} | 100% |`);
    lines.push(`| truncated (middle removed) | ${c.eligible} | ${c.correct} | ${c.invalid} | ${c.failed} | ${pct(c.accuracy)} | ${pct(retained.reduce((a, b) => a + b, 0) / retained.length)} |`, '');
  }

  for (let key of ['difficulty', 'length', 'domain', 'sub_domain']) {
    lines.push(`### By ${key.replace('_', '-')}`, '', `| ${key.replace('_', '-')} | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |`, '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (let row of breakdown(rs, (r) => metaOf(r)[key] ?? '(unknown)')) {
      lines.push(`| ${row.value} | ${row.eligible} | ${row.correct} | ${row.invalid} | ${row.failed} | ${row.unsupported} | ${pct(row.accuracy)} | ${pct(row.coverage)} |`);
    }
    lines.push('');
  }

  // the locked set without the dev sample: the number a tuned harness is compared on
  if (run.suites.includes('longbench-v2') && devIds.size > 0) {
    let held = rs.filter((r) => !devIds.has(metaOf(r)._id));
    if (held.length < rs.length) {
      lines.push(`### Without the dev sample (${rs.length - held.length} runs of the ${devIds.size} dev cases left out)`, '');
      lines.push('| runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      let h = tally(held);
      lines.push(`| ${h.records} | ${h.eligible} | ${pct(h.coverage)} | ${h.correct} | ${h.incorrect} | ${h.invalid} | ${h.failed} | ${h.unsupported} | ${pct(h.accuracy)} |`, '');
    }
  }
}

let text = lines.join('\n');
await writeFile(join(runDir, 'summary.md'), text + '\n');
console.log(text);
console.log(`written to ${join(runDir, 'summary.md')}`);

// internal helpers

function countsRow(c: Counts): string {
  return `| ${c.selected} | ${c.records} | ${c.eligible} | ${pct(c.coverage)} | ${c.correct} | ${c.incorrect} | ${c.invalid} | ${c.failed} | ${c.unsupported} | ${pct(c.accuracy)} |`;
}

function pct(x?: number): string {
  return x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`;
}
