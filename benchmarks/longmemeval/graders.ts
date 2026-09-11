import assert from 'node:assert/strict';
import type { Grader } from '../../src/types.js';
import { fieldsOf } from '../../src/gold.js';

// the official LongMemEval scorer (src/evaluation/evaluate_qa.py at commit 9e0b455): one yes/no
// question to the judge, with a template per question type, and the abstention template for a
// question whose id carries _abs. the official judge is gpt-4o-2024-08-06; benchmark.json names the
// repo's standard judge instead (deepseek flash), because the provider workspace blocks OpenAI
// models: a substitution the protocol allows, and run.json and the report record the judge used.
// loaded through benchmark.json
export { graders };
// internal API, exported for tests
export { longmemevalGrader, longmemevalGold, judgePrompt, isYes, type LongMemEvalGold };

// the gold of a LongMemEval question: the answer (or the rubric of a preference question, or why
// an unanswerable question cannot be answered), the type that picks the judge template, and
// whether the question is unanswerable
type LongMemEvalGold = { answer: string; questionType: string; abstention: boolean };

const ANSWER_TEMPLATE =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. ';
const TEMPLATES: { [type: string]: string } = {
  'single-session-user': ANSWER_TEMPLATE + '\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.',
  'single-session-assistant': ANSWER_TEMPLATE + '\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.',
  'multi-session': ANSWER_TEMPLATE + '\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.',
  'temporal-reasoning':
    ANSWER_TEMPLATE +
    "In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  'knowledge-update':
    'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.',
  'single-session-preference':
    "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {q}\n\nRubric: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
};
const ABSTENTION_TEMPLATE =
  'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {q}\n\nExplanation: {a}\n\nModel Response: {r}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.';

// the gold, checked: the question type must be one the official scorer has a template for
function longmemevalGold(raw: unknown, id: string): LongMemEvalGold {
  let { answer, questionType, abstention } = fieldsOf(raw, id, 'longmemeval');
  assert(
    typeof answer === 'string' && typeof questionType === 'string' && typeof abstention === 'boolean',
    `longmemeval: case ${id} needs answer, questionType and abstention`,
  );
  assert(TEMPLATES[questionType], `longmemeval: case ${id} has the unknown question type ${questionType}`);
  return { answer, questionType, abstention };
}

function judgePrompt(gold: LongMemEvalGold, question: string, response: string): string {
  let template = gold.abstention ? ABSTENTION_TEMPLATE : TEMPLATES[gold.questionType];
  // the official script formats with str.format; the fields never contain braces that matter
  return template.replace('{q}', question).replace('{a}', gold.answer).replace('{r}', response);
}

// the official parse: 'yes' in eval_response.lower(). a verdict that merely contains the word
// counts as yes; kept as is, because this is the pinned scorer
function isYes(verdict: string): boolean {
  return verdict.toLowerCase().includes('yes');
}

function longmemevalGrader(): Grader<LongMemEvalGold> {
  return {
    name: 'longmemeval',
    description: 'The official LongMemEval judge says the answer contains the gold answer, or, for an unanswerable question, that the answer abstains.',
    gold: longmemevalGold,
    async grade(pub, gold, result, ctx) {
      let verdict = await ctx.judge(judgePrompt(gold, pub.question ?? '', result.output));
      let pass = isYes(verdict);
      return {
        grader: 'longmemeval',
        pass,
        score: pass ? 1 : 0,
        detail: `${gold.questionType}${gold.abstention ? ' (abstention)' : ''}: judge said ${verdict.slice(0, 30)}; gold: ${gold.answer}`,
      };
    },
  };
}

let graders: Grader[] = [longmemevalGrader()];
