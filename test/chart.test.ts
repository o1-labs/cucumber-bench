import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildChartHtml } from '../src/chart.js';
import type { RunRecord } from '../src/runner.js';
import type { Case } from '../src/caseStore.js';

function pub(id: string, suite: string): Case {
  return {
    pub: { id, suite, task: suite, instructions: '', input: '' },
    priv: { id, graders: ['exact'] },
  };
}

function record(caseId: string, system: string, rep = 1): RunRecord {
  return {
    run: { caseId, system, repetition: rep, output: 'yes', latencyMs: 100, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, models: ['m'] },
    grades: [{ grader: 'exact', pass: true, score: 1, extracted: 'yes' }],
    judge: { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] },
  };
}

describe('buildChartHtml', () => {
  let cases = [pub('a', 's1'), pub('b', 's2')];

  it('should draw four systems, and list only the systems that ran a suite in its table', () => {
    let records = [
      record('a', 'w'), record('a', 'x'), record('a', 'y'), record('a', 'z'),
      record('b', 'w'), record('b', 'x'), record('b', 'y'),
    ];
    let html = buildChartHtml('r', cases, records);
    let tables = html.split('comparison</h2>').slice(1);
    assert.equal(tables.length, 2);
    assert.ok(tables[0].includes('> z</th>'), 'suite s1 lists z');
    assert.ok(!tables[1].includes('> z</th>'), 'suite s2 does not list z');
    // z keeps its own colour key in the glossary
    assert.match(html, /<span class="key s4"><\/span> <b>z<\/b>/);
    assert.ok(!html.includes('did not run the same number of times'));
  });

  it('should say when the systems of a suite did not run the same number of times', () => {
    let records = [record('a', 'w', 1), record('a', 'w', 2), record('a', 'x', 1)];
    let html = buildChartHtml('r', [cases[0]], records);
    assert.ok(html.includes('did not run the same number of times'));
  });
});
