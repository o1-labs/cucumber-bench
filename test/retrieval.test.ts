import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadCases } from '../src/caseStore.js';
import { selectBm25Context } from '../harnesses/review-v1/src/retrieval.js';

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
});
