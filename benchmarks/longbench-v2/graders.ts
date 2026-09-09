import assert from 'node:assert/strict';
import type { Grader } from '../../src/types.js';

// multiple choice over one long document (LongBench v2). the answer is one letter A-D, requested
// from the model as "The correct answer is (A)". the extractor is the reference implementation's
// (THUDM/LongBench pred.py, extract_answer) made a little more tolerant of formatting, and stricter
// on ambiguity: several different letters in the answer form are no answer. no model grades or
// repairs an answer. loaded through benchmark.json
export { graders };
// internal API, exported for tests
export { extractAnswer, mcAnswerGrader };

// the answer form, with or without parentheses, a colon, and any of the formatting characters
// markdown adds; the letter must stand alone (not "The correct answer is Alpha")
const ANSWER_RE = /the correct answer is:?\s*\(?\s*([A-D])\s*\)?(?![A-Za-z])/gi;

type Extracted = { letter?: string; reason: 'ok' | 'none' | 'ambiguous' };

// the letter the output commits to, or why there is none: no answer form at all, or several
// with different letters. the same letter repeated is one answer
function extractAnswer(output: string): Extracted {
  let text = output.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/[*_`]/g, '');
  let letters = new Set([...text.matchAll(ANSWER_RE)].map((m) => m[1].toUpperCase()));
  if (letters.size === 1) return { letter: [...letters][0], reason: 'ok' };
  return { reason: letters.size === 0 ? 'none' : 'ambiguous' };
}

function mcAnswerGrader(): Grader {
  return {
    name: 'mc-answer',
    description:
      'The letter in "The correct answer is (X)" equals the gold letter. An output with no such answer, or with several different ones, is invalid and fails.',
    async grade(pub, priv, result) {
      assert(priv.answer && /^[A-D]$/.test(priv.answer), `mc-answer: case ${priv.id} needs a gold letter A-D`);
      let { letter, reason } = extractAnswer(result.output);
      let extracted = letter ?? `(${reason})`;
      let pass = letter === priv.answer;
      return { grader: 'mc-answer', pass, score: pass ? 1 : 0, extracted, detail: `extracted=${extracted} gold=${priv.answer}` };
    },
  };
}

let graders: Grader[] = [mcAnswerGrader()];
