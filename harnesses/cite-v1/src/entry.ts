// the citation harness, on the vercel ai sdk. built up in steps, each measured
// against direct on asqa-dev:
//   step 1: the plain few-shot answer, identical to direct
//   step 2: a greedy plan lists every reading of the question the documents answer
//   step 3 (this file): the plan also selects the passages; the answer sees only
//           those, under their original numbers, plus the coverage requirement
//   step 4: check every citation before release
// protocol: stdin {publicCase, proxyUrl, token, model} -> stdout {output, trace} | {error}
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

const VERSION = '3';
// the answer prompt carries at most this many passages; with none selected, the top ones
const MAX_SELECTED = 8;
const FALLBACK_TOP = 5;

// asqa questions are ambiguous on purpose; the gold answer covers every reading
const PLAN_PROMPT =
  'The question below may be ambiguous: it may have several readings, or several answers over time or place. ' +
  'Using only the documents, list the distinct readings that the documents answer. For each reading write one line: ' +
  'the reading, its answer, and the document numbers that support it, as [n]. At most 5 lines. ' +
  'If the documents answer none, write "none".\n\n';

type Doc = { title: string; text: string };
type PublicCase = {
  id: string;
  suite: string;
  instructions: string;
  input: string;
  docs?: Doc[];
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
  // plan the readings over all passages (greedy); the passages the plan cites are the selection
  let plan = await ask(guarded, PLAN_PROMPT + c.input, 0);
  let docs = c.docs ?? [];
  let selected = citedIn(plan, docs.length).slice(0, MAX_SELECTED);
  if (selected.length === 0) selected = docs.slice(0, FALLBACK_TOP).map((_, i) => i);
  // the answer keeps direct's temperature so the plan and the selection are the only differences under test
  let answer = await ask(guarded, fewShotPrompt(c, plan, selected), 1);
  let stages: Stage[] = [
    { name: 'input-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
    {
      name: 'agent',
      module: 'plan+select+answer',
      version: VERSION,
      mode: 'llm',
      findings: [`selected: ${selected.map((i) => i + 1).join(', ')}`, ...plan.split('\n').filter(Boolean)],
      decision: 'pass',
    },
    { name: 'output-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
  ];
  respond({
    output: answer,
    trace: { source: c.input, transformedSource: c.input, rawOutput: answer, releasedOutput: answer, stages },
  });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the benchmark's own prompt: instructions, the worked examples, then the question with
// the selected passages under their original numbers, and the plan as a coverage requirement
function fewShotPrompt(c: PublicCase, plan: string, selected: number[]): string {
  let demos = (c.examples ?? []).map((ex) => `${ex.q}\nAnswer: ${ex.a}`);
  let question = c.input.split('\n')[0];
  let docs = (c.docs ?? []).flatMap((d, i) => (selected.includes(i) ? [`Document [${i + 1}](Title: ${d.title}): ${d.text}`] : []));
  let coverage =
    plan.trim().toLowerCase() === 'none'
      ? ''
      : `\n\nCover each of these readings in one or two sentences, each with its citations:\n${plan}`;
  return [c.instructions, ...demos, `${question}\n\n${docs.join('\n')}${coverage}\nAnswer:`].join('\n\n\n');
}

// internal helpers

// document numbers cited in the plan, as 0-based indexes in order of first mention
function citedIn(plan: string, nDocs: number): number[] {
  let seen: number[] = [];
  for (let m of plan.matchAll(/\[([\d,\s]+)\]/g)) {
    for (let n of m[1].split(',').map((x) => Number(x.trim()) - 1)) {
      if (n >= 0 && n < nDocs && !seen.includes(n)) seen.push(n);
    }
  }
  return seen;
}

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
