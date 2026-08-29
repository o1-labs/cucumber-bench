import type { Case } from './caseStore.js';
import type { RunRecord } from './runner.js';

export { summarize, type Row };
// internal API, exported for tests
export { consistencyOf, costOf };

// one row per (task | ALL) x system within a suite, averaged over runs
type Row = {
  suite: string;
  task: string; // 'ALL' is the suite total
  system: string;
  n: number;
  // per grader: pass rate and mean score, both 0..1
  graders: { [name: string]: { pass: number; score: number } };
  consistency?: number; // 0..1, undefined with a single repetition
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
  costUsd?: number; // harness cost per run: reported by the provider, else from env rates, else undefined
  judgeCalls: number;
  judgeTokensIn: number;
  judgeTokensOut: number;
  judgeCostUsd?: number; // judge cost per run, reported by the provider
};

function summarize(cases: Case[], records: RunRecord[]): Row[] {
  let caseOf = new Map(cases.map((c) => [c.pub.id, c.pub]));
  let rows: Row[] = [];
  for (let suite of unique(cases.map((c) => c.pub.suite))) {
    let inSuite = records.filter((r) => caseOf.get(r.run.caseId)?.suite === suite);
    let tasks = unique(inSuite.map((r) => caseOf.get(r.run.caseId)!.task));
    let systems = unique(inSuite.map((r) => r.run.system));
    for (let task of [...tasks, 'ALL']) {
      for (let system of systems) {
        let rs = inSuite.filter(
          (r) => r.run.system === system && (task === 'ALL' || caseOf.get(r.run.caseId)!.task === task),
        );
        if (rs.length === 0) continue;
        let graders: Row['graders'] = {};
        for (let name of unique(rs.flatMap((r) => r.grades.map((g) => g.grader)))) {
          let gs = rs.flatMap((r) => r.grades.filter((g) => g.grader === name));
          graders[name] = { pass: avg(gs.map((g) => (g.pass ? 1 : 0))), score: avg(gs.map((g) => g.score)) };
        }
        rows.push({
          suite,
          task,
          system,
          n: rs.length,
          graders,
          consistency: consistencyOf(rs),
          latencyMs: avg(rs.map((r) => r.run.latencyMs)),
          tokensIn: avg(rs.map((r) => r.run.tokensIn)),
          tokensOut: avg(rs.map((r) => r.run.tokensOut)),
          calls: avg(rs.map((r) => r.run.modelCalls)),
          costUsd: costOf(rs),
          judgeCalls: avg(rs.map((r) => r.judge?.modelCalls ?? 0)),
          judgeTokensIn: avg(rs.map((r) => r.judge?.tokensIn ?? 0)),
          judgeTokensOut: avg(rs.map((r) => r.judge?.tokensOut ?? 0)),
          judgeCostUsd: rs.some((r) => (r.judge?.costUsd ?? 0) > 0) ? avg(rs.map((r) => r.judge?.costUsd ?? 0)) : undefined,
        });
      }
    }
  }
  return rows;
}

// internal helpers

// average majority share of answers per case across repetitions: 1 means every
// repetition gave the same answer. the answer is the primary grader's extracted
// label, or the whole output for tasks without one. undefined with a single rep.
function consistencyOf(rows: RunRecord[]): number | undefined {
  let byCase = new Map<string, string[]>();
  for (let r of rows) {
    let answers = byCase.get(r.run.caseId) ?? [];
    answers.push(r.grades[0]?.extracted ?? r.run.output.trim());
    byCase.set(r.run.caseId, answers);
  }
  let shares: number[] = [];
  let repeated = false;
  for (let answers of byCase.values()) {
    if (answers.length > 1) repeated = true;
    let counts = new Map<string, number>();
    for (let a of answers) counts.set(a, (counts.get(a) ?? 0) + 1);
    shares.push(Math.max(...counts.values()) / answers.length);
  }
  if (!repeated || shares.length === 0) return undefined;
  return avg(shares);
}

// average harness cost per run in usd. the provider's reported cost when there is
// one (openrouter); else BENCH_COST_IN / BENCH_COST_OUT ($ per 1M tokens); else
// undefined (a local model is free).
function costOf(rows: RunRecord[]): number | undefined {
  if (rows.some((r) => (r.run.costUsd ?? 0) > 0)) return avg(rows.map((r) => r.run.costUsd ?? 0));
  let inRate = Number(process.env.BENCH_COST_IN);
  let outRate = Number(process.env.BENCH_COST_OUT);
  if (Number.isNaN(inRate) && Number.isNaN(outRate)) return undefined;
  if (Number.isNaN(inRate)) inRate = 0;
  if (Number.isNaN(outRate)) outRate = 0;
  if (rows.length === 0) return undefined;
  return avg(rows.map(({ run }) => (run.tokensIn * inRate + run.tokensOut * outRate) / 1e6));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
