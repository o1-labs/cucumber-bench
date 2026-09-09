import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gitState, loadProject, startProxyFor } from './project.js';
import { runSuite, type RunRecord } from './runner.js';
import { assertResumable, casesHash, jobKey, loadRecords } from './resume.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';

// usage: npm run bench -- [--systems direct,legal-v1] [--suites asqa] [--cases asqa-dev-503] [--reps 1] [--concurrency 1] [--no-details] [--resume runs/<id>]
// systems default to every harness under harnesses/, suites to every benchmark, cases to every case.
// --cases: one or more case ids, e.g. to run a single case many times while tuning a harness.
// concurrency: cases in flight at once; raise it for a hosted model, keep 1 for a local gpu.
// --resume: continue an interrupted run in its folder, with the same flags: the jobs that have a
// record are skipped, and run.json must agree on everything that shaped the records
let { values } = parseArgs({
  options: {
    systems: { type: 'string' },
    suites: { type: 'string' },
    cases: { type: 'string' },
    reps: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
    'no-details': { type: 'boolean', default: false },
    resume: { type: 'string' },
  },
});
// --no-details: no gold-derived grade details on the console or in report.md, for a report of a
// locked test set that is shared. results.jsonl always has them
let details = !values['no-details'];

// only the selected suites' cases are loaded (a long-document suite is hundreds of MB)
let project = await loadProject({ suites: values.suites?.split(',').map((s) => s.trim()) });
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
let resume = values.resume?.replace(/\/+$/, '');
let runId = resume ? basename(resume) : new Date().toISOString().replace(/[:.]/g, '-');
let outDir = resume ?? join('runs', runId);
await mkdir(outDir, { recursive: true });

// run.json: what this run is, written at the start (an interrupted run keeps complete: false)
// and again at the end with the count of records
let expected = systems.reduce((n, s) => n + cases.filter((c) => !s.suites || s.suites.includes(c.pub.suite)).length, 0) * Number(values.reps);
let manifest = {
  runId,
  command: process.argv.slice(2),
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  complete: false,
  // every resume: when, with which command, at which code state
  resumed: [] as { at: string; command: string[]; git: ReturnType<typeof gitState> }[],
  expectedJobs: expected,
  records: 0,
  // providers: where this system's model calls went, per model; the default upstream otherwise
  systems: systems.map((s) => {
    let h = project.harnesses.find((x) => x.name === s.name);
    return { name: s.name, models: s.models, maxCalls: h?.maxCalls ?? null, providers: h?.providers ?? null, options: h?.options ?? null };
  }),
  suites: [...new Set(cases.map((c) => c.pub.suite))],
  judges: Object.fromEntries([...new Set(cases.map((c) => c.pub.suite))].map((s) => [s, project.judgeFor(s)])),
  cases: cases.map((c) => c.pub.id),
  // the case files' content: a rebuilt dataset makes old records incomparable
  casesHash: casesHash(cases),
  reps: Number(values.reps),
  concurrency: Number(values.concurrency),
  sandbox: process.env.BENCH_SANDBOX === 'docker' ? 'docker' : 'process',
  providers: { baseUrl: cfg.baseUrl, judgeBaseUrl: cfg.judgeBaseUrl, temperature: cfg.temperature },
  git: gitState(),
};

// a resumed run keeps its records and skips their jobs; run.json keeps the original start
// and command, and records this resume
let prior: RunRecord[] = [];
if (resume) {
  let stored = JSON.parse(await readFile(join(outDir, 'run.json'), 'utf8'));
  for (let w of assertResumable(stored, manifest)) console.warn(w);
  prior = await loadRecords(outDir);
  let { startedAt, command, git } = manifest;
  manifest = { ...manifest, startedAt: stored.startedAt, command: stored.command, git: stored.git, resumed: [...(stored.resumed ?? []), { at: startedAt, command, git }] };
  console.log(`resuming ${runId}: ${prior.length} of ${expected} records exist`);
}
let done = new Set(prior.map((r) => jobKey(r.run)));
await writeFile(join(outDir, 'run.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `run ${runId}: ${cases.length} cases, systems [${systems.map((s) => `${s.name} (${s.models.main})`).join(', ')}], ` +
    `reps ${values.reps}, concurrency ${values.concurrency}`,
);
if (process.env.BENCH_SANDBOX !== 'docker') {
  console.log('sandbox: child process (development mode: a harness shares the file system; set BENCH_SANDBOX=docker for isolation)');
}

// every record is appended to results.jsonl at once, so a crash keeps what is done
let resultsPath = join(outDir, 'results.jsonl');
let started = Date.now();
let fresh = await runSuite({
  runId,
  cases,
  systems,
  graders,
  proxy,
  judgeFor: project.judgeFor,
  repetitions: Number(values.reps),
  concurrency: Number(values.concurrency),
  skip: (job) => done.has(jobKey(job)),
  onRecord(record) {
    let { run, grades } = record;
    let verdict = run.skipped ? `SKIP ${run.skipped}` : grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ');
    // +Ns: seconds since the run started, to see the overlap of the jobs
    console.log(
      `  +${Math.round((Date.now() - started) / 1000)}s ${verdict} ${run.caseId} [${run.system}, rep ${run.repetition}] ${run.latencyMs}ms ` +
        `${details ? grades.map((g) => g.detail ?? '').join('; ') : ''}${run.error ? ` error: ${run.error}` : ''}`,
    );
    appendFileSync(resultsPath, JSON.stringify(record) + '\n');
  },
});

await proxy.close();
let records = [...prior, ...fresh.filter(Boolean)];
manifest.finishedAt = new Date().toISOString();
manifest.records = records.length;
manifest.complete = manifest.records === expected;
await writeFile(join(outDir, 'run.json'), JSON.stringify(manifest, null, 2) + '\n');
let report = buildReport(runId, cases, records, graders, { expected, details });
await writeFile(join(outDir, 'report.md'), report);
// the results and the report are written; a chart failure must not hide them
try {
  await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cases, records, help));
} catch (err: any) {
  console.error(`chart not written: ${String(err?.message ?? err)}`);
}

console.log('\n' + report);
console.log(`written to ${outDir}`);
