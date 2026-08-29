import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadProject, startProxyFor } from './project.js';
import { runSuite } from './runner.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';

// usage: npm run bench -- [--systems direct,legal-v1] [--suites asqa] [--cases asqa-dev-503] [--reps 1] [--concurrency 1]
// systems default to every harness under harnesses/, suites to every benchmark, cases to every case.
// --cases: one or more case ids, e.g. to run a single case many times while tuning a harness.
// concurrency: cases in flight at once; raise it for a hosted model, keep 1 for a local gpu
let { values } = parseArgs({
  options: {
    systems: { type: 'string' },
    suites: { type: 'string' },
    cases: { type: 'string' },
    reps: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
  },
});

let project = await loadProject();
let { cfg, benchmarks, graders, help } = project;
let cases = project.cases;
let systems = (values.systems?.split(',') ?? [...project.systems.keys()]).map((name) => {
  let s = project.systems.get(name.trim());
  if (!s) throw Error(`unknown system: ${name}. available: ${[...project.systems.keys()].join(', ')}`);
  return s;
});
if (values.suites) {
  let wanted = values.suites.split(',').map((s) => s.trim());
  cases = cases.filter((c) => wanted.includes(c.pub.suite));
  if (cases.length === 0) throw Error(`no cases in suites ${values.suites}. available: ${benchmarks.map((b) => b.name).join(', ')}`);
  // only harnesses that list one of the suites run
  systems = systems.filter((s) => s.suites?.some((suite) => wanted.includes(suite)));
  if (systems.length === 0) throw Error(`no selected harness lists a suite in ${values.suites}`);
}
if (values.cases) {
  let wanted = values.cases.split(',').map((s) => s.trim());
  cases = cases.filter((c) => wanted.includes(c.pub.id));
  let missing = wanted.filter((id) => !cases.some((c) => c.pub.id === id));
  if (missing.length) throw Error(`unknown case id(s): ${missing.join(', ')}. ids are the file names under benchmarks/*/cases/`);
  // only harnesses that list the suites of these cases run
  let suites = new Set(cases.map((c) => c.pub.suite));
  systems = systems.filter((s) => !s.suites || s.suites.some((suite) => suites.has(suite)));
}

let proxy = await startProxyFor(cfg);
let runId = new Date().toISOString().replace(/[:.]/g, '-');
let outDir = join('runs', runId);
await mkdir(outDir, { recursive: true });
console.log(
  `run ${runId}: ${cases.length} cases, systems [${systems.map((s) => `${s.name} (${s.models.main})`).join(', ')}], ` +
    `reps ${values.reps}, concurrency ${values.concurrency}`,
);

// every record is appended to results.jsonl at once, so a crash keeps what is done
let resultsPath = join(outDir, 'results.jsonl');
let started = Date.now();
let records = await runSuite({
  runId,
  cases,
  systems,
  graders,
  proxy,
  judgeFor: project.judgeFor,
  repetitions: Number(values.reps),
  concurrency: Number(values.concurrency),
  onRecord({ run, grades, judge }) {
    let verdict = grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ');
    // +Ns: seconds since the run started, to see the overlap of the jobs
    console.log(
      `  +${Math.round((Date.now() - started) / 1000)}s ${verdict} ${run.caseId} [${run.system}, rep ${run.repetition}] ${run.latencyMs}ms ` +
        `${grades.map((g) => g.detail ?? '').join('; ')}${run.error ? ` error: ${run.error}` : ''}`,
    );
    appendFileSync(resultsPath, JSON.stringify({ run, grades, judge }) + '\n');
  },
});

await proxy.close();
let report = buildReport(runId, cases, records, graders);
await writeFile(join(outDir, 'report.md'), report);
await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cases, records, help));

console.log('\n' + report);
console.log(`written to ${outDir}`);
