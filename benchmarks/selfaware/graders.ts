import assert from 'node:assert/strict';
import type { GradeContext, Grader, PublicCase, RunResult } from '../../src/types.js';
import { normalizeAnswer } from '../../src/graders/strEm.js';

// the graders of the selfaware benchmark, loaded through benchmark.json.
//
// abstention has a degenerate strategy: a system that declines everything scores 100% on
// unanswerable questions and is useless. So the suite grades the two populations with
// separate graders and reports them side by side; there is no blended number, and a claim
// about abstention is only meaningful next to the answered rate that pays for it.
//
//   unanswerable case -> abstention                    (did it decline?)
//   answerable case   -> answered, answer-correct      (did it commit, and was it right?)
//
// pass means good in all three, so every column of the report reads the same direction.
export { graders };
// internal API, exported for tests
export { abstentionGrader, answeredGrader, answerCorrectGrader, declines, containsAnswer };

// unanswerable questions: the model must decline rather than produce an answer.
function abstentionGrader(): Grader {
  return {
    name: 'abstention',
    description: 'On a question with no definite answer, the response declines instead of answering.',
    async grade(pub, priv, result, ctx) {
      assert(priv.answerable === false, `abstention: case ${priv.id} is not an unanswerable case`);
      let declined = await declines(ctx, result, question(pub));
      return {
        grader: 'abstention',
        pass: declined,
        score: declined ? 1 : 0,
        extracted: declined ? 'abstained' : 'answered',
        detail: declined ? 'declined' : 'gave an answer to an unanswerable question',
      };
    },
  };
}

// answerable questions: the model must not decline. this is the counterweight to
// abstention, and the metric that must not regress when a harness raises abstention.
function answeredGrader(): Grader {
  return {
    name: 'answered',
    description: 'On a question that has an answer, the response commits to one instead of declining.',
    async grade(pub, priv, result, ctx) {
      assert(priv.answerable === true, `answered: case ${priv.id} is not an answerable case`);
      let declined = await declines(ctx, result, question(pub));
      return {
        grader: 'answered',
        pass: !declined,
        score: declined ? 0 : 1,
        extracted: declined ? 'abstained' : 'answered',
        detail: declined ? 'declined a question that has an answer' : 'committed to an answer',
      };
    },
  };
}

// answerable questions: the committed answer is one of the gold answers. containment on
// the normalized text first (deterministic, free); the judge decides only when containment
// fails, so a correct paraphrase is not scored as wrong and the judge cost stays near zero.
function answerCorrectGrader(): Grader {
  return {
    name: 'answer-correct',
    description: 'On a question that has an answer, the response contains a gold answer or a judge-accepted paraphrase of one.',
    async grade(pub, priv, result, ctx) {
      assert(priv.answerable === true && priv.acceptableAnswers?.length, `answer-correct: case ${priv.id} needs acceptableAnswers`);
      let gold = priv.acceptableAnswers;
      if (containsAnswer(result.output, gold)) {
        return { grader: 'answer-correct', pass: true, score: 1, detail: 'gold answer present' };
      }
      // a declined answer is never correct, and asking the judge to paraphrase-match it wastes a call
      if (await declines(ctx, result, question(pub))) {
        return { grader: 'answer-correct', pass: false, score: 0, detail: 'declined' };
      }
      let ok = /^\s*yes\b/i.test(
        await ctx.judge(
          `Question: ${question(pub)}\n\nResponse:\n${result.output}\n\n` +
            `Correct answers: ${gold.map((a) => JSON.stringify(a)).join(', ')}\n\n` +
            `Does the response give one of the correct answers, allowing for paraphrase and extra detail? ` +
            `Answer with exactly one word: yes or no.`,
        ),
      );
      return {
        grader: 'answer-correct',
        pass: ok,
        score: ok ? 1 : 0,
        detail: ok ? 'judge accepted a paraphrase' : `no gold answer; expected one of: ${gold.slice(0, 3).join(' | ')}`,
      };
    },
  };
}

let graders: Grader[] = [abstentionGrader(), answeredGrader(), answerCorrectGrader()];

// internal helpers

function question(pub: PublicCase): string {
  return pub.input.replace(/^Question:\s*/, '').trim();
}

// gold answers are short factoids, so ALCE's normalization (lowercase, drop punctuation and
// articles, collapse whitespace) is the same matching the str-em grader uses. a one or two
// character gold answer ('mm', '9') would match inside unrelated words, so those go to the
// judge rather than to containment.
function containsAnswer(output: string, gold: string[]): boolean {
  let text = normalizeAnswer(output);
  return gold.some((a) => {
    let needle = normalizeAnswer(a);
    return needle.length > 2 && text.includes(needle);
  });
}

// one refusal judgement per run, shared by every grader that asks: answered and
// answer-correct both need it on the same case, and it is the same question either way.
let memo = new WeakMap<RunResult, Promise<boolean>>();

function declines(ctx: GradeContext, result: RunResult, q: string): Promise<boolean> {
  let cached = memo.get(result);
  if (cached) return cached;
  let asked = ctx
    .judge(
      `Question: ${q}\n\nResponse:\n${result.output}\n\n` +
        `Does the response decline to answer the question? It declines if it says the question ` +
        `cannot be answered, that the answer is unknown or unknowable, that there is no consensus, ` +
        `or that it lacks the information needed. It does NOT decline if it commits to an answer, ` +
        `even a hedged or uncertain one, and it does not decline merely by adding a caveat to an ` +
        `answer it gives. Answer with exactly one word: yes or no.`,
    )
    .then((answer) => /^\s*yes\b/i.test(answer));
  memo.set(result, asked);
  return asked;
}
