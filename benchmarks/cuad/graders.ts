import assert from 'node:assert/strict';
import { citationsOf, entails, passages, removeCitations, sentences } from '../asqa/graders.js';
import type { Grader, PrivateCase, PublicCase } from '../../src/types.js';

// clause questions over a contract split into numbered passages (CUAD, Hendrycks et al. 2021).
// the private case names the gold clauses and the passages that contain them, so where the
// answer must point is known exactly; only the support of the wording needs the judge.
// an absent clause (clauses: []) is the other half of the task: the answer must state the
// absence and cite nothing. loaded through benchmark.json
export { graders };
// internal API, exported for tests
export { clauseRecallGrader, clausePrecisionGrader, citationSupportGrader };

// clause recall: the answer cites, for every gold clause, at least one passage that contains it.
// absent clause: the answer states that the contract has no such clause (judge).
function clauseRecallGrader(): Grader {
  return {
    name: 'clause-recall',
    description:
      'The answer cites a passage that contains the clause, for every clause the contract has. The score is the share of clauses found. ' +
      'When the contract has no such clause, the answer must say so.',
    async grade(pub, priv, result, ctx) {
      let clauses = clausesOf(priv);
      if (result.error) return { grader: 'clause-recall', pass: false, score: 0, detail: `error: ${result.error}` };
      let cited = citationsOf(result.output, docsOf(pub).length);
      if (clauses.length === 0) {
        let stated = await statesAbsence(ctx, pub, result.output);
        return { grader: 'clause-recall', pass: stated, score: stated ? 1 : 0, detail: stated ? 'absence stated' : 'absence not stated' };
      }
      let found = clauses.filter((c) => c.passages.some((p) => cited.includes(p))).length;
      return {
        grader: 'clause-recall',
        pass: found === clauses.length,
        score: found / clauses.length,
        detail: `${found}/${clauses.length} clauses cited; cited ${cited.map((p) => `[${p + 1}]`).join('') || 'nothing'}, gold ${clauses.map((c) => c.passages.map((p) => `[${p + 1}]`).join('')).join(' ')}`,
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
      if (result.error) return { grader: 'clause-precision', pass: false, score: 0, detail: `error: ${result.error}` };
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

// citation support: every sentence that cites passages is supported by them (judge, as in asqa).
// a sentence without citations is not judged here; clause recall and precision cover the
// presence of citations. with no cited sentence: a present clause fails, an absent one passes.
function citationSupportGrader(): Grader {
  return {
    name: 'citation-support',
    description: 'Every sentence that cites passages is supported by the passages it cites. The score is the share of cited sentences supported.',
    async grade(pub, priv, result, ctx) {
      let docs = docsOf(pub);
      if (result.error) return { grader: 'citation-support', pass: false, score: 0, detail: `error: ${result.error}` };
      let cited = sentences(result.output).filter((s) => citationsOf(s, docs.length).length > 0);
      if (cited.length === 0) {
        let absent = clausesOf(priv).length === 0;
        return { grader: 'citation-support', pass: absent, score: absent ? 1 : 0, detail: 'no cited sentence' };
      }
      let verdicts = await Promise.all(
        cited.map((s) => entails(ctx, result, passages(docs, citationsOf(s, docs.length)), removeCitations(s))),
      );
      let supported = verdicts.filter(Boolean).length;
      return {
        grader: 'citation-support',
        pass: supported === cited.length,
        score: supported / cited.length,
        detail: `${supported}/${cited.length} cited sentences supported`,
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

// the clause type is in the question: ... contain a "Governing Law" clause? ...
function statesAbsence(ctx: { judge: (p: string) => Promise<string> }, pub: PublicCase, output: string) {
  let type = pub.input.match(/contain a "([^"]+)" clause/)?.[1] ?? 'such';
  return ctx
    .judge(
      `Answer:\n${output}\n\nDoes the answer state that the contract contains no "${type}" clause (no such clause)? ` +
        `Answer with exactly one word: yes or no.`,
    )
    .then((a) => /^\s*yes\b/i.test(a));
}
