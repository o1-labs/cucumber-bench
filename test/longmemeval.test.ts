import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { isYes, judgePrompt, longmemevalGold, longmemevalGrader, type LongMemEvalGold } from '../benchmarks/longmemeval/graders.js';
import { buildCase, splitIds, PREAMBLE, type Item } from '../benchmarks/longmemeval/build.js';
import type { GradeContext, PublicCase, RunResult } from '../src/types.js';

let item: Item = {
  question_id: 'abc123',
  question_type: 'multi-session',
  question: 'How many shirts did I return?',
  answer: 3,
  question_date: '2023/02/15 (Wed) 19:47',
  haystack_dates: ['2023/02/01 (Wed) 10:00', '2023/02/10 (Fri) 12:30'],
  haystack_session_ids: ['answer_1', 'noise_1'],
  haystack_sessions: [
    [
      { role: 'user', content: 'I returned two shirts today. ', has_answer: true },
      { role: 'assistant', content: 'Noted.' },
    ],
    [{ role: 'user', content: 'And one more shirt yesterday.', has_answer: true }],
  ],
  answer_session_ids: ['answer_1'],
};

function result(output: string): RunResult {
  return { caseId: 'q', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] };
}

describe('buildCase', () => {
  it('should reproduce the official long-context prompt and keep the evidence marks private', () => {
    let { pub, priv } = buildCase(item, 'longmemeval-dev', 'test');
    assert.equal(pub.id, 'longmemeval-dev-multi-session-abc123');
    // direct joins instructions and input with a blank line: the official template follows
    let prompt = `${pub.instructions}\n\n${pub.input}`;
    assert.equal(
      prompt,
      `${PREAMBLE}\n\n\nHistory Chats:\n\n` +
        `\n### Session 1:\nSession Date: 2023/02/01 (Wed) 10:00\nSession Content:\n\n\nuser: I returned two shirts today.\n\nassistant: Noted.\n` +
        `\n### Session 2:\nSession Date: 2023/02/10 (Fri) 12:30\nSession Content:\n\n\nuser: And one more shirt yesterday.\n` +
        `\n\nCurrent Date: 2023/02/15 (Wed) 19:47\nQuestion: How many shirts did I return?\nAnswer:`,
    );
    assert.equal(pub.docs?.length, 2);
    assert.equal(pub.docs?.[1].text, 'user: And one more shirt yesterday.');
    let leaked = JSON.stringify(pub);
    assert.ok(!leaked.includes('has_answer') && !leaked.includes('answer_1'), 'evidence marks in the public case');
    assert.deepEqual(priv, { id: pub.id, graders: ['longmemeval'], answer: '3', questionType: 'multi-session', abstention: false });
    assert.equal(buildCase({ ...item, question_id: 'abc123_abs' }, 's', 'test').priv.abstention, true);
  });
});

describe('splitIds', () => {
  let items = [...'abcdefghijklmnopqrst'].map((c, i) => ({ question_id: `q${c}`, question_type: i % 4 === 0 ? 'rare' : 'common' }));

  it('should be deterministic, disjoint, and stratified by type', () => {
    let a = splitIds(items, { seed: 's', dev: 4, count: 8 });
    let b = splitIds(items, { seed: 's', dev: 4, count: 8 });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, splitIds(items, { seed: 'other', dev: 4, count: 8 }));
    assert.equal(a.dev.length, 4);
    assert.equal(a.test.length, 8);
    assert.equal(new Set([...a.dev, ...a.test]).size, 12);
    let type = (id: string) => items.find((it) => it.question_id === id)!.question_type;
    // rare is a quarter of the items: one of four dev cases, two of eight test cases
    assert.equal(a.dev.filter((id) => type(id) === 'rare').length, 1);
    assert.equal(a.test.filter((id) => type(id) === 'rare').length, 2);
  });

  it("should take the rest with count 'all'", () => {
    let s = splitIds(items, { seed: 's', dev: 4, count: 'all' });
    assert.equal(s.dev.length + s.test.length, items.length);
  });
});

describe('longmemeval grader', () => {
  let pub = { id: 'q', question: 'What did I say?' } as PublicCase;
  let gold = (extra: Partial<LongMemEvalGold>): LongMemEvalGold => ({ answer: 'blue', questionType: 'single-session-user', abstention: false, ...extra });
  let prompts: string[] = [];
  let ctx = (verdict: string): GradeContext => ({ async judge(p) { prompts.push(p); return verdict; } });

  it('should check the gold: the three fields, and a question type the scorer has a template for', () => {
    let raw = { id: 'q', graders: ['longmemeval'], answer: 'blue', questionType: 'multi-session', abstention: true };
    assert.deepEqual(longmemevalGold(raw, 'q'), { answer: 'blue', questionType: 'multi-session', abstention: true });
    assert.throws(() => longmemevalGold({ ...raw, abstention: 'yes' }, 'q'), /case q needs answer, questionType and abstention/);
    assert.throws(() => longmemevalGold({ ...raw, questionType: 'unknown' }, 'q'), /unknown question type unknown/);
  });

  it('should pick the template by type and by abstention, and fill the official fields', () => {
    let p = judgePrompt(gold({}), 'What did I say?', 'You said blue.');
    assert.match(p, /^I will give you a question, a correct answer, and a response from a model/);
    assert.match(p, /\n\nQuestion: What did I say\?\n\nCorrect Answer: blue\n\nModel Response: You said blue\.\n\nIs the model response correct\? Answer yes or no only\.$/);
    assert.match(judgePrompt(gold({ questionType: 'temporal-reasoning' }), 'q', 'r'), /off-by-one errors/);
    assert.match(judgePrompt(gold({ questionType: 'knowledge-update' }), 'q', 'r'), /updated answer/);
    assert.match(judgePrompt(gold({ questionType: 'single-session-preference' }), 'q', 'r'), /\n\nRubric: blue\n\n/);
    assert.match(judgePrompt(gold({ abstention: true }), 'q', 'r'), /^I will give you an unanswerable question.*\n\nExplanation: blue\n\n.*unanswerable\? Answer yes or no only\.$/s);
  });

  it('should pass on a yes verdict, the official way', async () => {
    let g = longmemevalGrader();
    let yes = await g.grade(pub, gold({}), result('blue'), ctx('Yes'));
    assert.equal(yes.pass, true);
    assert.equal(yes.score, 1);
    assert.match(yes.detail ?? '', /single-session-user: judge said Yes; gold: blue/);
    let no = await g.grade(pub, gold({ abstention: true }), result('blue'), ctx('no'));
    assert.equal(no.pass, false);
    assert.match(no.detail ?? '', /\(abstention\)/);
    assert.equal(isYes('No, but yes'), true); // the pinned scorer's substring parse
  });
});
