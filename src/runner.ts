import assert from 'node:assert/strict';
import type {
  GradeResult,
  Grader,
  ModelClient,
  RunResult,
  SystemUnderTest,
} from './types.js';
import type { Case } from './caseStore.js';

export { runSuite, type SuiteResult, type Record };

type Record = { run: RunResult; grade: GradeResult };
type SuiteResult = { runId: string; records: Record[] };

// runs every system on every case, grades each run, returns all records.
// systems only ever see the public case; graders get the private one.
async function runSuite(opts: {
  runId: string;
  cases: Case[];
  systems: SystemUnderTest[];
  graders: Grader[];
  model: ModelClient;
  repetitions: number;
  onRecord?: (r: Record) => void;
}): Promise<SuiteResult> {
  let { runId, cases, systems, graders, model, repetitions } = opts;
  assert(repetitions >= 1, `runSuite: repetitions must be >= 1, got ${repetitions}`);

  let records: Record[] = [];
  for (let system of systems) {
    for (let rep = 1; rep <= repetitions; rep++) {
      for (let { pub, priv } of cases) {
        let ctx = { runId, repetition: rep, model };
        let t0 = Date.now();
        let run: RunResult;
        try {
          run = await system.run(pub, ctx);
        } catch (err: any) {
          run = {
            caseId: pub.id,
            system: system.name,
            repetition: rep,
            output: '',
            error: String(err?.message ?? err),
            latencyMs: 0,
            modelCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
          };
        }
        run.latencyMs = Date.now() - t0;

        let grader = graders.find((g) => g.name === priv.grader);
        assert(grader, `runSuite: no grader named ${priv.grader} for case ${priv.id}`);
        let grade = grader.grade(pub, priv, run);

        let record = { run, grade };
        records.push(record);
        opts.onRecord?.(record);
      }
    }
  }
  return { runId, records };
}
