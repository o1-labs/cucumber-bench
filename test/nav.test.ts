import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseCommand, read, search } from '../harnesses/lb2-nav/src/tools.js';

// a toy counter: one token per word
let count = (s: string) => s.split(/\s+/).length;
let lines = ['The HEAD of the text.', '', 'A line about the Fourth Floor here.', 'another line, fourth  floor again', 'the TAIL'];

describe('lb2-nav tools', () => {
  describe('parseCommand', () => {
    it('should read the last line as the command, and anything else as the answer', () => {
      assert.deepEqual(parseCommand('I will look.\nsearch: fourth floor\n'), { kind: 'search', words: 'fourth floor' });
      assert.deepEqual(parseCommand('search: "high-quality cases"'), { kind: 'search', words: 'high-quality cases' });
      assert.deepEqual(parseCommand('READ: 3-4'), { kind: 'read', from: 3, to: 4 });
      assert.deepEqual(parseCommand('`read: 7`'), { kind: 'read', from: 7, to: 7 });
      assert.deepEqual(parseCommand('search: TV show\n\nNext command:'), { kind: 'search', words: 'TV show' });
      assert.equal(parseCommand('The correct answer is (B)'), undefined);
      assert.equal(parseCommand(''), undefined);
      assert.equal(parseCommand('read: 3-4\nThe correct answer is (B)'), undefined);
    });
  });

  describe('search', () => {
    it('should match case-insensitively with whitespace collapsed, and cap the hits but not the count', () => {
      let r = search(lines, 'Fourth   floor', 5);
      assert.equal(r.total, 2);
      assert.equal(r.text, '2 line(s) match:\n[line 3] a line about the fourth floor here.\n[line 4] another line, fourth floor again');
      assert.equal(search(lines, 'fourth floor', 1).text, '2 lines match; the first 1:\n[line 3] a line about the fourth floor here.');
      assert.equal(search(lines, 'cellar', 5).text, 'no line contains "cellar"');
    });

    it('should show a window around the match in a long line', () => {
      let long = ['x'.repeat(500) + ' needle ' + 'y'.repeat(500)];
      let { text } = search(long, 'needle', 5);
      assert.ok(text.startsWith('1 line(s) match:\n[line 1] ...xxx'));
      assert.ok(text.endsWith('yyy...'));
      assert.ok(text.length < 260);
    });
  });

  describe('read', () => {
    it('should return the range with line numbers', () => {
      assert.deepEqual(read(lines, 4, 5, count, 100), { lines: 2, text: '[line 4] another line, fourth  floor again\n[line 5] the TAIL' });
    });

    it('should cut at the token limit and say where to continue', () => {
      let r = read(lines, 1, 5, count, 10);
      assert.equal(r.lines, 2);
      assert.ok(r.text.endsWith('[line 2] \n(cut at line 2: the read limit is 10 tokens; read from line 3 to continue)'));
      // a single line beyond the limit is still returned, so a read always makes progress
      assert.equal(read(lines, 3, 3, count, 1).lines, 1);
    });

    it('should refuse a range outside the text', () => {
      assert.equal(read(lines, 0, 2, count, 100).text, 'read: the text has lines 1-5; 0-2 is not a range in it');
      assert.equal(read(lines, 4, 9, count, 100).lines, 0);
    });
  });
});
