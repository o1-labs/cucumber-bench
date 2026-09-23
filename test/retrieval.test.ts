import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadCases } from '../src/caseStore.js';
import { selectBm25Context } from '../harnesses/review-v1/src/retrieval.js';
import {
  BM25_EXPANDED_V1_POLICY,
  BM25_V1_POLICY,
  reviewSelection,
  type Bm25ReviewPolicy,
} from '../harnesses/review-v1/src/bm25-review.js';

function docs(count = 10, words = 10) {
  return Array.from({ length: count }, (_, index) => ({
    title: `part ${index + 1}`,
    text: `${index === 0 ? 'terminate agreement ' : ''}${'word '.repeat(words)}`.trim(),
  }));
}

describe('BM25 context selection', () => {
  it('preserves ranked seeds, adds neighbors, deduplicates, and returns document order', () => {
    let selection = selectBm25Context('terminate agreement', docs(), { wordBudget: 200 });
    assert.deepEqual(selection.seedPassageIndexes, [0, 1, 2, 3, 4]);
    assert.deepEqual(selection.passageIndexes, [0, 1, 2, 3, 4, 5]);
    assert.equal(selection.wordCount, 62);
  });

  it('obeys the word budget without dropping a seed', () => {
    let selection = selectBm25Context('terminate agreement', docs(), { wordBudget: 52 });
    assert.deepEqual(selection.passageIndexes, [0, 1, 2, 3, 4]);
    assert.equal(selection.seedWordCount, 52);
    assert.equal(selection.wordCount, 52);
  });

  it('rejects a budget smaller than the seed set', () => {
    assert.throws(
      () => selectBm25Context('terminate agreement', docs(), { wordBudget: 51 }),
      /seeds need 52 words/,
    );
  });

  it('ranks Unicode query terms', () => {
    let selection = selectBm25Context('SÖZLEŞME sona erdi', [
      { text: 'Tarafların sözleşme sona erdi hükmü.' },
      { text: 'Unrelated payment provision.' },
    ], { seedLimit: 1, radius: 0, wordBudget: 20 });
    assert.deepEqual(selection.seedPassageIndexes, [0]);
  });

  it('matches the pinned Python BM25 seed ranking on a development contract', async () => {
    let { pub } = (await loadCases('benchmarks/cuad-hard-dev')).find((item) => item.pub.id === 'cuad-hard-dev-109')!;
    let question = pub.input.split(/\n\nDocument \[1\]/)[0];
    let selection = selectBm25Context(question, pub.docs!);
    assert.deepEqual(selection.seedPassageIndexes.map((index) => index + 1), [24, 13, 2, 3, 23]);
    assert.ok(selection.wordCount <= 3000);
  });

  it('reproduces the registered candidate-coverage diagnostic on development cases', async () => {
    let cases = (await loadCases('benchmarks/cuad-hard-dev')).filter((item) => (item.priv as any).clauses.length > 0);
    let coverage = (policy: Bm25ReviewPolicy) => {
      let relevant = 0, selected = 0, full = 0, partial = 0, none = 0;
      for (let item of cases) {
        let selection = new Set(reviewSelection(item.pub, policy).passageIndexes);
        let passages = new Set<number>((item.priv as any).clauses.flatMap((clause: any) => clause.passages));
        let hits = [...passages].filter((passage) => selection.has(passage)).length;
        relevant += passages.size;
        selected += hits;
        if (hits === 0) none++;
        else if (hits === passages.size) full++;
        else partial++;
      }
      return { selected, relevant, full, partial, none };
    };

    assert.deepEqual(coverage(BM25_V1_POLICY), { selected: 11, relevant: 20, full: 6, partial: 3, none: 2 });
    assert.deepEqual(coverage(BM25_EXPANDED_V1_POLICY), { selected: 16, relevant: 20, full: 9, partial: 2, none: 0 });
  });
});
