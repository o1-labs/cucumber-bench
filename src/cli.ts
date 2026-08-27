import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCases } from './caseStore.js';
import { createModelClient } from './modelClient.js';
import { directSystem } from './systems/direct.js';
import { harnessSystem } from './systems/harness.js';
import { exactGrader } from './graders/exact.js';
import { runSuite } from './runner.js';
import { buildReport } from './report.js';

// usage: npm run bench -- [--systems direct,harness] [--reps 1] [--cases cases] [--out runs]
let { values } = parseArgs({
  options: {
    systems: { type: 'string', default: 'direct,harness' },
    reps: { type: 'string', default: '1' },
    cases: { type: 'string', default: 'cases' },
    out: { type: 'string', default: 'runs' },
  },
});

let available = { direct: directSystem(), harness: harnessSystem() };
let systems = values.systems.split(',').map((name) => {
  let s = available[name.trim() as keyof typeof available];
  if (!s) throw Error(`unknown system: ${name}. available: ${Object.keys(available).join(', ')}`);
  return s;
});

let cases = await loadCases(values.cases);
let model = createModelClient();
let runId = new Date().toISOString().replace(/[:.]/g, '-');
let outDir = join(values.out, runId);
await mkdir(outDir, { recursive: true });

console.log(`run ${runId}: ${cases.length} cases, systems [${systems.map((s) => s.name).join(', ')}], model ${model.model}, reps ${values.reps}`);

let lines: string[] = [];
let { records } = await runSuite({
  runId,
  cases,
  systems,
  graders: [exactGrader()],
  model,
  repetitions: Number(values.reps),
  onRecord({ run, grade }) {
    console.log(
      `  ${grade.pass ? 'PASS' : 'FAIL'} ${run.caseId} [${run.system}, rep ${run.repetition}] ` +
        `${run.latencyMs}ms ${grade.detail ?? ''}${run.error ? ` error: ${run.error}` : ''}`,
    );
    lines.push(JSON.stringify({ run, grade }));
  },
});

await writeFile(join(outDir, 'results.jsonl'), lines.join('\n') + '\n');
let report = buildReport(runId, model.model, cases, records);
await writeFile(join(outDir, 'report.md'), report);

console.log('\n' + report);
console.log(`written to ${outDir}`);
