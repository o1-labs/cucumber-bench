import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { consistencyOf, costOf } from '../src/stats.js';
import type { Record } from '../src/runner.js';

function record(caseId: string, rep: number, extracted: string | undefined, tokens = 0): Record {
  return {
    run: {
      caseId, system: 's', repetition: rep, output: '',
      latencyMs: 0, modelCalls: 1, tokensIn: tokens, tokensOut: tokens,
    },
    grade: { caseId, system: 's', repetition: rep, pass: true, score: 1, extracted },
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
    let rows = [record('a', 1, 'yes'), record('a', 2, undefined)];
    assert.equal(consistencyOf(rows), 0.5);
  });

  it('should fall back to the detail string for records without extracted', () => {
    let rows = [record('a', 1, undefined), record('a', 2, undefined)];
    rows[0].grade.detail = 'extracted=yes gold=yes';
    rows[1].grade.detail = 'extracted=no gold=yes';
    assert.equal(consistencyOf(rows), 0.5);
  });
});

describe('costOf', () => {
  let origIn = process.env.BENCH_COST_IN;
  let origOut = process.env.BENCH_COST_OUT;
  afterEach(() => {
    if (origIn === undefined) delete process.env.BENCH_COST_IN;
    else process.env.BENCH_COST_IN = origIn;
    if (origOut === undefined) delete process.env.BENCH_COST_OUT;
    else process.env.BENCH_COST_OUT = origOut;
  });

  it('should be undefined when no rates are set', () => {
    delete process.env.BENCH_COST_IN;
    delete process.env.BENCH_COST_OUT;
    assert.equal(costOf([record('a', 1, 'yes', 1000)]), undefined);
  });

  it('should average cost per run from the rates', () => {
    process.env.BENCH_COST_IN = '1'; // $1 per 1M tokens
    process.env.BENCH_COST_OUT = '2';
    // 1M in + 1M out per run -> $3 each
    let rows = [record('a', 1, 'yes', 1_000_000), record('b', 1, 'yes', 1_000_000)];
    assert.equal(costOf(rows), 3);
  });
});
