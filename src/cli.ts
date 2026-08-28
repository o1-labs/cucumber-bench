import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCases } from './caseStore.js';
import { resolveModelConfig } from './config.js';
import { loadBenchmarks, loadHarnesses, type HarnessManifest } from './manifests.js';
import { dockerArgv, sandboxedSystem } from './systems/sandboxed.js';
import { startProxy } from './proxy.js';
import { runSuite } from './runner.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';

// usage: npm run bench -- [--systems direct,legal-v1] [--suites asqa] [--reps 1]
// systems default to every harness under harnesses/, suites to every benchmark
let { values } = parseArgs({
  options: {
    systems: { type: 'string' },
    suites: { type: 'string' },
    reps: { type: 'string', default: '1' },
  },
});

let harnesses = await loadHarnesses('harnesses');
let benchmarks = await loadBenchmarks('benchmarks');
let cases = await loadCases('benchmarks');
if (values.suites) {
  let wanted = values.suites.split(',').map((s) => s.trim());
  cases = cases.filter((c) => wanted.includes(c.pub.suite));
  if (cases.length === 0) throw Error(`no cases in suites ${values.suites}. available: ${benchmarks.map((b) => b.name).join(', ')}`);
}
let graders = benchmarks.flatMap((b) => b.graders);

// every harness is a sandbox entry script: child process by default,
// a docker container with BENCH_SANDBOX=docker
function argvFor(h: HarnessManifest): string[] {
  if (process.env.BENCH_SANDBOX === 'docker') return dockerArgv(h.image, h.imageEntry);
  let entry = join(h.dir, h.entry);
  return entry.endsWith('.ts') ? [process.execPath, 'node_modules/tsx/dist/cli.mjs', entry] : [process.execPath, entry];
}
let available = new Map(harnesses.map((h) => [h.name, sandboxedSystem(h.name, argvFor(h), h.suites)]));
let systems = (values.systems?.split(',') ?? [...available.keys()]).map((name) => {
  let s = available.get(name.trim());
  if (!s) throw Error(`unknown system: ${name}. available: ${[...available.keys()].join(', ')}`);
  return s;
});
// with --suites, only harnesses that list one of those suites run
if (values.suites) {
  let wanted = values.suites.split(',').map((s) => s.trim());
  systems = systems.filter((s) => s.suites?.some((suite) => wanted.includes(suite)));
  if (systems.length === 0) throw Error(`no selected harness lists a suite in ${values.suites}`);
}

let cfg = resolveModelConfig();

// systems reach the model only through the accounting proxy
let proxy = await startProxy({
  upstreamUrl: cfg.baseUrl,
  upstreamKey: cfg.apiKey,
  safetyModel: cfg.safetyModel,
  judgeModel: cfg.judgeModel,
  defaultTemperature: cfg.temperature,
  timeoutMs: cfg.timeoutMs,
  maxCalls: Number(process.env.BENCH_MAX_CALLS ?? 20),
  maxJudgeCalls: Number(process.env.BENCH_MAX_JUDGE_CALLS ?? 100),
});
let runId = new Date().toISOString().replace(/[:.]/g, '-');
let outDir = join('runs', runId);
await mkdir(outDir, { recursive: true });

console.log(`run ${runId}: ${cases.length} cases, systems [${systems.map((s) => s.name).join(', ')}], model ${cfg.model}, reps ${values.reps}`);

let lines: string[] = [];
let records = await runSuite({
  runId,
  cases,
  systems,
  graders,
  model: cfg.model,
  proxy,
  repetitions: Number(values.reps),
  onRecord({ run, grades, judge }) {
    let verdict = grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ');
    console.log(
      `  ${verdict} ${run.caseId} [${run.system}, rep ${run.repetition}] ${run.latencyMs}ms ` +
        `${grades.map((g) => g.detail ?? '').join('; ')}${run.error ? ` error: ${run.error}` : ''}`,
    );
    lines.push(JSON.stringify({ run, grades, judge }));
  },
});

await proxy.close();
await writeFile(join(outDir, 'results.jsonl'), lines.join('\n') + '\n');
let report = buildReport(runId, cfg.model, cases, records);
await writeFile(join(outDir, 'report.md'), report);
let help = {
  systems: Object.fromEntries(harnesses.map((h) => [h.name, h.description ?? ''])),
  graders: Object.fromEntries(graders.map((g) => [g.name, g.description ?? ''])),
};
await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cfg.model, cases, records, help));

console.log('\n' + report);
console.log(`written to ${outDir}`);
