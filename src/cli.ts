import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCases } from './caseStore.js';
import { resolveModelConfig } from './config.js';
import { dockerArgv, sandboxedSystem } from './systems/sandboxed.js';
import { startProxy } from './proxy.js';
import { exactGrader } from './graders/exact.js';
import { leakageGrader, removalGrader, retentionGrader } from './graders/redaction.js';
import { runSuite } from './runner.js';
import { buildReport } from './report.js';
import { buildChartHtml } from './chart.js';

// usage: npm run bench -- [--systems direct,placeholder,harness] [--reps 1]
let { values } = parseArgs({
  options: {
    systems: { type: 'string', default: 'direct,placeholder,harness' },
    reps: { type: 'string', default: '1' },
  },
});

// every system is a sandbox entry script: child process by default,
// a docker container from the same image with BENCH_SANDBOX=docker
let entry = (file: string) =>
  process.env.BENCH_SANDBOX === 'docker'
    ? dockerArgv('cucumber-bench-sandbox', `/app/${file}`)
    : [process.execPath, `src/sandbox/${file}`];
// the real harness has its own image (it needs the ai sdk); in process mode tsx runs its source
let harnessArgv =
  process.env.BENCH_SANDBOX === 'docker'
    ? dockerArgv('cucumber-bench-harness', '/app/dist/entry.js')
    : [process.execPath, 'node_modules/tsx/dist/cli.mjs', 'harness/src/entry.ts'];
let available = {
  direct: sandboxedSystem('direct', entry('direct-entry.mjs')),
  placeholder: sandboxedSystem('placeholder', entry('placeholder-entry.mjs')),
  harness: sandboxedSystem('harness', harnessArgv),
};
let systems = values.systems.split(',').map((name) => {
  let s = available[name.trim() as keyof typeof available];
  if (!s) throw Error(`unknown system: ${name}. available: ${Object.keys(available).join(', ')}`);
  return s;
});

let cases = await loadCases('cases');
let cfg = resolveModelConfig();

// systems reach the model only through the accounting proxy
let proxy = await startProxy({
  upstreamUrl: cfg.baseUrl,
  upstreamKey: cfg.apiKey,
  safetyModel: cfg.safetyModel,
  defaultTemperature: cfg.temperature,
  timeoutMs: cfg.timeoutMs,
  maxCalls: Number(process.env.BENCH_MAX_CALLS ?? 20),
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
  graders: [exactGrader(), removalGrader(), leakageGrader(), retentionGrader()],
  model: cfg.model,
  proxy,
  repetitions: Number(values.reps),
  onRecord({ run, grades }) {
    let verdict = grades.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.grader}`).join(', ');
    console.log(
      `  ${verdict} ${run.caseId} [${run.system}, rep ${run.repetition}] ${run.latencyMs}ms ` +
        `${grades.map((g) => g.detail ?? '').join('; ')}${run.error ? ` error: ${run.error}` : ''}`,
    );
    lines.push(JSON.stringify({ run, grades }));
  },
});

await proxy.close();
await writeFile(join(outDir, 'results.jsonl'), lines.join('\n') + '\n');
let report = buildReport(runId, cfg.model, cases, records);
await writeFile(join(outDir, 'report.md'), report);
await writeFile(join(outDir, 'chart.html'), buildChartHtml(runId, cfg.model, cases, records));

console.log('\n' + report);
console.log(`written to ${outDir}`);
