import assert from 'node:assert/strict';
import type { GradeResult, Grader, ModelProxy, RunResult, SystemUnderTest, Usage } from './types.js';
import type { Case } from './caseStore.js';
import { judgeVia } from './judge.js';

export { runSuite, type Record };

// judge is the model usage of the graders for this run, apart from the harness usage
type Record = { run: RunResult; grades: GradeResult[]; judge: Usage };

// runs every system on every case, grades each run, returns all records in a
// fixed order (system, repetition, case). systems only ever see the public case;
// graders get the private one. concurrency > 1 runs that many cases at once,
// which suits a hosted model; keep 1 for a single local gpu.
async function runSuite(opts: {
  runId: string;
  cases: Case[];
  systems: SystemUnderTest[];
  graders: Grader[];
  model: string;
  proxy: ModelProxy;
  repetitions: number;
  concurrency?: number;
  onRecord?: (r: Record) => void;
}): Promise<Record[]> {
  let { runId, cases, systems, graders, model, proxy, repetitions, concurrency = 1 } = opts;
  assert(repetitions >= 1, `runSuite: repetitions must be >= 1, got ${repetitions}`);
  assert(concurrency >= 1, `runSuite: concurrency must be >= 1, got ${concurrency}`);

  let records: Record[] = [];
  for (let system of systems) {
    for (let rep = 1; rep <= repetitions; rep++) {
      let mine = system.suites ? cases.filter((c) => system.suites!.includes(c.pub.suite)) : cases;
      let slot = records.length;
      records.length += mine.length;
      await pool(mine, concurrency, async ({ pub, priv }, i) => {
        let ctx = { runId, repetition: rep, model, proxy };
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
          };
        }
        let run = { ...result, latencyMs: Date.now() - t0 };

        let judgeToken = proxy.register(`${runId}/${pub.id}/rep${rep}/judge`);
        let gradeCtx = { judge: judgeVia(proxy, judgeToken, model) };
        let grades: GradeResult[] = [];
        for (let name of priv.graders) {
          let grader = graders.find((g) => g.name === name);
          assert(grader, `runSuite: no grader named ${name} for case ${priv.id}`);
          // a grader that fails (e.g. the judge is down) fails this grade, not the run
          try {
            grades.push(await grader.grade(pub, priv, run, gradeCtx));
          } catch (err: any) {
            grades.push({ grader: name, pass: false, score: 0, detail: `grader error: ${String(err?.message ?? err)}` });
          }
        }
        let record = { run, grades, judge: proxy.usage(judgeToken) };
        records[slot + i] = record;
        opts.onRecord?.(record);
      });
    }
  }
  return records;
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
