import type { Case } from './caseStore.js';
import type { Record } from './runner.js';
import type { SystemUnderTest } from './types.js';
import { consistencyOf, costOf } from './stats.js';

export { buildReport };

// markdown report: one table per suite (task x system), then failures
function buildReport(
  runId: string,
  model: string,
  cases: Case[],
  records: Record[],
  systems: SystemUnderTest[] = [],
): string {
  let lines = [`# Benchmark report`, '', `Run: ${runId}`, `Default model: ${model}`, ''];
  if (systems.length > 0) {
    lines.push('Systems:', '');
    for (let s of systems) lines.push(`- ${s.name}${s.info ? ` — ${s.info}` : ''}`);
    lines.push('');
  }

  let taskOf = new Map(cases.map((c) => [c.pub.id, c.pub]));
  let suites = unique(cases.map((c) => c.pub.suite));

  for (let suite of suites) {
    lines.push(`## Suite: ${suite}`, '');
    lines.push('| task | system | n | accuracy | consistency | avg latency ms | avg tokens in/out | avg calls | avg cost |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

    let suiteRecords = records.filter((r) => taskOf.get(r.run.caseId)?.suite === suite);
    let tasks = unique(suiteRecords.map((r) => taskOf.get(r.run.caseId)!.task));
    let systems = unique(suiteRecords.map((r) => r.run.system));

    for (let task of [...tasks, 'ALL']) {
      for (let system of systems) {
        let rows = suiteRecords.filter(
          (r) => r.run.system === system && (task === 'ALL' || taskOf.get(r.run.caseId)?.task === task),
        );
        if (rows.length === 0) continue;
        let acc = rows.filter((r) => r.grade.pass).length / rows.length;
        let cons = consistencyOf(rows);
        let cost = costOf(rows);
        lines.push(
          `| ${task} | ${system} | ${rows.length} | ${(acc * 100).toFixed(0)}% ` +
            `| ${cons === undefined ? '—' : (cons * 100).toFixed(0) + '%'} ` +
            `| ${avg(rows.map((r) => r.run.latencyMs)).toFixed(0)} ` +
            `| ${avg(rows.map((r) => r.run.tokensIn)).toFixed(0)}/${avg(rows.map((r) => r.run.tokensOut)).toFixed(0)} ` +
            `| ${avg(rows.map((r) => r.run.modelCalls)).toFixed(1)} ` +
            `| ${cost === undefined ? '—' : '$' + cost.toFixed(4)} |`,
        );
      }
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

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
