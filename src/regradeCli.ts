import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadCases } from './caseStore.js';
import { resolveModelConfig } from './config.js';
import { loadBenchmarks, loadHarnesses } from './manifests.js';
import { startProxy } from './proxy.js';
import { judgeVia } from './judge.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';
import type { Record } from './runner.js';
import type { GradeResult } from './types.js';

// usage: npm run regrade -- runs/<runId>
// grades the stored outputs of a run again with the current graders and judge model,
// without running any harness. use it to compare judges on identical outputs.
let runDir = process.argv[2];
assert(runDir, 'usage: npm run regrade -- runs/<runId>');

let jsonl = await readFile(join(runDir, 'results.jsonl'), 'utf8');
let old: Record[] = jsonl.trim().split('\n').map((line) => JSON.parse(line));
let cases = await loadCases('benchmarks');
let caseOf = new Map(cases.map((c) => [c.pub.id, c]));
let benchmarks = await loadBenchmarks('benchmarks');
let graders = benchmarks.flatMap((b) => b.graders);
let harnesses = await loadHarnesses('harnesses');
let cfg = resolveModelConfig();

let proxy = await startProxy({
  upstreamUrl: cfg.baseUrl,
  upstreamKey: cfg.apiKey,
  safetyModel: cfg.safetyModel,
  judgeModel: cfg.judgeModel,
  judgeUpstreamUrl: cfg.judgeBaseUrl,
  judgeUpstreamKey: cfg.judgeApiKey,
  defaultTemperature: cfg.temperature,
  timeoutMs: cfg.timeoutMs,
  maxCalls: Number(process.env.BENCH_MAX_CALLS ?? 20),
  maxJudgeCalls: Number(process.env.BENCH_MAX_JUDGE_CALLS ?? 100),
});

let runId = `${runDir.replace(/\/+$/, '').split('/').pop()}-regrade-${new Date().toISOString().replace(/[:.]/g, '-')}`;
let outDir = join('runs', runId);
await mkdir(outDir, { recursive: true });
console.log(`regrade ${runId}: ${old.length} runs, judge ${cfg.judgeModel} at ${cfg.judgeBaseUrl}`);

let records: Record[] = [];
let lines: string[] = [];
for (let { run } of old) {
  let c = caseOf.get(run.caseId);
  assert(c, `regrade: case ${run.caseId} not found under benchmarks/`);
  let judgeToken = proxy.register(`${runId}/${run.caseId}/rep${run.repetition}/judge`);
  let ctx = { judge: judgeVia(proxy, judgeToken, cfg.judgeModel) };
  let grades: GradeResult[] = [];
  for (let name of c.priv.graders) {
    let grader = graders.find((g) => g.name === name);
    assert(grader, `regrade: no grader named ${name}`);
    grades.push(await grader.grade(c.pub, c.priv, run, ctx));
  }
  let record = { run, grades, judge: proxy.usage(judgeToken) };
  records.push(record);
  lines.push(JSON.stringify(record));
  console.log(`  ${grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ')} ${run.caseId} [${run.system}, rep ${run.repetition}] ${grades.map((g) => g.detail ?? '').join('; ')}`);
}

await proxy.close();
await writeFile(join(outDir, 'results.jsonl'), lines.join('\n') + '\n');
let report = buildReport(runId, `${cfg.model} (regraded with judge ${cfg.judgeModel})`, cases, records, graders);
await writeFile(join(outDir, 'report.md'), report);
let help = {
  systems: Object.fromEntries(harnesses.map((h) => [h.name, h.description ?? ''])),
  graders: Object.fromEntries(graders.map((g) => [g.name, g.description])),
};
await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cfg.model, cases, records, help));
console.log('\n' + report);
console.log(`written to ${outDir}`);
