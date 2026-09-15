
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Case } from './caseStore.js';
import type { RunRecord } from './runner.js';
import { readJsonl } from './jsonl.js';

export { casesHash, loadRecords, assertResumable, jobKey };

// resuming a run: the records in results.jsonl are kept, the jobs they cover are skipped,
// and the rest runs into the same folder. a record is reused only when what produced it is
// what the new command would produce: the same systems (models, providers, options), cases
// (by id and by content), repetitions, judges, sandbox and provider defaults. a harness that
// wants its prompt or code version checked too puts it into its manifest's options.

// what a resume must agree on: run.json fields
const FIXED = ['systems', 'suites', 'cases', 'casesHash', 'reps', 'judges', 'sandbox', 'providers'];

// sha256 over the case files' content, in id order: a rebuilt dataset changes it
function casesHash(cases: Case[]): string {
  let h = createHash('sha256');
  for (let c of [...cases].sort((a, b) => (a.pub.id < b.pub.id ? -1 : 1))) {
    h.update(JSON.stringify(c.pub)).update('\n').update(JSON.stringify(c.priv)).update('\n');
  }
  return h.digest('hex');
}

// the records of a run folder; none when the run was interrupted before its first record
async function loadRecords(dir: string): Promise<RunRecord[]> {
  return readJsonl<RunRecord>(`${dir}/results.jsonl`).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
}

// throws on a difference that makes the old records incomparable; returns warnings for
// differences that may be fine (the code moved on) but must be seen
function assertResumable(prior: any, next: any): string[] {
  assert(!prior.complete, `run ${prior.runId} is complete; nothing to resume`);
  for (let field of FIXED) {
    assert.deepEqual(next[field], prior[field], `cannot resume run ${prior.runId}: ${field} differs from the stored run.json`);
  }
  let warnings: string[] = [];
  if (prior.git?.rev !== next.git?.rev) warnings.push(`resume: the run started at commit ${prior.git?.rev}, now at ${next.git?.rev}`);
  let dirty = (g: any) => (g?.dirty ?? []).join(', ') || 'none';
  if (dirty(prior.git) !== dirty(next.git)) warnings.push(`resume: uncommitted files then [${dirty(prior.git)}], now [${dirty(next.git)}]`);
  return warnings;
}

function jobKey(job: { system: string; caseId: string; repetition: number }): string {
  return `${job.system}/${job.caseId}/${job.repetition}`;
}
