import type { RunRecord } from '../../src/runner.js';

export { outcomeOf, tally, breakdown, truncationOf, type Outcome, type Counts, type Row };

// the counts behind a LongBench v2 accuracy, so every exclusion is visible. one record has one
// outcome: correct or incorrect (a letter was given), invalid (an output with no single letter),
// failed (the run or the grade errored), unsupported (the harness skipped the case: it did not
// fit the context). accuracy is correct over eligible, where eligible is every record but the
// unsupported ones: failed and invalid stay in the denominator. coverage is eligible over the
// records: the share of the selected cases the model could take whole
type Outcome = 'correct' | 'incorrect' | 'invalid' | 'failed' | 'unsupported';
type Counts = {
  selected: number; // jobs the run was to produce (cases x repetitions)
  records: number;
  notRun: number; // selected - records: an interrupted run
  eligible: number;
  correct: number;
  incorrect: number;
  invalid: number;
  failed: number;
  unsupported: number;
  accuracy?: number; // undefined with no eligible record
  coverage?: number; // undefined with no record
};
// one line of a breakdown: the counts of the records that share a value of a key
type Row = Counts & { value: string };

function outcomeOf(r: RunRecord): Outcome {
  let status = r.status ?? (r.run.error ? 'run_error' : 'ok');
  if (status === 'unsupported') return 'unsupported';
  if (status !== 'ok') return 'failed';
  let g = r.grades.find((g) => g.grader === 'mc-answer') ?? r.grades[0];
  if (!g) return 'failed';
  if (g.extracted?.startsWith('(')) return 'invalid';
  return g.pass ? 'correct' : 'incorrect';
}

function tally(records: RunRecord[], selected = records.length): Counts {
  let c = { selected, records: records.length, notRun: selected - records.length, eligible: 0, correct: 0, incorrect: 0, invalid: 0, failed: 0, unsupported: 0 } as Counts;
  for (let r of records) c[outcomeOf(r)]++;
  c.eligible = c.records - c.unsupported;
  c.accuracy = c.eligible > 0 ? c.correct / c.eligible : undefined;
  c.coverage = c.records > 0 ? c.eligible / c.records : undefined;
  return c;
}

// the counts per value of a key: the records are grouped by what keyOf gives for their case
function breakdown(records: RunRecord[], keyOf: (r: RunRecord) => string): Row[] {
  let groups = new Map<string, RunRecord[]>();
  for (let r of records) {
    let k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.keys()].sort().map((value) => ({ value, ...tally(groups.get(value)!) }));
}

// the token counts a truncating harness recorded in its input stage, or undefined for a document
// the model saw whole
function truncationOf(r: RunRecord): { original: number; retained: number } | undefined {
  let m = r.run.trace?.stages?.[0]?.findings.join('\n').match(/truncate_middle: (\d+) tokens cut to (\d+)/);
  return m ? { original: Number(m[1]), retained: Number(m[2]) } : undefined;
}
