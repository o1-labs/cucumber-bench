import type { Case } from './caseStore.js';
import type { RunRecord } from './runner.js';
import { pairedComparisons, summarize, type Row } from './stats.js';
import type { Grader } from './types.js';

export { buildReport };

// markdown report: the models each system and judge actually used, one table per
// suite (task x system, one column per grader), the grader glossary, then failures
// expected: the job count the run was to produce; details: grade details in the failures list
// (they name gold data; off for a report of a locked test set that is shared)
function buildReport(runId: string, cases: Case[], records: RunRecord[], graders: Grader[] = [], opts: { expected?: number; details?: boolean } = {}): string {
  let { expected, details = true } = opts;
  let lines = [`# Benchmark report`, '', `Run: ${runId}`, ''];
  if (expected !== undefined && records.length !== expected) {
    lines.push(`**INCOMPLETE RUN: ${records.length} of ${expected} expected records. The numbers below are not a valid comparison.**`, '');
  }
  let rows = summarize(cases, records);
  let caseOf = new Map(cases.map((c) => [c.pub.id, c.pub]));
  let systems = [...new Set(records.map((r) => r.run.system))];
  lines.push('Models used, as recorded by the proxy:', '');
  for (let sys of systems) {
    let models = [...new Set(records.filter((r) => r.run.system === sys).flatMap((r) => r.run.models ?? []))];
    lines.push(`- ${sys}: ${models.join(', ') || '—'}`);
  }
  for (let suite of [...new Set(rows.map((r) => r.suite))]) {
    let judges = [...new Set(records.filter((r) => caseOf.get(r.run.caseId)?.suite === suite).flatMap((r) => r.judge?.models ?? []))];
    if (judges.length) lines.push(`- judge for ${suite}: ${judges.join(', ')}`);
  }
  lines.push('');

  for (let suite of [...new Set(rows.map((r) => r.suite))]) {
    let suiteRows = rows.filter((r) => r.suite === suite);
    let graders = [...new Set(suiteRows.flatMap((r) => Object.keys(r.graders)))];
    lines.push(`## Suite: ${suite}`, '');
    lines.push(`| task | system | n | errors | ${graders.join(' | ')} | consistency | avg latency ms | avg tokens in/out | avg calls | harness cost/run | judge cost/run | total cost, all runs |`);
    lines.push(`|${' --- |'.repeat(graders.length + 11)}`);
    for (let r of suiteRows) {
      let cells = graders.map((g) => gradeCell(r.graders[g]));
      lines.push(
        `| ${r.task} | ${r.system} | ${r.n} | ${pct(r.errors)} | ${cells.join(' | ')} | ${r.consistency === undefined ? '—' : pct(r.consistency)} ` +
          `| ${r.latencyMs.toFixed(0)} | ${r.tokensIn.toFixed(0)}/${r.tokensOut.toFixed(0)} | ${r.calls.toFixed(1)} ` +
          `| ${usd(r.costUsd)} | ${usd(r.judgeCostUsd)} | ${r.costUsd === undefined ? '—' : '$' + (r.n * (r.costUsd + (r.judgeCostUsd ?? 0))).toFixed(2)} |`,
      );
    }
    lines.push('');
  }

  // paired comparisons: the same cases for both systems, so the noise of the case mix cancels
  let paired = pairedComparisons(cases, records);
  for (let suite of unique(paired.map((p) => p.suite))) {
    lines.push(`## Suite: ${suite} — paired comparison`, '');
    lines.push('Per case, each system\'s mean score over its repetitions; wins/ties/losses of A over B; the mean difference in points with a 95% bootstrap interval. An interval that contains 0 is consistent with no difference.', '');
    lines.push('| grader | A vs B | cases | wins/ties/losses | mean diff | 95% interval |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (let p of paired.filter((p) => p.suite === suite)) {
      let pts = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}`;
      lines.push(`| ${p.grader} | ${p.a} vs ${p.b} | ${p.n} | ${p.wins}/${p.ties}/${p.losses} | ${pts(p.meanDiff)} | ${pts(p.low)} … ${pts(p.high)} |`);
    }
    lines.push('');
  }

  let used = new Set(rows.flatMap((r) => Object.keys(r.graders)));
  let glossary = graders.filter((g) => used.has(g.name));
  if (glossary.length > 0) {
    lines.push('errors: the share of runs that failed in the sandbox or in a grader; they count as failed grades too.', '');
    lines.push('Graders (a cell is the pass rate; a value in parentheses is the mean score when it differs):', '');
    for (let g of glossary) lines.push(`- ${g.name} — ${g.description}`);
    lines.push('');
  }

  let failures = records.flatMap((r) => r.grades.filter((g) => !g.pass).map((g) => ({ run: r.run, grade: g })));
  lines.push(`## Failures (${failures.length})${details ? '' : ' — details withheld (--no-details)'}`, '');
  for (let { run, grade } of failures) {
    let head = `- ${run.caseId} [${run.system}, rep ${run.repetition}] ${grade.grader}${details ? `: ${grade.detail ?? ''}` : ''}`;
    lines.push(run.error ? `${head} error: ${run.error}` : head);
  }
  lines.push('');
  return lines.join('\n');
}

// internal helpers

// pass rate, plus the mean score when it carries extra information (partial-credit graders)
function gradeCell(g?: Row['graders'][string]): string {
  if (!g) return '—';
  return Math.abs(g.pass - g.score) > 0.005 ? `${pct(g.pass)} (avg ${pct(g.score)})` : pct(g.pass);
}

function usd(x?: number): string {
  return x === undefined ? '—' : `$${x.toFixed(4)}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
