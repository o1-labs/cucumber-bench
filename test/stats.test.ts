import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { consistencyOf, costOf, summarize } from '../src/stats.js';
import type { Record } from '../src/runner.js';
import type { Case } from '../src/caseStore.js';

function record(caseId: string, rep: number, extracted: string, opts: { pass?: boolean; tokens?: number; system?: string } = {}): Record {
  let { pass = true, tokens = 0, system = 's' } = opts;
  return {
    run: { caseId, system, repetition: rep, output: '', latencyMs: 100, modelCalls: 1, tokensIn: tokens, tokensOut: tokens },
    grade: { caseId, system, repetition: rep, pass, extracted },
  };
}

describe('consistencyOf', () => {
  it('should be undefined with a single repetition', () => {
    assert.equal(consistencyOf([record('a', 1, 'yes')]), undefined);
  });

  it('should be 1 when every repetition agrees', () => {
    assert.equal(consistencyOf([record('a', 1, 'yes'), record('a', 2, 'yes'), record('a', 3, 'yes')]), 1);
  });

  it('should average majority shares across cases', () => {
    let rows = [
      // case a: 3/3 agree; case b: 2/3 agree -> (1 + 2/3) / 2
      record('a', 1, 'yes'), record('a', 2, 'yes'), record('a', 3, 'yes'),
      record('b', 1, 'no'), record('b', 2, 'no'), record('b', 3, 'yes'),
    ];
    assert.equal(consistencyOf(rows), (1 + 2 / 3) / 2);
  });

  it('should count a failed extraction as its own answer', () => {
    assert.equal(consistencyOf([record('a', 1, 'yes'), record('a', 2, '(none)')]), 0.5);
  });
});

describe('costOf', () => {
  let origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('should be undefined when no rates are set', () => {
    delete process.env.BENCH_COST_IN;
    delete process.env.BENCH_COST_OUT;
    assert.equal(costOf([record('a', 1, 'yes', { tokens: 1000 })]), undefined);
  });

  it('should average cost per run from the rates', () => {
    process.env.BENCH_COST_IN = '1'; // $1 per 1M tokens
    process.env.BENCH_COST_OUT = '2';
    // 1M in + 1M out per run -> $3 each
    let rows = [record('a', 1, 'yes', { tokens: 1_000_000 }), record('b', 1, 'yes', { tokens: 1_000_000 })];
    assert.equal(costOf(rows), 3);
  });
});

describe('summarize', () => {
  it('should produce one row per task and system plus an ALL row per system', () => {
    let pub = (id: string, task: string) =>
      ({ pub: { id, suite: 'lb', task, instructions: '', examples: [], input: '', question: '', choices: [] }, priv: { id, grader: 'exact', answer: 'yes' } }) as Case;
    let cases = [pub('a', 't1'), pub('b', 't1'), pub('c', 't2')];
    let records = [
      record('a', 1, 'yes'), record('b', 1, 'no', { pass: false }), record('c', 1, 'yes'),
      record('a', 1, 'yes', { system: 'x' }), record('b', 1, 'yes', { system: 'x' }), record('c', 1, 'yes', { system: 'x' }),
    ];
    let rows = summarize(cases, records);
    assert.deepEqual(rows.map((r) => `${r.task}/${r.system}`), ['t1/s', 't1/x', 't2/s', 't2/x', 'ALL/s', 'ALL/x']);
    let t1s = rows.find((r) => r.task === 't1' && r.system === 's')!;
    assert.equal(t1s.n, 2);
    assert.equal(t1s.accuracy, 0.5);
    assert.equal(t1s.consistency, undefined);
    assert.equal(t1s.latencyMs, 100);
    let all = rows.find((r) => r.task === 'ALL' && r.system === 's')!;
    assert.equal(all.n, 3);
    assert.equal(Math.round(all.accuracy * 100), 67);
  });
});
