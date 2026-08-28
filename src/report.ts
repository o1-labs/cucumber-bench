import type { Case } from './caseStore.js';
import type { Record } from './runner.js';
import { summarize } from './stats.js';

export { buildReport };

// markdown report: one table per suite (task x system), then failures
function buildReport(runId: string, model: string, cases: Case[], records: Record[]): string {
  let lines = [`# Benchmark report`, '', `Run: ${runId}`, `Default model: ${model}`, ''];
  let rows = summarize(cases, records);

  for (let suite of [...new Set(rows.map((r) => r.suite))]) {
    lines.push(`## Suite: ${suite}`, '');
    lines.push('| task | system | n | accuracy | consistency | avg latency ms | avg tokens in/out | avg calls | avg cost |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (let r of rows.filter((r) => r.suite === suite)) {
      lines.push(
        `| ${r.task} | ${r.system} | ${r.n} | ${pct(r.accuracy)} | ${r.consistency === undefined ? '—' : pct(r.consistency)} ` +
          `| ${r.latencyMs.toFixed(0)} | ${r.tokensIn.toFixed(0)}/${r.tokensOut.toFixed(0)} | ${r.calls.toFixed(1)} ` +
          `| ${r.costUsd === undefined ? '—' : '$' + r.costUsd.toFixed(4)} |`,
      );
    }
    lines.push('');
  }

  let failures = records.filter((r) => !r.grade.pass);
  lines.push(`## Failures (${failures.length})`, '');
  for (let { run, grade } of failures) {
    let head = `- ${run.caseId} [${run.system}, rep ${run.repetition}] ${grade.detail ?? ''}`;
    lines.push(run.error ? `${head} error: ${run.error}` : head);
  }
  lines.push('');
  return lines.join('\n');
}

// internal helpers

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
