import assert from 'node:assert/strict';
import type { Grader } from '../types.js';
import { fieldsOf } from '../gold.js';

export { strEmGrader, type StrEmGold };
// internal API, exported for tests
export { normalizeAnswer };

// the gold of an ambiguous question: its sub-questions, each with its short answers
type StrEmGold = { qaPairs: { question: string; shortAnswers: string[] }[] };

// STR-EM after ALCE (Gao et al. 2023, eval.py compute_str_em): for each sub-question
// of an ambiguous question, is one of its short answers present in the output?
// score = share of sub-questions found; pass = all found (ALCE's STR-EM hit)
function strEmGrader(): Grader<StrEmGold> {
  return {
    name: 'str-em',
    description: 'Every gold short answer appears in the output. The score is the share of sub-questions answered.',
    gold(raw, id) {
      let { qaPairs } = fieldsOf(raw, id, 'str-em');
      assert(
        Array.isArray(qaPairs) && qaPairs.length > 0 &&
          qaPairs.every((p) => typeof p?.question === 'string' && Array.isArray(p.shortAnswers) && p.shortAnswers.every((a: unknown) => typeof a === 'string')),
        `str-em: case ${id} needs qaPairs, each with a question and shortAnswers`,
      );
      return { qaPairs };
    },
    async grade(_pub, gold, result) {
      let output = normalizeAnswer(result.output);
      let missing = gold.qaPairs.filter((p) => !p.shortAnswers.some((a) => output.includes(normalizeAnswer(a))));
      let found = gold.qaPairs.length - missing.length;
      return {
        grader: 'str-em',
        pass: missing.length === 0,
        score: found / gold.qaPairs.length,
        detail: `${found}/${gold.qaPairs.length} sub-questions answered` +
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
