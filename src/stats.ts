import type { Record } from './runner.js';

export { consistencyOf, costOf };

// average majority share of extracted answers per case across repetitions:
// 1 means every repetition gave the same answer. undefined with a single rep.
function consistencyOf(rows: Record[]): number | undefined {
  let byCase = new Map<string, string[]>();
  for (let r of rows) {
    let answers = byCase.get(r.run.caseId) ?? [];
    answers.push(extractedOf(r));
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
  return shares.reduce((a, b) => a + b, 0) / shares.length;
}

// records from before the extracted field existed (and failed extractions,
// whose undefined is dropped by json) only carry it inside the detail string
function extractedOf(r: { grade: { extracted?: string; detail?: string } }): string {
  if (r.grade.extracted !== undefined) return r.grade.extracted;
  let m = r.grade.detail?.match(/extracted=(\S+)/);
  return m ? m[1] : '(none)';
}

// average cost per run in usd, from BENCH_COST_IN / BENCH_COST_OUT ($ per 1M
// tokens). undefined when neither rate is set (local models are free).
function costOf(rows: Record[]): number | undefined {
  let inRate = Number(process.env.BENCH_COST_IN);
  let outRate = Number(process.env.BENCH_COST_OUT);
  if (Number.isNaN(inRate) && Number.isNaN(outRate)) return undefined;
  if (Number.isNaN(inRate)) inRate = 0;
  if (Number.isNaN(outRate)) outRate = 0;
  if (rows.length === 0) return undefined;
  let total = 0;
  for (let { run } of rows) total += (run.tokensIn * inRate + run.tokensOut * outRate) / 1e6;
  return total / rows.length;
}
