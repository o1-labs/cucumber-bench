import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { chunkDocument, formatEvidence, parseQuotes, rankChunks, type Chunk } from '../harnesses/lb2-custom/src/evidence.js';
import type { Tok } from '../harnesses/lb2-direct/src/tokenizer.js';

// a toy tokenizer: one token per character
let tok: Tok = { encode: (s) => [...s].map((c) => c.charCodeAt(0)), decode: (ids) => String.fromCharCode(...ids) };

describe('lb2-custom evidence', () => {
  describe('chunkDocument', () => {
    it('should cut at newlines into pieces within the budget, whose offsets and texts rebuild the document', () => {
      let doc = 'first line\nsecond line\nthird\n';
      let chunks = chunkDocument(tok, doc, 14);
      assert.deepEqual(chunks.map((c) => [c.index, c.start, c.text]), [[1, 0, 'first line\n'], [2, 11, 'second line\n'], [3, 23, 'third\n']]);
      assert.ok(chunks.every((c) => c.tokens <= 14 && doc.slice(c.start, c.start + c.text.length) === c.text));
      assert.equal(chunkDocument(tok, 'abcdefgh', 3).map((c) => c.text).join('|'), 'abc|def|gh');
    });
  });

  describe('rankChunks', () => {
    let chunk = (index: number, text: string): Chunk => ({ index, start: 0, text, tokens: 1 });
    it('should keep the best-scoring chunks in document order, and every chunk when few', () => {
      let chunks = [
        chunk(1, 'the cellar door was locked the whole night'),
        chunk(2, 'Becca lives on the third floor with Greg'),
        chunk(3, 'the weather was fine the whole day'),
        chunk(4, 'the super said the couple lived on the second floor'),
      ];
      assert.deepEqual(rankChunks(chunks, 'Which floor do Becca and Greg live on?', 2).map((c) => c.index), [2, 4]);
      assert.deepEqual(rankChunks(chunks, 'anything', 4).map((c) => c.index), [1, 2, 3, 4]);
    });
  });

  describe('parseQuotes', () => {
    let chunk: Chunk = { index: 2, start: 100, text: 'Eve paused on the "third" floor.\nA couple on the second floor.\n', tokens: 1 };
    it('should keep tagged quotes that are in the chunk, with their offsets in the document', () => {
      let { quotes, dropped } = parseQuotes('C+ "Eve paused on the “third” floor."\n- (D+) A couple   on the second floor.\nB- not in the text\nx', chunk, 10);
      assert.equal(dropped, 2);
      assert.deepEqual(quotes.map((q) => [q.tag, q.text, q.start, q.end]), [
        ['C+', 'Eve paused on the "third" floor.', 100, 132],
        ['D+', 'A couple on the second floor.', 133, 162],
      ]);
    });
    it('should cap the quotes, and read None as no evidence', () => {
      assert.equal(parseQuotes('A+ Eve paused\nB+ A couple\nC+ floor', chunk, 2).quotes.length, 2);
      assert.deepEqual(parseQuotes('None.', chunk, 2), { quotes: [], dropped: 0 });
    });
  });

  describe('formatEvidence', () => {
    it('should lay the quotes out with their chunk, or say there is none', () => {
      let q = { chunk: 2, tag: 'D+', text: 'A couple', start: 0, end: 8 };
      assert.equal(formatEvidence([q], 5), '[chunk 2 of 5] (D+) "A couple"');
      assert.match(formatEvidence([], 5), /^No passage/);
    });
  });
});
