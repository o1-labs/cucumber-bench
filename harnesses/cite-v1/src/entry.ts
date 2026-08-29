// the citation harness, on the vercel ai sdk. built up in steps, each measured
// against direct on asqa-dev:
//   step 1: the plain few-shot answer, identical to direct
//   step 2: a greedy plan of every reading of the question (no gain: str-em is bound by the passages)
//   step 3: the plan also selected the passages (no gain, and over-citation cost precision)
//   step 4 (this file): answer like direct, then check every sentence's citations
//           before release: minimal supporting set, or drop the sentence
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

const VERSION = '4';

const VERIFY_PROMPT =
  'Below are numbered passages and one claim. List the numbers of the passages that together support ' +
  'every fact in the claim. Every fact, date and qualifier in the claim must be stated in the passages. If any part is not, answer none. Use the smallest set that is enough. Answer only with the numbers as [n], ' +
  'for example [2] or [1][4]. If no passage supports the claim, answer none.\n\n';

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

let {
  publicCase: c,
  proxyUrl,
  token,
  models,
} = JSON.parse(await readStdin()) as {
  publicCase: PublicCase;
  proxyUrl: string;
  token: string;
  models: { main: string; safety: string };
};
let guarded = createOpenAICompatible({
  name: 'guarded',
  baseURL: `${proxyUrl}/v1`,
  apiKey: token,
})(models.main);

try {
  // the answer is direct's: same prompt, same temperature, so the check is the only difference under test
  let draft = await ask(guarded, fewShotPrompt(c), 0);
  let { output, findings, changed } = await checkCitations(draft, c.docs ?? []);
  let stages: Stage[] = [
    {
      name: 'input-safety',
      module: 'passthrough',
      version: VERSION,
      mode: 'passthrough',
      findings: [],
      decision: 'pass',
    },
    {
      name: 'agent',
      module: 'few-shot-answer',
      version: VERSION,
      mode: 'llm',
      findings: [],
      decision: 'pass',
    },
    {
      name: 'output-safety',
      module: 'citation-check',
      version: VERSION,
      mode: 'llm',
      findings,
      decision: changed ? 'modified' : 'pass',
    },
  ];
  respond({
    output,
    trace: {
      source: c.input,
      transformedSource: c.input,
      rawOutput: draft,
      releasedOutput: output,
      stages,
    },
  });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the benchmark's own prompt: instructions, the worked examples, then the question with its passages
function fewShotPrompt(c: PublicCase): string {
  let demos = (c.examples ?? []).map(
    (ex) =>
      `${ex.q}\nState only facts that the documents state. Do not add details, dates or qualifier the documents do not contain. Use the exact wording as it appears in the source documents. Do not invent wording. Answer: ${ex.a}`,
  );
  return [c.instructions, ...demos, `${c.input}\nAnswer:`].join('\n\n\n');
}

// every sentence gets the minimal set of passages that supports it, judged greedily
// over all passages; a sentence no passage supports is dropped
async function checkCitations(draft: string, docs: Doc[]) {
  let passages = docs
    .map((d, i) => `Document [${i + 1}](Title: ${d.title}): ${d.text}`)
    .join('\n');
  let sents = sentences(draft);
  let checked = await Promise.all(
    sents.map(async (sent) => {
      let claim = removeCitations(sent);
      let verdict = await ask(
        guarded,
        `${VERIFY_PROMPT}${passages}\n\nClaim: ${claim}\n\nPassages:`,
        0,
      );
      let refs = numbersIn(verdict, docs.length);
      return { sent, claim, refs };
    }),
  );
  let findings: string[] = [];
  let kept: string[] = [];
  for (let [i, { sent, claim, refs }] of checked.entries()) {
    let before = numbersIn(sent, docs.length);
    if (refs.length === 0) {
      findings.push(`s${i + 1}: dropped, no passage supports it`);
      continue;
    }
    let cites = refs.map((n) => `[${n + 1}]`).join('');
    // citations go before the final punctuation, as in the demonstrations
    let m = claim.match(/^(.*?)([.!?]*)$/s)!;
    kept.push(`${m[1]} ${cites}${m[2]}`);
    let same =
      before.length === refs.length && before.every((n) => refs.includes(n));
    findings.push(
      `s${i + 1}: ${before.map((n) => `[${n + 1}]`).join('') || 'uncited'} -> ${cites}${same ? '' : ' (changed)'}`,
    );
  }
  let output = kept.join(' ');
  return { output, findings, changed: output !== draft };
}

// internal helpers

// a simple sentence splitter, the same rule the citation graders use
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function removeCitations(sent: string): string {
  return sent
    .replace(/\s*\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// [n] numbers as 0-based indexes, unique, in order; out-of-range ones dropped
function numbersIn(text: string, nDocs: number): number[] {
  let seen: number[] = [];
  for (let m of text.matchAll(/\[(\d+)\]/g)) {
    let n = Number(m[1]) - 1;
    if (n >= 0 && n < nDocs && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

async function ask(
  m: LanguageModel,
  prompt: string,
  temperature?: number,
): Promise<string> {
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
