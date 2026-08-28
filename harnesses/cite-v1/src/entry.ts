// the citation harness, on the vercel ai sdk. built up in steps, each measured
// against direct on asqa-dev:
//   step 1 (this file): the plain few-shot answer, identical to direct
//   step 2: cover every reading of the question before answering
//   step 3: check every citation before release
// protocol: stdin {publicCase, proxyUrl, token, model} -> stdout {output, trace} | {error}
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

const VERSION = '1';

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
  let answer = await ask(guarded, fewShotPrompt(c), 1);
  let stages: Stage[] = [
    { name: 'input-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
    { name: 'agent', module: 'few-shot-answer', version: VERSION, mode: 'llm', findings: [], decision: 'pass' },
    { name: 'output-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
  ];
  respond({
    output: answer,
    trace: { source: c.input, transformedSource: c.input, rawOutput: answer, releasedOutput: answer, stages },
  });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the benchmark's own prompt: instructions, the worked examples, then the question with its passages
function fewShotPrompt(c: PublicCase): string {
  let demos = (c.examples ?? []).map((ex) => `${ex.q}\nAnswer: ${ex.a}`);
  return [c.instructions, ...demos, `${c.input}\nAnswer:`].join('\n\n\n');
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
