import assert from 'node:assert/strict';
import type { GradeContext, GradeResult, Grader, ModelProxy, RunResult, SystemUnderTest, Usage } from './types.js';
import type { Case } from './caseStore.js';
import { judgeVia } from './judge.js';

export { runSuite, gradeRun, pool, type RunRecord };

// judge is the model usage of the graders for this run, apart from the harness usage.
// status: ok, or the run failed in the sandbox (run_error), or a grader threw (grade_error);
// both errors fail every grade, and the report counts them apart from answer quality
type RunRecord = { run: RunResult; grades: GradeResult[]; judge: Usage; status: 'ok' | 'run_error' | 'grade_error' };

// runs every system on every case, grades each run, returns all records in a
// fixed order (system, repetition, case). systems only ever see the public case;
// graders get the private one. concurrency > 1 runs that many cases at once,
// which suits a hosted model; keep 1 for a single local gpu.
async function runSuite(opts: {
  runId: string;
  cases: Case[];
  systems: SystemUnderTest[];
  graders: Grader[];
  proxy: ModelProxy;
  // the judge model for a suite: the benchmark's choice
  judgeFor: (suite: string) => string;
  repetitions: number;
  concurrency?: number;
  onRecord?: (r: RunRecord) => void;
}): Promise<RunRecord[]> {
  let { runId, cases, systems, graders, proxy, judgeFor, repetitions, concurrency = 1 } = opts;
  assert(repetitions >= 1, `runSuite: repetitions must be >= 1, got ${repetitions}`);
  assert(concurrency >= 1, `runSuite: concurrency must be >= 1, got ${concurrency}`);

  // every (system, repetition, case) triple is one job in a single pool, so the grading
  // tail of one system overlaps the harness runs of the next, and one case can run many times at once
  let jobs: { system: SystemUnderTest; rep: number; pub: Case['pub']; priv: Case['priv'] }[] = [];
  for (let system of systems) {
    let mine = system.suites ? cases.filter((c) => system.suites!.includes(c.pub.suite)) : cases;
    for (let rep = 1; rep <= repetitions; rep++) for (let { pub, priv } of mine) jobs.push({ system, rep, pub, priv });
  }
  let records: RunRecord[] = new Array(jobs.length);
  await pool(jobs, concurrency, async ({ system, rep, pub, priv }, i) => {
    let ctx = { runId, repetition: rep, proxy };
    let t0 = Date.now();
    let result: Omit<RunResult, 'latencyMs'>;
    try {
      result = await system.run(pub, ctx);
    } catch (err: any) {
      result = {
        caseId: pub.id,
        system: system.name,
        repetition: rep,
        output: '',
        error: String(err?.message ?? err),
        modelCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        models: [],
      };
    }
    let run = { ...result, latencyMs: Date.now() - t0 };

    let judgeModel = judgeFor(pub.suite);
    let judgeToken = proxy.register(`${runId}/${pub.id}/rep${rep}/judge`, { judge: true, models: [judgeModel] });
    let { grades, status } = await gradeRun(pub, priv, run, graders, { judge: judgeVia(proxy, judgeToken, judgeModel) });
    let record = { run, grades, judge: proxy.usage(judgeToken), status };
    records[i] = record;
    opts.onRecord?.(record);
  });
  return records;
}

// grades one run with the graders its case lists. a run that failed in the sandbox is not
// graded: every grader fails it. a grader that throws (e.g. the judge is down) fails its own
// grade, not the run. the status says which of the two happened
async function gradeRun(
  pub: Case['pub'],
  priv: Case['priv'],
  run: RunResult,
  graders: Grader[],
  ctx: GradeContext,
): Promise<{ grades: GradeResult[]; status: RunRecord['status'] }> {
  let grades: GradeResult[] = [];
  let status: RunRecord['status'] = run.error ? 'run_error' : 'ok';
  for (let name of priv.graders) {
    let grader = graders.find((g) => g.name === name);
    assert(grader, `gradeRun: no grader named ${name} for case ${priv.id}`);
    if (run.error) {
      grades.push({ grader: name, pass: false, score: 0, detail: `run error: ${run.error}` });
      continue;
    }
    try {
      grades.push(await grader.grade(pub, priv, run, ctx));
    } catch (err: any) {
      grades.push({ grader: name, pass: false, score: 0, detail: `grader error: ${String(err?.message ?? err)}` });
      status = 'grade_error';
    }
  }
  return { grades, status };
}

// internal helpers

// runs fn over items with at most n in flight
async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  let workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      let i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
