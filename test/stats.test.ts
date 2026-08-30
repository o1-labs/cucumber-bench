import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { consistencyOf, costOf, pairedComparisons, summarize } from '../src/stats.js';
import type { RunRecord } from '../src/runner.js';
import type { Case } from '../src/caseStore.js';

function record(caseId: string, rep: number, extracted: string, opts: { pass?: boolean; score?: number; tokens?: number; system?: string; status?: RunRecord['status'] } = {}): RunRecord {
  let { pass = true, score = pass ? 1 : 0, tokens = 0, system = 's', status = 'ok' } = opts;
  return {
    run: { caseId, system, repetition: rep, output: '', latencyMs: 100, modelCalls: 1, tokensIn: tokens, tokensOut: tokens, costUsd: 0, models: [] },
    grades: [{ grader: 'exact', pass, score, extracted }],
    judge: { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] },
    status,
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
  it('should produce one row per task and system plus an ALL row, with per-grader pass rate and mean score', () => {
    let pub = (id: string, task: string) =>
      ({ pub: { id, suite: 'lb', task, instructions: '', input: '' }, priv: { id, graders: ['exact'], answer: 'yes' } }) as Case;
    let cases = [pub('a', 't1'), pub('b', 't1'), pub('c', 't2')];
    let records = [
      record('a', 1, 'yes'), record('b', 1, 'no', { pass: false, score: 0.5 }), record('c', 1, 'yes'),
      record('a', 1, 'yes', { system: 'x' }), record('b', 1, 'yes', { system: 'x' }), record('c', 1, 'yes', { system: 'x' }),
    ];
    let rows = summarize(cases, records);
    assert.deepEqual(rows.map((r) => `${r.task}/${r.system}`), ['t1/s', 't1/x', 't2/s', 't2/x', 'ALL/s', 'ALL/x']);
    assert.ok(rows.every((r) => r.errors === 0));
    let t1s = rows.find((r) => r.task === 't1' && r.system === 's')!;
    assert.equal(t1s.n, 2);
    assert.deepEqual(t1s.graders, { exact: { pass: 0.5, score: 0.75 } });
    assert.equal(t1s.consistency, undefined);
    assert.equal(t1s.latencyMs, 100);
    let all = rows.find((r) => r.task === 'ALL' && r.system === 's')!;
    assert.equal(all.n, 3);
    assert.equal(Math.round(all.graders.exact.pass * 100), 67);
  });

  it('should count runs that errored, and records written before the status field', () => {
    let cases = [{ pub: { id: 'a', suite: 'lb', task: 't1', instructions: '', input: '' }, priv: { id: 'a', graders: ['exact'], answer: 'yes' } } as Case];
    let records = [
      record('a', 1, 'yes'),
      record('a', 2, '(none)', { pass: false, status: 'run_error' }),
      { ...record('a', 3, '(none)', { pass: false }), status: undefined as any, run: { ...record('a', 3, '').run, error: 'timeout' } },
      record('a', 4, '(none)', { pass: false, status: 'grade_error' }),
    ];
    let row = summarize(cases, records).find((r) => r.task === 'ALL')!;
    assert.equal(row.errors, 0.75);
    assert.equal(row.graders.exact.pass, 0.25);
  });
});

describe('pairedComparisons', () => {
  it('should compare two systems case by case with a reproducible interval', () => {
    let c = (id: string) => ({ pub: { id, suite: 'lb', task: 't', instructions: '', input: '' }, priv: { id, graders: ['exact'], answer: 'yes' } }) as Case;
    let cases = [c('a'), c('b'), c('c'), c('d')];
    let records = [
      // s: 1, 0.5, 0, 1 (a over two repetitions: 1 and 0 -> 0.5); x: 0, 0.5, 0, 1
      record('a', 1, 'yes'), record('a', 2, '(none)', { pass: false }), record('b', 1, 'y', { pass: false, score: 0.5 }), record('c', 1, 'n', { pass: false }), record('d', 1, 'yes'),
      record('a', 1, 'n', { pass: false, system: 'x' }), record('b', 1, 'y', { pass: false, score: 0.5, system: 'x' }), record('c', 1, 'n', { pass: false, system: 'x' }), record('d', 1, 'yes', { system: 'x' }),
    ];
    let [p] = pairedComparisons(cases, records);
    assert.deepEqual([p.suite, p.grader, p.a, p.b, p.n, p.wins, p.ties, p.losses], ['lb', 'exact', 's', 'x', 4, 1, 3, 0]);
    assert.equal(p.meanDiff, 0.125);
    assert.ok(p.low <= 0 && p.high >= 0.125, `interval ${p.low}..${p.high}`);
    assert.deepEqual(pairedComparisons(cases, records)[0], p);
  });
});
