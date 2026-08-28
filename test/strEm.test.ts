import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeAnswer, strEmGrader } from '../src/graders/strEm.js';
import type { GradeContext, PrivateCase, PublicCase, RunResult } from '../src/types.js';

let ctx: GradeContext = { judge: async () => 'no' };
let pub = { id: 'a' } as PublicCase;
let priv: PrivateCase = {
  id: 'a',
  graders: ['str-em'],
  qaPairs: [
    { question: 'Which town holds the monthly record?', shortAnswers: ['Cherrapunji', 'Sohra'] },
    { question: 'Which village holds the annual record?', shortAnswers: ['Mawsynram'] },
  ],
};

function result(output: string): RunResult {
  return { caseId: 'a', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0 };
}

describe('normalizeAnswer', () => {
  it('should lowercase, drop punctuation and articles, and collapse whitespace', () => {
    assert.equal(normalizeAnswer('The  Beatles, (UK).'), 'beatles uk');
  });
});

describe('strEmGrader', () => {
  it('should pass when every sub-question has one of its answers in the output', async () => {
    let g = await strEmGrader().grade(pub, priv, result('Sohra holds the monthly record, Mawsynram the annual one [1].'), ctx);
    assert.equal(g.pass, true);
    assert.equal(g.score, 1);
  });

  it('should give partial credit and name the missing answers', async () => {
    let g = await strEmGrader().grade(pub, priv, result('Mawsynram is the rainiest village.'), ctx);
    assert.equal(g.pass, false);
    assert.equal(g.score, 0.5);
    assert.match(g.detail ?? '', /missing: Cherrapunji/);
  });
});
