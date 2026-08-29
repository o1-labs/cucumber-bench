import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { loadProject, startProxyFor } from './project.js';
import { judgeVia } from './judge.js';
import { pool } from './runner.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';
import type { RunRecord } from './runner.js';
import type { GradeResult } from './types.js';

// usage: npm run regrade -- runs/<runId> [--judge <model>] [--concurrency 1]
// grades the stored outputs of a run again with the current graders, without running
// any harness. --judge replaces every benchmark's judge: use it to compare judges on
// identical outputs. --concurrency: records graded at once.
let { values, positionals } = parseArgs({
  options: { judge: { type: 'string' }, concurrency: { type: 'string', default: '1' } },
  allowPositionals: true,
});
let runDir = positionals[0];
assert(runDir, 'usage: npm run regrade -- runs/<runId> [--judge <model>] [--concurrency n]');

let jsonl = await readFile(join(runDir, 'results.jsonl'), 'utf8');
let old: RunRecord[] = jsonl.trim().split('\n').map((line) => JSON.parse(line));
let project = await loadProject({ judgeOverride: values.judge });
let { cfg, cases, graders, help, judgeFor } = project;
let caseOf = new Map(cases.map((c) => [c.pub.id, c]));
let proxy = await startProxyFor(cfg);

let runId = `${runDir.replace(/\/+$/, '').split('/').pop()}-regrade-${new Date().toISOString().replace(/[:.]/g, '-')}`;
let outDir = join('runs', runId);
await mkdir(outDir, { recursive: true });
console.log(`regrade ${runId}: ${old.length} runs, judge ${values.judge ?? 'per benchmark'} at ${cfg.judgeBaseUrl}`);

// records keep the order of the input file, whatever the concurrency
let records: RunRecord[] = new Array(old.length);
await pool(old, Number(values.concurrency), async ({ run }, i) => {
  let c = caseOf.get(run.caseId);
  assert(c, `regrade: case ${run.caseId} not found under benchmarks/`);
  let judgeToken = proxy.register(`${runId}/${run.caseId}/rep${run.repetition}/judge`);
  let ctx = { judge: judgeVia(proxy, judgeToken, judgeFor(c.pub.suite)) };
  let grades: GradeResult[] = [];
  for (let name of c.priv.graders) {
    let grader = graders.find((g) => g.name === name);
    assert(grader, `regrade: no grader named ${name}`);
    try {
      grades.push(await grader.grade(c.pub, c.priv, run, ctx));
    } catch (err: any) {
      grades.push({ grader: name, pass: false, score: 0, detail: `grader error: ${String(err?.message ?? err)}` });
    }
  }
  records[i] = { run, grades, judge: proxy.usage(judgeToken) };
  console.log(`  ${grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ')} ${run.caseId} [${run.system}, rep ${run.repetition}] ${grades.map((g) => g.detail ?? '').join('; ')}`);
});

await proxy.close();
await writeFile(join(outDir, 'results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
let report = buildReport(runId, cases, records, graders);
await writeFile(join(outDir, 'report.md'), report);
await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cases, records, help));
console.log('\n' + report);
console.log(`written to ${outDir}`);
