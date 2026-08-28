import type { Case } from './caseStore.js';
import type { Record } from './runner.js';
import { summarize, type Row } from './stats.js';

export { buildReport };

// markdown report: one table per suite (task x system, one column per grader), then failures
function buildReport(runId: string, model: string, cases: Case[], records: Record[]): string {
  let lines = [`# Benchmark report`, '', `Run: ${runId}`, `Default model: ${model}`, ''];
  let rows = summarize(cases, records);

  for (let suite of [...new Set(rows.map((r) => r.suite))]) {
    let suiteRows = rows.filter((r) => r.suite === suite);
    let graders = [...new Set(suiteRows.flatMap((r) => Object.keys(r.graders)))];
    lines.push(`## Suite: ${suite}`, '');
    lines.push(`| task | system | n | ${graders.join(' | ')} | consistency | avg latency ms | avg tokens in/out | avg calls | avg cost |`);
    lines.push(`|${' --- |'.repeat(graders.length + 8)}`);
    for (let r of suiteRows) {
      let cells = graders.map((g) => gradeCell(r.graders[g]));
      lines.push(
        `| ${r.task} | ${r.system} | ${r.n} | ${cells.join(' | ')} | ${r.consistency === undefined ? '—' : pct(r.consistency)} ` +
          `| ${r.latencyMs.toFixed(0)} | ${r.tokensIn.toFixed(0)}/${r.tokensOut.toFixed(0)} | ${r.calls.toFixed(1)} ` +
          `| ${r.costUsd === undefined ? '—' : '$' + r.costUsd.toFixed(4)} |`,
      );
    }
    lines.push('');
  }

  let failures = records.flatMap((r) => r.grades.filter((g) => !g.pass).map((g) => ({ run: r.run, grade: g })));
  lines.push(`## Failures (${failures.length})`, '');
  for (let { run, grade } of failures) {
    let head = `- ${run.caseId} [${run.system}, rep ${run.repetition}] ${grade.grader}: ${grade.detail ?? ''}`;
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

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
