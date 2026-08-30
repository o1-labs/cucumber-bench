import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { citationSupportGrader, clausePrecisionGrader, clauseRecallGrader } from '../benchmarks/cuad/graders.js';
import { loadCases } from '../src/caseStore.js';
import type { GradeContext, PrivateCase, PublicCase, RunResult } from '../src/types.js';

let pub = {
  id: 'c',
  input: 'Question: Does the contract "X" contain a "Governing Law" clause? (Governing Law: which law governs)\n\n...',
  docs: [
    { title: 'X, part 1 of 3', text: 'This Agreement is made between A and B.' },
    { title: 'X, part 2 of 3', text: 'This Agreement shall be governed by the laws of the State of Delaware.' },
    { title: 'X, part 3 of 3', text: 'Signed by both parties.' },
  ],
} as PublicCase;
let present = { id: 'c', graders: [], clauses: [{ text: 'governed by the laws of the State of Delaware', passages: [1] }] } as PrivateCase;
let absent = { id: 'c', graders: [], clauses: [] } as PrivateCase;

// fake judge: entailment when the premise contains the quoted part of the hypothesis (or the
// whole hypothesis without its final period); absence when the answer says "no" and "clause";
// "about the documents" when a sentence speaks of the contract containing a clause
let ctx: GradeContext = {
  async judge(prompt) {
    if (prompt.startsWith('Answer:\n')) {
      let answer = prompt.slice(8, prompt.indexOf('\n\nDoes the answer'));
      return /\bno\b.*\bclause\b/i.test(answer) ? 'yes' : 'no';
    }
    if (prompt.startsWith('Sentence:\n')) {
      let sentence = prompt.slice(10, prompt.indexOf('\n\nIs this sentence'));
      return /contract contains? (no|an?) .*clause\.?$/i.test(sentence) ? 'yes' : 'no';
    }
    let premise = prompt.slice(prompt.indexOf('Premise:\n') + 9, prompt.indexOf('\n\nHypothesis: '));
    let claim = prompt.slice(prompt.indexOf('Hypothesis: ') + 12, prompt.indexOf('\n\nDoes the premise'));
    let key = claim.match(/"([^"]+)"/)?.[1] ?? claim.replace(/\.$/, '');
    return premise.includes(key) ? 'yes' : 'no';
  },
};

function result(output: string): RunResult {
  return { caseId: 'c', system: 's', repetition: 1, output, latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] };
}

describe('cuad graders', () => {
  it('should pass a present clause quoted from its gold passage', async () => {
    let r = result('Yes. The contract states: "governed by the laws of the State of Delaware" [2].');
    let recall = await clauseRecallGrader().grade(pub, present, r, ctx);
    let precision = await clausePrecisionGrader().grade(pub, present, r, ctx);
    let support = await citationSupportGrader().grade(pub, present, r, ctx);
    assert.deepEqual([recall.pass, precision.pass, support.pass], [true, true, true]);
    assert.equal(recall.score, 1);
    assert.match(recall.detail!, /1\/1 clauses quoted and cited/);
  });

  it('should fail recall and precision when the wrong passage is cited, and precision when a wrong one is added', async () => {
    let wrong = result('The contract states: "governed by the laws of the State of Delaware" [1].');
    assert.equal((await clauseRecallGrader().grade(pub, present, wrong, ctx)).score, 0);
    assert.equal((await clausePrecisionGrader().grade(pub, present, wrong, ctx)).score, 0);
    let extra = result('The contract states: "governed by the laws of the State of Delaware" [1][2].');
    assert.equal((await clauseRecallGrader().grade(pub, present, extra, ctx)).pass, true);
    let p = await clausePrecisionGrader().grade(pub, present, extra, ctx);
    assert.equal(p.pass, false);
    assert.equal(p.score, 0.5);
  });

  it('should fail recall when the clause is cited but not quoted, or quoted but not cited', async () => {
    // the audit's case: an unrelated statement with a citation to the gold passage
    let unrelated = result('This Agreement is made between A and B [2].');
    let r = await clauseRecallGrader().grade(pub, present, unrelated, ctx);
    assert.equal(r.score, 0);
    assert.match(r.detail!, /0\/1 clauses quoted and cited \(0 quoted\)/);
    let uncited = result('The contract states: "governed by the laws of the State of Delaware".');
    assert.equal((await clauseRecallGrader().grade(pub, present, uncited, ctx)).score, 0);
    assert.equal((await clausePrecisionGrader().grade(pub, present, uncited, ctx)).pass, false);
  });

  it('should count an uncited fact as unsupported, and ignore fragments like "Yes."', async () => {
    // the audit's case: a correct cited quote plus an uncited false statement
    let mixed = result('Yes. The contract states: "governed by the laws of the State of Delaware" [2]. It was signed in 1999.');
    let s = await citationSupportGrader().grade(pub, present, mixed, ctx);
    assert.equal(s.pass, false);
    assert.equal(s.score, 0.5);
    assert.equal(s.detail, '1/2 sentences supported or about the documents');
    // a cited sentence the passage does not support
    let wrong = result('Yes. The contract says "governed by the laws of the State of Delaware" [2]. It was signed in 1999 [3].');
    assert.equal((await citationSupportGrader().grade(pub, present, wrong, ctx)).score, 0.5);
  });

  it('should accept an uncited statement about the documents', async () => {
    let r = result('The contract contains a Governing Law clause. It states: "governed by the laws of the State of Delaware" [2].');
    let s = await citationSupportGrader().grade(pub, present, r, ctx);
    assert.equal(s.pass, true);
  });

  it('should pass an absent clause when the answer states the absence and cites nothing', async () => {
    let r = result('The contract contains no "Governing Law" clause.');
    let recall = await clauseRecallGrader().grade(pub, absent, r, ctx);
    let precision = await clausePrecisionGrader().grade(pub, absent, r, ctx);
    let support = await citationSupportGrader().grade(pub, absent, r, ctx);
    assert.deepEqual([recall.pass, precision.pass, support.pass], [true, true, true]);
    assert.equal(recall.detail, 'absence stated');
  });

  it('should fail an absent clause when the answer invents one', async () => {
    let r = result('Yes. The contract is governed by Delaware law [2].');
    assert.equal((await clauseRecallGrader().grade(pub, absent, r, ctx)).pass, false);
    let p = await clausePrecisionGrader().grade(pub, absent, r, ctx);
    assert.equal(p.pass, false);
    assert.match(p.detail!, /for an absent clause/);
  });

  it('should load the cuad cases with gold passages that contain the clause text', async () => {
    let cases = await loadCases('benchmarks/cuad');
    assert.equal(cases.length, 100);
    let absentCases = cases.filter((c) => c.priv.clauses!.length === 0);
    assert.equal(absentCases.length, 30);
    for (let { pub, priv } of cases) {
      assert.deepEqual(priv.graders, ['clause-recall', 'clause-precision', 'citation-support']);
      for (let clause of priv.clauses!) {
        let text = clause.passages.map((p) => pub.docs![p].text).join(' ');
        // the first words of the clause are in its gold passages
        assert.ok(text.includes(clause.text.split(' ').slice(0, 5).join(' ')), `${pub.id}: clause not in its passages`);
      }
    }
  });
});
