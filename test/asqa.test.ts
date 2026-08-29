import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { citationPrecisionGrader, citationRecallGrader, citationsOf, removeCitations, sentences } from '../benchmarks/asqa/graders.js';
import type { GradeContext, PrivateCase, PublicCase, RunResult } from '../src/types.js';

let pub = {
  id: 'q',
  docs: [
    { title: 'Alice', text: 'Alice was born in 1990 in Oslo.' },
    { title: 'Bob', text: 'Bob lives in Paris.' },
    { title: 'Noise', text: 'Nothing relevant here.' },
  ],
} as PublicCase;
let priv = { id: 'q', graders: [] } as PrivateCase;

// fake judge: parses premise and hypothesis back out of the prompt; entails when the
// premise contains the hypothesis text without its final period
let calls: string[] = [];
let ctx: GradeContext = {
  async judge(prompt) {
    calls.push(prompt);
    let premise = prompt.slice(prompt.indexOf('Premise:\n') + 9, prompt.indexOf('\n\nHypothesis: '));
    let claim = prompt.slice(prompt.indexOf('Hypothesis: ') + 12, prompt.indexOf('\n\nDoes the premise'));
    return premise.includes(claim.replace(/\.$/, '')) ? 'yes' : 'no';
  },
};

function result(output: string): RunResult {
  return { caseId: 'q', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

describe('parsing', () => {
  it('should split sentences and read citations', () => {
    let out = 'Alice was born in 1990 in Oslo [1]. Bob lives in Paris [2][3]. Carol likes tea.';
    assert.equal(sentences(out).length, 3);
    assert.deepEqual(citationsOf('Bob lives in Paris [2][3].', 3), [1, 2]);
    assert.deepEqual(citationsOf('Out of range [9].', 3), []);
    assert.equal(removeCitations('Bob lives in Paris [2][3].'), 'Bob lives in Paris.');
  });
});

describe('citation graders', () => {
  let out = 'Alice was born in 1990 in Oslo [1]. Bob lives in Paris [2][3]. Carol likes tea.';

  it('recall: supported sentences over all sentences; an uncited sentence counts as unsupported', async () => {
    let g = await citationRecallGrader().grade(pub, priv, result(out), ctx);
    assert.equal(g.pass, false);
    assert.ok(Math.abs(g.score - 2 / 3) < 1e-9, g.detail);
    assert.match(g.detail ?? '', /1 without citation/);
  });

  it('precision: a redundant citation is not necessary', async () => {
    let r = result(out);
    calls = [];
    let g = await citationPrecisionGrader().grade(pub, priv, r, ctx);
    // [1] necessary; [2] supports alone; [3] does not, and [2] alone does -> over-citation
    assert.ok(Math.abs(g.score - 2 / 3) < 1e-9, g.detail);
    assert.equal(g.pass, false);
    // recall and precision share judgments through the per-run memo
    let before = calls.length;
    await citationRecallGrader().grade(pub, priv, r, ctx);
    assert.equal(calls.length, before);
  });

  it('should pass a fully supported, minimally cited answer', async () => {
    let g = await citationPrecisionGrader().grade(pub, priv, result('Bob lives in Paris [2].'), ctx);
    assert.equal(g.pass, true);
    assert.equal(g.score, 1);
  });
});
