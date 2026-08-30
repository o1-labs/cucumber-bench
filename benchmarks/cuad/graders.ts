import assert from 'node:assert/strict';
import { citationsOf, entails, passages, removeCitations, sentences } from '../asqa/graders.js';
import { longestRun } from '../../src/text.js';
import type { GradeContext, Grader, PrivateCase, PublicCase } from '../../src/types.js';

// clause questions over a contract split into numbered passages (CUAD, Hendrycks et al. 2021).
// the private case holds the gold clause texts and the passages that contain them, so what the
// answer must quote and where it must point are both known exactly; the judge is needed only
// for the support of the wording. an absent clause (clauses: []) is the other half of the task:
// the answer must state the absence and cite nothing. loaded through benchmark.json
export { graders };
// internal API, exported for tests
export { clauseRecallGrader, clausePrecisionGrader, citationSupportGrader };

// a clause counts as quoted when this many consecutive words of it are in the answer
const QUOTE_WORDS = 8;
// shorter sentences ("Yes.") are fragments of the answer form, not claims
const MIN_WORDS = 3;

// clause recall: for every gold clause, the answer quotes it (QUOTE_WORDS consecutive words)
// and cites a passage that contains it. a citation to the right passage with other text is not
// a find. absent clause: the answer states that the contract has no such clause (judge).
function clauseRecallGrader(): Grader {
  return {
    name: 'clause-recall',
    description:
      'For every clause the contract has, the answer quotes it and cites a passage that contains it. The score is the share of clauses found. ' +
      'When the contract has no such clause, the answer must say so.',
    async grade(pub, priv, result, ctx) {
      let clauses = clausesOf(priv);
      let cited = citationsOf(result.output, docsOf(pub).length);
      if (clauses.length === 0) {
        let stated = await statesAbsence(ctx, pub, result.output);
        return { grader: 'clause-recall', pass: stated, score: stated ? 1 : 0, detail: stated ? 'absence stated' : 'absence not stated' };
      }
      let quoted = clauses.filter((c) => longestRun(c.text, result.output) >= QUOTE_WORDS);
      let found = quoted.filter((c) => c.passages.some((p) => cited.includes(p))).length;
      return {
        grader: 'clause-recall',
        pass: found === clauses.length,
        score: found / clauses.length,
        detail:
          `${found}/${clauses.length} clauses quoted and cited (${quoted.length} quoted); ` +
          `cited ${cited.map((p) => `[${p + 1}]`).join('') || 'nothing'}, gold ${clauses.map((c) => c.passages.map((p) => `[${p + 1}]`).join('')).join(' ')}`,
      };
    },
  };
}

// clause precision: every cited passage contains a gold clause. absent clause: nothing is cited.
function clausePrecisionGrader(): Grader {
  return {
    name: 'clause-precision',
    description:
      'Every cited passage contains the clause. The score is the share of citations that do. ' +
      'When the contract has no such clause, the answer must cite nothing.',
    async grade(pub, priv, result) {
      let clauses = clausesOf(priv);
      let cited = citationsOf(result.output, docsOf(pub).length);
      if (clauses.length === 0) {
        let clean = cited.length === 0;
        return { grader: 'clause-precision', pass: clean, score: clean ? 1 : 0, detail: clean ? 'nothing cited' : `cited ${cited.map((p) => `[${p + 1}]`).join('')} for an absent clause` };
      }
      if (cited.length === 0) return { grader: 'clause-precision', pass: false, score: 0, detail: 'nothing cited' };
      let gold = new Set(clauses.flatMap((c) => c.passages));
      let right = cited.filter((p) => gold.has(p)).length;
      return {
        grader: 'clause-precision',
        pass: right === cited.length,
        score: right / cited.length,
        detail: `${right}/${cited.length} citations contain the clause`,
      };
    },
  };
}

// citation support: every sentence is supported by the passages it cites (judge, as in asqa).
// a sentence without citations passes only when it is a statement about the documents
// themselves ("the contract contains no such clause"); an uncited fact is unsupported.
// fragments under MIN_WORDS ("Yes.") are not judged.
function citationSupportGrader(): Grader {
  return {
    name: 'citation-support',
    description:
      'Every sentence is supported by the passages it cites; a sentence without citations passes only when it is a statement about the documents, not a fact. ' +
      'The score is the share of such sentences.',
    async grade(pub, priv, result, ctx) {
      let docs = docsOf(pub);
      let sents = sentences(result.output).filter((s) => removeCitations(s).split(' ').length >= MIN_WORDS);
      if (sents.length === 0) return { grader: 'citation-support', pass: false, score: 0, detail: 'no sentence' };
      let verdicts = await Promise.all(
        sents.map(async (s) => {
          let refs = citationsOf(s, docs.length);
          let claim = removeCitations(s);
          return refs.length > 0 ? entails(ctx, result, passages(docs, refs), claim) : aboutDocuments(ctx, claim);
        }),
      );
      let ok = verdicts.filter(Boolean).length;
      return {
        grader: 'citation-support',
        pass: ok === sents.length,
        score: ok / sents.length,
        detail: `${ok}/${sents.length} sentences supported or about the documents`,
      };
    },
  };
}

let graders: Grader[] = [clauseRecallGrader(), clausePrecisionGrader(), citationSupportGrader()];

// internal helpers

function docsOf(pub: PublicCase) {
  assert(pub.docs && pub.docs.length > 0, `cuad graders: case ${pub.id} needs docs`);
  return pub.docs;
}

function clausesOf(priv: PrivateCase) {
  assert(Array.isArray(priv.clauses), `cuad graders: case ${priv.id} needs clauses`);
  return priv.clauses;
}

// an uncited sentence is acceptable only as a statement about the documents themselves
function aboutDocuments(ctx: GradeContext, sentence: string): Promise<boolean> {
  return ctx
    .judge(
      `Sentence:\n${sentence}\n\nIs this sentence a statement about the documents themselves, for example that they ` +
        `do or do not contain something, with no fact taken from the documents? Answer with exactly one word: yes or no.`,
    )
    .then((a) => /^\s*yes\b/i.test(a));
}

// the clause type is in the question: ... contain a "Governing Law" clause? ...
function statesAbsence(ctx: GradeContext, pub: PublicCase, output: string) {
  let type = pub.input.match(/contain a "([^"]+)" clause/)?.[1] ?? 'such';
  return ctx
    .judge(
      `Answer:\n${output}\n\nDoes the answer state that the contract contains no "${type}" clause (no such clause)? ` +
        `Answer with exactly one word: yes or no.`,
    )
    .then((a) => /^\s*yes\b/i.test(a));
}
