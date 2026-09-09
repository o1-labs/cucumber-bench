import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAnswer, mcAnswerGrader } from '../benchmarks/longbench-v2/graders.js';
import { loadData, seededSample, toCase, type Item } from '../benchmarks/longbench-v2/source.js';
import { breakdown, tally, truncationOf } from '../benchmarks/longbench-v2/tally.js';
import { encodeChunked, truncateMiddle, type Tok } from '../harnesses/lb2-direct/src/tokenizer.js';
import type { RunRecord } from '../src/runner.js';
import type { RunResult } from '../src/types.js';

function item(_id: string, answer = 'B', over: Partial<Item> = {}): Item {
  return {
    _id, domain: 'Single-Document QA', sub_domain: 'Legal', difficulty: 'hard', length: 'short',
    question: 'What is it?', choice_A: 'alpha', choice_B: 'beta', choice_C: 'gamma', choice_D: 'delta', answer,
    context: '  The text.\n\nMore text.  ', ...over,
  };
}

function result(output: string): RunResult {
  return { caseId: 'c', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] };
}

describe('extractAnswer', () => {
  it('should read the reference answer form, with or without parentheses', () => {
    assert.deepEqual(extractAnswer('The correct answer is (B)'), { letter: 'B', reason: 'ok' });
    assert.deepEqual(extractAnswer('The correct answer is B.'), { letter: 'B', reason: 'ok' });
    assert.deepEqual(extractAnswer('Some reasoning first.\n\nThe correct answer is (D).'), { letter: 'D', reason: 'ok' });
  });

  it('should accept harmless formatting: markdown, a colon, case, thinking tags', () => {
    assert.equal(extractAnswer('**The correct answer is (C)**').letter, 'C');
    assert.equal(extractAnswer('The correct answer is: (A)').letter, 'A');
    assert.equal(extractAnswer('the correct answer is (d)').letter, 'D');
    assert.equal(extractAnswer('The correct answer is ( B )').letter, 'B');
    assert.equal(extractAnswer('<think>The correct answer is (A)? no</think>The correct answer is (D)').letter, 'D');
  });

  it('should treat the same letter repeated as one answer', () => {
    assert.equal(extractAnswer('I think B. The correct answer is (B). Again: the correct answer is B').letter, 'B');
  });

  it('should reject an output with no answer form, and not guess from a bare letter', () => {
    assert.deepEqual(extractAnswer('B'), { reason: 'none' });
    assert.deepEqual(extractAnswer('The answer is B'), { reason: 'none' });
    assert.deepEqual(extractAnswer('The correct answer is Alpha'), { reason: 'none' });
    assert.deepEqual(extractAnswer('The correct answer is (insert answer here)'), { reason: 'none' });
    assert.deepEqual(extractAnswer(''), { reason: 'none' });
  });

  it('should reject an output that commits to several different letters', () => {
    assert.deepEqual(extractAnswer('The correct answer is (A). Wait, no. The correct answer is (C).'), { reason: 'ambiguous' });
  });
});

describe('mc-answer grader', () => {
  let grader = mcAnswerGrader();
  let { pub, priv } = toCase(item('x1', 'C'), 'lb');

  it('should pass the gold letter and fail another', async () => {
    let g = await grader.grade(pub, priv, result('The correct answer is (C)'), { judge: async () => '' });
    assert.deepEqual([g.pass, g.score, g.extracted], [true, 1, 'C']);
    g = await grader.grade(pub, priv, result('The correct answer is (A)'), { judge: async () => '' });
    assert.deepEqual([g.pass, g.score, g.extracted, g.detail], [false, 0, 'A', 'extracted=A gold=C']);
  });

  it('should fail an invalid answer and name why', async () => {
    let g = await grader.grade(pub, priv, result('I cannot tell.'), { judge: async () => '' });
    assert.deepEqual([g.pass, g.extracted], [false, '(none)']);
    g = await grader.grade(pub, priv, result('The correct answer is (A) or the correct answer is (B)'), { judge: async () => '' });
    assert.deepEqual([g.pass, g.extracted], [false, '(ambiguous)']);
  });
});

describe('toCase', () => {
  it('should keep the answer and the metadata out of the public case', () => {
    let { pub, priv } = toCase(item('abc123', 'D'), 'longbench-v2');
    assert.equal(pub.id, 'longbench-v2-abc123');
    assert.ok(!('answer' in pub) && !('meta' in pub) && !('domain' in pub));
    assert.ok(!JSON.stringify(pub).includes('"answer"'));
    assert.equal(priv.answer, 'D');
    assert.deepEqual(priv.meta, { _id: 'abc123', domain: 'Single-Document QA', sub_domain: 'Legal', difficulty: 'hard', length: 'short' });
    assert.deepEqual(priv.graders, ['mc-answer']);
  });

  it('should keep the context verbatim and the choices in their original order', () => {
    let { pub } = toCase(item('abc123'), 'lb');
    assert.equal(pub.input, '  The text.\n\nMore text.  ');
    assert.equal(pub.question, 'What is it?');
    assert.deepEqual(pub.choices, ['alpha', 'beta', 'gamma', 'delta']);
  });
});

describe('loadData', () => {
  let write = async (items: unknown) => {
    let dir = await mkdtemp(join(tmpdir(), 'lb2-'));
    let path = join(dir, 'data.json');
    await writeFile(path, JSON.stringify(items));
    return path;
  };

  it('should load a fixture and refuse a bad answer, a duplicate id, or a missing field', async () => {
    let items = await loadData(await write([item('a'), item('b', 'D')]), { fixture: true });
    assert.deepEqual(items.map((it) => it._id), ['a', 'b']);
    await assert.rejects(loadData(await write([item('a', 'E')]), { fixture: true }), /answer "E" is not A-D/);
    await assert.rejects(loadData(await write([item('a'), item('a')]), { fixture: true }), /item a appears twice/);
    await assert.rejects(loadData(await write([{ ...item('a'), context: undefined }]), { fixture: true }), /context is not a string/);
  });

  it('should say how to get a missing file', async () => {
    await assert.rejects(loadData('/nonexistent/data.json'), /run npx tsx benchmarks\/longbench-v2\/fetch.ts/);
  });
});

describe('seededSample', () => {
  let items = Array.from({ length: 50 }, (_, i) => item(`id${String(i).padStart(2, '0')}`));

  it('should give the same sample for the same seed, whatever the input order', () => {
    let a = seededSample(items, 10, 1).map((it) => it._id);
    let b = seededSample([...items].reverse(), 10, 1).map((it) => it._id);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, 10);
    assert.notDeepEqual(seededSample(items, 10, 2).map((it) => it._id), a);
  });
});

describe('tally', () => {
  let rec = (caseId: string, extracted: string, pass: boolean, status: RunRecord['status'] = 'ok'): RunRecord => ({
    run: { ...result(''), caseId, skipped: status === 'unsupported' ? 'context_overflow' : undefined },
    grades: status === 'unsupported' ? [] : [{ grader: 'mc-answer', pass, score: pass ? 1 : 0, extracted }],
    judge: { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] },
    status,
  });
  let records = [
    rec('a', 'B', true), rec('b', 'A', false), rec('c', '(none)', false), rec('d', '(ambiguous)', false),
    rec('e', '', false, 'run_error'), rec('f', '', false, 'unsupported'), rec('g', 'C', true),
  ];

  it('should keep failed and invalid runs in the denominator, and skipped ones out of it', () => {
    let c = tally(records, 8);
    assert.deepEqual(
      [c.selected, c.records, c.notRun, c.eligible, c.correct, c.incorrect, c.invalid, c.failed, c.unsupported],
      [8, 7, 1, 6, 2, 1, 2, 1, 1],
    );
    assert.equal(c.accuracy, 2 / 6);
    assert.equal(c.coverage, 6 / 7);
    assert.equal(tally([]).accuracy, undefined);
  });

  it('should break the counts down by a key', () => {
    let rows = breakdown(records, (r) => (r.run.caseId < 'd' ? 'easy' : 'hard'));
    assert.deepEqual(rows.map((r) => [r.value, r.eligible, r.correct, r.unsupported]), [['easy', 3, 1, 0], ['hard', 3, 1, 1]]);
  });

  it('should read the truncation counts a harness recorded', () => {
    let r = rec('a', 'B', true);
    assert.equal(truncationOf(r), undefined);
    r.run.trace = { source: '', transformedSource: '', rawOutput: '', releasedOutput: '', stages: [{ name: 'input-safety', module: 'm', version: '1', mode: 'regex', findings: ['x', 'truncate_middle: 300000 tokens cut to 245000 (81.7% retained)'], decision: 'modified' }] };
    assert.deepEqual(truncationOf(r), { original: 300000, retained: 245000 });
  });
});

describe('truncateMiddle (lb2-direct)', () => {
  // a toy tokenizer: one character is one token
  let toy: Tok = { encode: (text) => [...text].map((ch) => ch.codePointAt(0)!), decode: (ids) => String.fromCodePoint(...ids) };

  it('should keep the head and the tail of the budget and cut the middle, as the reference does', () => {
    assert.deepEqual(truncateMiddle(toy, 'abcdefghij', 4), { text: 'abij', original: 10, retained: 4 });
    assert.deepEqual(truncateMiddle(toy, 'abcdefghij', 5), { text: 'abhij', original: 10, retained: 5 });
    assert.deepEqual(truncateMiddle(toy, 'abcdefghij', 10), { text: 'abcdefghij', original: 10, retained: 10 });
    assert.throws(() => truncateMiddle(toy, 'abc', 0), /keep must be positive/);
  });

  it('should count a long text in pieces without losing tokens', () => {
    let text = Array.from({ length: 2500 }, (_, i) => `line ${i} ${'x'.repeat(1000)}`).join('\n');
    assert.ok(text.length > 2_000_000);
    assert.equal(encodeChunked(toy, text).length, text.length);
  });
});
