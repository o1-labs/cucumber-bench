import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { abstentionGrader, answeredGrader, answerCorrectGrader, containsAnswer } from '../benchmarks/selfaware/graders.js';
import { loadCases } from '../src/caseStore.js';
import type { PrivateCase, PublicCase, RunResult } from '../src/types.js';

let pub = { id: 's1', suite: 'selfaware', task: 'abstention', instructions: '', input: 'Question: What is the capital of France?' } as PublicCase;
let unanswerable: PrivateCase = { id: 's1', graders: ['abstention'], answerable: false };
let answerable: PrivateCase = { id: 's1', graders: ['answered', 'answer-correct'], answerable: true, acceptableAnswers: ['Paris'] };

function result(output: string): RunResult {
  return { caseId: 's1', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] };
}
// the graders ask the judge two different yes/no questions, so the mock routes on the
// prompt the way the model mock routes on a harness prompt's label line
let judge = (opts: { declines?: boolean; correct?: boolean }) => ({
  judge: async (prompt: string) => {
    if (/Does the response decline/.test(prompt)) return opts.declines ? 'yes' : 'no';
    if (/Does the response give one of the correct answers/.test(prompt)) return opts.correct ? 'yes' : 'no';
    throw Error(`the mock judge got an unexpected prompt: ${prompt.slice(0, 80)}`);
  },
});

describe('containsAnswer', () => {
  it('should match a gold answer after normalization, ignoring case, articles and punctuation', () => {
    assert.equal(containsAnswer('The capital is Paris.', ['Paris']), true);
    assert.equal(containsAnswer('It is the Eiffel Tower', ['eiffel tower']), true);
    assert.equal(containsAnswer('The capital is Lyon.', ['Paris']), false);
  });

  it('should accept any one of several gold answers', () => {
    assert.equal(containsAnswer('I think it was Adult Swim.', ['Cartoon Network', 'Adult Swim']), true);
  });

  it('should not match gold answers of one or two characters, which appear inside other words', () => {
    // 'mm' would otherwise match 'communication'; those cases fall through to the judge
    assert.equal(containsAnswer('a communication problem', ['mm']), false);
  });
});

describe('abstentionGrader', () => {
  it('should pass when the response declines an unanswerable question', async () => {
    let g = await abstentionGrader().grade(pub, unanswerable, result('There is no way to know that.'), judge({ declines: true }));
    assert.equal(g.pass, true);
    assert.equal(g.score, 1);
    assert.equal(g.extracted, 'abstained');
  });

  it('should fail when the response answers an unanswerable question', async () => {
    let g = await abstentionGrader().grade(pub, unanswerable, result('It is 42.'), judge({ declines: false }));
    assert.equal(g.pass, false);
    assert.equal(g.extracted, 'answered');
  });

  it('should refuse to grade an answerable case', async () => {
    await assert.rejects(() => abstentionGrader().grade(pub, answerable, result('Paris'), judge({ declines: false })));
  });
});

describe('answeredGrader', () => {
  it('should pass when the response commits to an answer', async () => {
    let g = await answeredGrader().grade(pub, answerable, result('Paris.'), judge({ declines: false }));
    assert.equal(g.pass, true);
  });

  it('should fail when the response declines a question that has an answer', async () => {
    let g = await answeredGrader().grade(pub, answerable, result("I can't determine that."), judge({ declines: true }));
    assert.equal(g.pass, false);
    assert.equal(g.detail, 'declined a question that has an answer');
  });

  it('should refuse to grade an unanswerable case', async () => {
    await assert.rejects(() => answeredGrader().grade(pub, unanswerable, result('Paris'), judge({ declines: false })));
  });
});

describe('answerCorrectGrader', () => {
  it('should pass on containment without asking the judge', async () => {
    let asked = 0;
    let ctx = { judge: async () => { asked++; return 'no'; } };
    let g = await answerCorrectGrader().grade(pub, answerable, result('The capital of France is Paris.'), ctx);
    assert.equal(g.pass, true);
    assert.equal(asked, 0);
  });

  it('should accept a judge-approved paraphrase when containment fails', async () => {
    let g = await answerCorrectGrader().grade(pub, answerable, result('The French capital city.'), judge({ declines: false, correct: true }));
    assert.equal(g.pass, true);
    assert.equal(g.detail, 'judge accepted a paraphrase');
  });

  it('should score a declined response as wrong', async () => {
    let g = await answerCorrectGrader().grade(pub, answerable, result('I do not know.'), judge({ declines: true }));
    assert.equal(g.pass, false);
    assert.equal(g.detail, 'declined');
  });
});

describe('the selfaware cases', () => {
  it('should give every case the graders its answerable flag implies', async () => {
    for (let suite of ['benchmarks/selfaware', 'benchmarks/selfaware-dev']) {
      for (let { priv } of await loadCases(suite)) {
        assert.equal(typeof priv.answerable, 'boolean', `${priv.id} has no answerable flag`);
        if (priv.answerable) {
          assert.deepEqual(priv.graders, ['answered', 'answer-correct'], priv.id);
          assert.ok(priv.acceptableAnswers?.length, `${priv.id} has no gold answers`);
        } else {
          assert.deepEqual(priv.graders, ['abstention'], priv.id);
          assert.equal(priv.acceptableAnswers, undefined, `${priv.id} carries gold answers`);
        }
      }
    }
  });

  it('should be balanced, and never leak a case between the test and dev splits', async () => {
    let test = await loadCases('benchmarks/selfaware');
    let dev = await loadCases('benchmarks/selfaware-dev');
    assert.equal(test.length, 100);
    assert.equal(test.filter((c) => c.priv.answerable).length, 50);
    assert.equal(dev.filter((c) => c.priv.answerable).length, dev.length / 2);
    let questions = new Set(test.map((c) => c.pub.input));
    assert.ok(dev.every((c) => !questions.has(c.pub.input)), 'a dev question also appears in the test split');
  });

  it('should never reveal the answerable flag to the system under test', async () => {
    let cases = await loadCases('benchmarks/selfaware');
    let instructions = new Set(cases.map((c) => c.pub.instructions));
    // one instruction for both kinds of case: the prompt cannot betray which kind this is
    assert.equal(instructions.size, 1);
    for (let { pub } of cases) {
      assert.ok(!/unanswerable|no definite answer exists|cannot be answered/i.test(pub.input), pub.id);
      assert.equal((pub as any).answerable, undefined, `${pub.id} leaks the answerable flag`);
    }
  });
});
