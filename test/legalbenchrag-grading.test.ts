import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  legalBenchRagGold,
  parseLegalBenchRagOutput,
  ragPrecisionGrader,
  ragRecallGrader,
  scoreLegalBenchRag,
} from '../benchmarks/legalbenchrag/graders.js';
import type { GradeContext, PublicCase, RunResult } from '../src/types.js';

let pub = {
  id: 'lbr',
  docs: [
    { title: 'a.txt', text: 'alpha beta gamma delta' },
    { title: 'b.txt', text: 'wrong file text' },
    { title: 'unicode.txt', text: '🙂 alpha 🙂 alpha tail' },
  ],
} as PublicCase;

let ctx = { async judge() { return 'no'; } } as GradeContext;

function result(output: string): RunResult {
  return { caseId: 'lbr', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] };
}

describe('legalbenchrag character scoring', () => {
  it('scores perfect quote output as full recall and precision', async () => {
    let gold = legalBenchRagGold({ snippets: [{ file_path: 'a.txt', span: [6, 16] }] }, 'lbr');
    let out = JSON.stringify([{ file_path: 'a.txt', quote: 'beta gamma' }]);
    let recall = await ragRecallGrader().grade(pub, gold, result(out), ctx);
    let precision = await ragPrecisionGrader().grade(pub, gold, result(out), ctx);
    assert.deepEqual([recall.pass, recall.score, precision.pass, precision.score], [true, 1, true, 1]);
    assert.match(recall.detail!, /10 overlapping chars/);
  });

  it('gives partial credit and separates wrong-file returns from gold spans', async () => {
    let gold = legalBenchRagGold({ snippets: [{ file_path: 'a.txt', span: [6, 16] }] }, 'lbr');
    let partial = await ragRecallGrader().grade(pub, gold, result('[{"file_path":"a.txt","quote":"beta"}]'), ctx);
    assert.equal(partial.score, 0.4);
    let wrongFile = scoreLegalBenchRag(gold.snippets, [{ file_path: 'b.txt', start: 0, end: 4 }]);
    assert.deepEqual([wrongFile.recall, wrongFile.precision], [0, 0]);
  });

  it('merges duplicate and adjacent returned spans, and resolves Unicode codepoint offsets', () => {
    let parsed = parseLegalBenchRagOutput(
      pub,
      '```json\n[{"file_path":"unicode.txt","quote":"🙂 alpha","occurrence":1},{"file_path":"unicode.txt","quote":" tail"}]\n```',
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.snippets, [
      { file_path: 'unicode.txt', start: 8, end: 15 },
      { file_path: 'unicode.txt', start: 15, end: 20 },
    ]);
    let scored = scoreLegalBenchRag([{ file_path: 'unicode.txt', start: 8, end: 20 }], parsed.snippets);
    assert.deepEqual([scored.recall, scored.precision], [1, 1]);
    let duplicate = scoreLegalBenchRag([{ file_path: 'a.txt', start: 6, end: 10 }], [
      { file_path: 'a.txt', start: 6, end: 10 },
      { file_path: 'a.txt', start: 6, end: 10 },
    ]);
    assert.deepEqual([duplicate.recall, duplicate.precision], [1, 1]);
  });

  it('turns malformed or ambiguous model outputs into zero-score grade details', async () => {
    let gold = legalBenchRagGold({ snippets: [{ file_path: 'unicode.txt', span: [8, 15] }] }, 'lbr');
    let ambiguous = await ragRecallGrader().grade(pub, gold, result('[{"file_path":"unicode.txt","quote":"🙂 alpha"}]'), ctx);
    assert.equal(ambiguous.score, 0);
    assert.match(ambiguous.detail!, /appears 2 times/);
    let invented = await ragPrecisionGrader().grade(pub, gold, result('[{"file_path":"unicode.txt","quote":"not in source"}]'), ctx);
    assert.equal(invented.score, 0);
    assert.match(invented.detail!, /not verbatim/);
    let rawSpan = await ragRecallGrader().grade(pub, gold, result('[{"file_path":"unicode.txt","span":[9,16]}]'), ctx);
    assert.equal(rawSpan.score, 0);
    assert.match(rawSpan.detail!, /quote/);
  });

  it('rejects invalid gold snippets before model calls', () => {
    assert.throws(() => legalBenchRagGold({ snippets: [] }, 'bad'), /nonempty snippets/);
    assert.throws(
      () => legalBenchRagGold({ snippets: [{ file_path: 'a.txt', span: [0, 5] }, { file_path: 'a.txt', span: [5, 8] }] }, 'bad'),
      /overlapping or adjacent gold spans/,
    );
    assert.throws(() => legalBenchRagGold({ snippets: [{ file_path: 'a.txt', span: [3, 3] }] }, 'bad'), /valid nonempty/);
  });
});
