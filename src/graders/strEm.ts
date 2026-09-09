import assert from 'node:assert/strict';
import type { Grader, PrivateCase } from '../types.js';

export { strEmGrader };
// internal API, exported for tests
export { normalizeAnswer, type StrEmGold };

// the gold of an ambiguous question: its sub-questions, each with its short answers
type StrEmGold = { qaPairs: { question: string; shortAnswers: string[] }[] };

// STR-EM after ALCE (Gao et al. 2023, eval.py compute_str_em): for each sub-question
// of an ambiguous question, is one of its short answers present in the output?
// score = share of sub-questions found; pass = all found (ALCE's STR-EM hit)
function strEmGrader(): Grader {
  return {
    name: 'str-em',
    description: 'Every gold short answer appears in the output. The score is the share of sub-questions answered.',
    async grade(_pub, priv, result) {
      assert(Array.isArray(priv.qaPairs) && priv.qaPairs.length > 0, `str-em: case ${priv.id} needs qaPairs`);
      let { qaPairs } = priv as PrivateCase & StrEmGold;
      let output = normalizeAnswer(result.output);
      let missing = qaPairs.filter((p) => !p.shortAnswers.some((a) => output.includes(normalizeAnswer(a))));
      let found = qaPairs.length - missing.length;
      return {
        grader: 'str-em',
        pass: missing.length === 0,
        score: found / qaPairs.length,
        detail: `${found}/${qaPairs.length} sub-questions answered` +
          (missing.length ? `; missing: ${missing.map((p) => p.shortAnswers[0]).join(' | ')}` : ''),
      };
    },
  };
}

// ALCE utils.normalize_answer: lowercase, drop punctuation and articles, collapse whitespace
function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '')
    .replace(/\b(a|an|the)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
