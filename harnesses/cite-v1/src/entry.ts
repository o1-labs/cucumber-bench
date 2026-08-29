// the citation harness, on the vercel ai sdk. built up in steps, each measured
// against direct on asqa-dev:
//   step 1: the plain few-shot answer, identical to direct
//   step 2 (this file): a plan call lists every reading of the question the
//           documents answer; the answer must cover each one
//   step 3: check every citation before release
// protocol: stdin {publicCase, proxyUrl, token, model} -> stdout {output, trace} | {error}
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

const VERSION = '2';

// asqa questions are ambiguous on purpose; the gold answer covers every reading
const PLAN_PROMPT =
  'The question below may be ambiguous: it may have several readings, or several answers over time or place. ' +
  'Using only the documents, list the distinct readings that the documents answer. For each reading write one line: ' +
  'the reading, its answer, and the document numbers that support it, as [n]. At most 5 lines. ' +
  'If the documents answer none, write "none".\n\n';

type PublicCase = {
  id: string;
  suite: string;
  instructions: string;
  input: string;
  docs?: { title: string; text: string }[];
  examples?: { q: string; a: string }[];
};
type Stage = {
  name: string;
  module: string;
  version: string;
  policy?: string;
  mode: 'passthrough' | 'regex' | 'llm' | 'hybrid';
  findings: string[];
  decision: 'pass' | 'modified' | 'blocked';
};

let { publicCase: c, proxyUrl, token, model } = JSON.parse(await readStdin()) as {
  publicCase: PublicCase;
  proxyUrl: string;
  token: string;
  model: string;
};
let guarded = createOpenAICompatible({ name: 'guarded', baseURL: `${proxyUrl}/v1`, apiKey: token })(model);

try {
  // step 2: plan the readings (greedy), then answer with the plan as a coverage requirement.
  // the answer keeps direct's temperature so the plan is the only difference under test
  let plan = await ask(guarded, PLAN_PROMPT + c.input, 0);
  let answer = await ask(guarded, fewShotPrompt(c, plan), 1);
  let stages: Stage[] = [
    { name: 'input-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
    { name: 'agent', module: 'plan+answer', version: VERSION, mode: 'llm', findings: plan.split('\n').filter(Boolean), decision: 'pass' },
    { name: 'output-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
  ];
  respond({
    output: answer,
    trace: { source: c.input, transformedSource: c.input, rawOutput: answer, releasedOutput: answer, stages },
  });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the benchmark's own prompt: instructions, the worked examples, then the question
// with its passages; the plan becomes a coverage requirement before the answer
function fewShotPrompt(c: PublicCase, plan: string): string {
  let demos = (c.examples ?? []).map((ex) => `${ex.q}\nAnswer: ${ex.a}`);
  let coverage =
    plan.trim().toLowerCase() === 'none'
      ? ''
      : `\n\nCover each of these readings in one or two sentences, each with its citations:\n${plan}`;
  return [c.instructions, ...demos, `${c.input}${coverage}\nAnswer:`].join('\n\n\n');
}

// internal helpers

async function ask(m: LanguageModel, prompt: string, temperature?: number): Promise<string> {
  let { text } = await generateText({ model: m, prompt, temperature });
  // qwen3 and other reasoning models may emit <think>...</think> before the answer
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function readStdin(): Promise<string> {
  let chunks: Buffer[] = [];
  for await (let chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function respond(obj: unknown) {
  process.stdout.write(JSON.stringify(obj));
}
