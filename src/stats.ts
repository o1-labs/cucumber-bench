import type { Case } from './caseStore.js';
import type { RunRecord } from './runner.js';

export { summarize, pairedComparisons, type Row, type Paired };
// internal API, exported for tests
export { consistencyOf, costOf };

// one row per (task | ALL) x system within a suite, averaged over runs
type Row = {
  suite: string;
  task: string; // 'ALL' is the suite total
  system: string;
  n: number;
  errors: number; // share of runs that failed in the sandbox or in a grader (they count as failed grades too)
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

// one paired comparison per suite, grader and pair of systems, over the cases both ran:
// per case, each system's mean score over its repetitions; wins, ties and losses of a over b,
// the mean difference, and a 95% bootstrap interval of that mean (resampling the cases).
// an interval that contains 0 is consistent with no difference between the two systems
type Paired = {
  suite: string;
  grader: string;
  a: string;
  b: string;
  n: number; // cases both systems ran
  wins: number;
  ties: number;
  losses: number;
  meanDiff: number; // a minus b, in score points 0..1
  low: number;
  high: number;
};

function pairedComparisons(cases: Case[], records: RunRecord[]): Paired[] {
  let suiteOf = new Map(cases.map((c) => [c.pub.id, c.pub.suite]));
  let out: Paired[] = [];
  for (let suite of unique(cases.map((c) => c.pub.suite))) {
    let rs = records.filter((r) => suiteOf.get(r.run.caseId) === suite);
    let systems = unique(rs.map((r) => r.run.system));
    let graders = unique(rs.flatMap((r) => r.grades.map((g) => g.grader)));
    // per system, per case: the mean score of a grader over the repetitions
    let score = (sys: string, caseId: string, grader: string) => {
      let gs = rs.filter((r) => r.run.system === sys && r.run.caseId === caseId).flatMap((r) => r.grades.filter((g) => g.grader === grader));
      return gs.length ? avg(gs.map((g) => g.score)) : undefined;
    };
    for (let grader of graders) {
      for (let i = 0; i < systems.length; i++) {
        for (let j = i + 1; j < systems.length; j++) {
          let [a, b] = [systems[i], systems[j]];
          let diffs: number[] = [];
          for (let caseId of unique(rs.map((r) => r.run.caseId))) {
            let sa = score(a, caseId, grader), sb = score(b, caseId, grader);
            if (sa !== undefined && sb !== undefined) diffs.push(sa - sb);
          }
          if (diffs.length === 0) continue;
          let [low, high] = bootstrapInterval(diffs);
          out.push({
            suite,
            grader,
            a,
            b,
            n: diffs.length,
            wins: diffs.filter((d) => d > 1e-9).length,
            ties: diffs.filter((d) => Math.abs(d) <= 1e-9).length,
            losses: diffs.filter((d) => d < -1e-9).length,
            meanDiff: avg(diffs),
            low,
            high,
          });
        }
      }
    }
  }
  return out;
}

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
          errors: avg(rs.map((r) => (statusOf(r) === 'ok' ? 0 : 1))),
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

// records written before the status field exist; a run error was the only status then
function statusOf(r: RunRecord): RunRecord['status'] {
  return r.status ?? (r.run.error ? 'run_error' : 'ok');
}

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

// 95% percentile bootstrap of the mean of xs: 1000 resamples with a fixed seed, so a report
// is reproducible
function bootstrapInterval(xs: number[], resamples = 1000): [number, number] {
  let seed = 20260830;
  let rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let means: number[] = [];
  for (let k = 0; k < resamples; k++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rand() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((p, q) => p - q);
  return [means[Math.floor(0.025 * resamples)], means[Math.ceil(0.975 * resamples) - 1]];
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
