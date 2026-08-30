import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { gitState, loadProject, startProxyFor } from './project.js';
import { judgeVia } from './judge.js';
import { gradeRun, pool } from './runner.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';
import type { RunRecord } from './runner.js';

// usage: npm run regrade -- runs/<runId> [--judge <model>] [--concurrency 1]
// grades the stored outputs of a run again with the current graders, without running
// any harness. --judge replaces every benchmark's judge: use it to compare judges on
// identical outputs. --concurrency: records graded at once.
let { values, positionals } = parseArgs({
  options: { judge: { type: 'string' }, concurrency: { type: 'string', default: '1' }, 'no-details': { type: 'boolean', default: false } },
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
  let judgeModel = judgeFor(c.pub.suite);
  let judgeToken = proxy.register(`${runId}/${run.caseId}/rep${run.repetition}/judge`, { judge: true, models: [judgeModel] });
  let { grades, status } = await gradeRun(c.pub, c.priv, run, graders, { judge: judgeVia(proxy, judgeToken, judgeModel) });
  records[i] = { run, grades, judge: proxy.usage(judgeToken), status };
  console.log(`  ${grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ')} ${run.caseId} [${run.system}, rep ${run.repetition}] ${grades.map((g) => g.detail ?? '').join('; ')}`);
});

await proxy.close();
await writeFile(join(outDir, 'results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
// run.json: the regrade's own provenance; the harness runs are those of the source run
await writeFile(
  join(outDir, 'run.json'),
  JSON.stringify(
    {
      runId,
      regradeOf: runDir,
      command: process.argv.slice(2),
      finishedAt: new Date().toISOString(),
      complete: true,
      records: records.length,
      judges: Object.fromEntries([...new Set(old.map((r) => caseOf.get(r.run.caseId)?.pub.suite ?? ''))].map((s) => [s, judgeFor(s)])),
      providers: { judgeBaseUrl: cfg.judgeBaseUrl },
      git: gitState(),
    },
    null,
    2,
  ) + '\n',
);
let report = buildReport(runId, cases, records, graders, { details: !values['no-details'] });
await writeFile(join(outDir, 'report.md'), report);
// the results and the report are written; a chart failure must not hide them
try {
  await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cases, records, help));
} catch (err: any) {
  console.error(`chart not written: ${String(err?.message ?? err)}`);
}
console.log('\n' + report);
console.log(`written to ${outDir}`);
