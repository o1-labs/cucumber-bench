import assert from 'node:assert/strict';
import type { GradeResult, Grader, ModelProxy, RunResult, SystemUnderTest } from './types.js';
import type { Case } from './caseStore.js';

export { runSuite, type Record };

type Record = { run: RunResult; grades: GradeResult[] };

// runs every system on every case, grades each run, returns all records.
// systems only ever see the public case; graders get the private one.
async function runSuite(opts: {
  runId: string;
  cases: Case[];
  systems: SystemUnderTest[];
  graders: Grader[];
  model: string;
  proxy: ModelProxy;
  repetitions: number;
  onRecord?: (r: Record) => void;
}): Promise<Record[]> {
  let { runId, cases, systems, graders, model, proxy, repetitions } = opts;
  assert(repetitions >= 1, `runSuite: repetitions must be >= 1, got ${repetitions}`);

  let records: Record[] = [];
  for (let system of systems) {
    for (let rep = 1; rep <= repetitions; rep++) {
      let mine = system.suites ? cases.filter((c) => system.suites!.includes(c.pub.suite)) : cases;
      for (let { pub, priv } of mine) {
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
          };
        }
        let run = { ...result, latencyMs: Date.now() - t0 };

        let grades: GradeResult[] = [];
        for (let name of priv.graders) {
          let grader = graders.find((g) => g.name === name);
          assert(grader, `runSuite: no grader named ${name} for case ${priv.id}`);
          grades.push(await grader.grade(pub, priv, run));
        }
        let record = { run, grades };
        records.push(record);
        opts.onRecord?.(record);
      }
    }
  }
  return records;
}
