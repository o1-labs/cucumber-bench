// the review harness: a grounded answer over numbered passages, in three stages.
//   scan:    every passage is read on its own (in batches of SCAN_BATCH), and every part
//            that answers the question is quoted with its passage number. a quote that is
//            not in its passage is discarded. absence is the result of reading every passage
//   compose: the answer is written from the quotes only, in the benchmark's own form (its
//            instructions and worked examples), citing each quote's passage
//   check:   every cited sentence is verified against its cited passages only; a sentence
//            about the documents themselves is kept; an unsupported sentence is dropped
// nothing here is specific to a task: the question, the passages and the answer form all
// come from the case. the manifest names the suites this harness runs on.
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

const VERSION = '1';
// passages per scan call: 5 x 200 words keeps a call small and the call count at n/5
const SCAN_BATCH = 5;
// scan calls in flight at once
const SCAN_PARALLEL = 8;
// a cited sentence counts as a verified quotation when this many consecutive words of it are
// in its cited passages
const QUOTE_WORDS = 8;

// the question comes first, so its definition is read before the passages
const SCAN_PROMPT =
  'Below are a question and numbered passages from the documents. Read the question and any definition ' +
  'it gives, then read every passage on its own. Quote, word for word, every part of a passage that is ' +
  'itself what the question asks for, one quote per line, in the form [n] "quote" where n is the passage ' +
  'number. A provision that does what the question describes counts even when it uses other words. ' +
  'Do not quote definitions of terms, cross-references, or context that only relates to it. ' +
  'Quote only text that is in the passage. If nothing in a passage is what the question asks for, ' +
  'write nothing for that passage. If no passage has it, answer none.\n\n';

// a cited sentence: do its passages support it? an uncited one: is it about the documents?
const CHECK_CITED_PROMPT =
  'Below are passages and one claim. Do the passages state every fact in the claim, and contain ' +
  'every quoted part of the claim word for word? Answer with exactly one word: yes or no.\n\n';
const CHECK_UNCITED_PROMPT =
  'Below is one sentence from an answer. Is it a statement about the documents themselves, for example ' +
  'that they do or do not contain something, with no fact taken from the documents? ' +
  'Answer with exactly one word: keep or no.\n\n';

type Doc = { title: string; text: string };
type PublicCase = {
  id: string;
  suite: string;
  instructions: string;
  input: string;
  question?: string;
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
type Quote = { passage: number; text: string };

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
  let docs = c.docs ?? [];
  let question = questionOf(c);
  let { quotes, findings: scanFindings } = await scan(question, docs);
  let draft = await compose(question, quotes);
  let { output, findings: checkFindings, changed } = await check(draft, docs);
  let stages: Stage[] = [
    { name: 'input-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
    { name: 'agent', module: 'scan-compose', version: VERSION, mode: 'llm', findings: scanFindings, decision: 'pass' },
    {
      name: 'output-safety',
      module: 'citation-check',
      version: VERSION,
      mode: 'llm',
      findings: checkFindings,
      decision: changed ? 'modified' : 'pass',
    },
  ];
  respond({
    output,
    trace: { source: c.input, transformedSource: c.input, rawOutput: draft, releasedOutput: output, stages },
  });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the question is the part of the input before the passages; a case may name it directly
function questionOf(c: PublicCase): string {
  return (c.question ?? c.input.split(/\n\nDocument \[1\]/)[0]).trim();
}

// scan: every passage is read, in batches; every quote must be in its passage
async function scan(question: string, docs: Doc[]) {
  let batches: number[][] = [];
  for (let i = 0; i < docs.length; i += SCAN_BATCH) batches.push(docs.map((_, k) => k).slice(i, i + SCAN_BATCH));
  let quotes: Quote[] = [];
  let discarded = 0;
  await pool(batches, SCAN_PARALLEL, async (batch) => {
    let passages = batch.map((k) => `Document [${k + 1}](Title: ${docs[k].title}): ${docs[k].text}`).join('\n');
    let answer = await ask(guarded, `${SCAN_PROMPT}Question: ${question}\n\n${passages}\n\nQuotes:`, 0);
    for (let m of answer.matchAll(/^\s*\[(\d+)\]\s*"?(.+?)"?\s*$/gm)) {
      let k = Number(m[1]) - 1;
      if (!batch.includes(k)) continue;
      if (!contains(docs[k].text, m[2])) {
        discarded++;
        continue;
      }
      quotes.push({ passage: k, text: m[2].trim() });
    }
  });
  quotes.sort((a, b) => a.passage - b.passage);
  let findings = [
    `scanned ${docs.length} passages in ${batches.length} calls: ${quotes.length} quote(s) from ${[...new Set(quotes.map((q) => `[${q.passage + 1}]`))].join('') || 'no passage'}` +
      (discarded ? `, ${discarded} discarded (not in the passage)` : ''),
  ];
  return { quotes, findings };
}

// compose: the answer in the benchmark's form (its instructions and worked examples), from the
// quotes only. with no quotes, the examples show the form of a negative answer
async function compose(question: string, quotes: Quote[]): Promise<string> {
  let demos = (c.examples ?? []).map((ex) => `${ex.q}\nAnswer: ${ex.a}`);
  let findings = quotes.map((q) => `[${q.passage + 1}] "${q.text}"`).join('\n');
  let task =
    `Question: ${question}\n\nFindings, quoted word for word from the documents, after reading every passage:\n` +
    (findings || 'none: no passage contains anything that answers the question') +
    '\n\nWrite the answer from these findings only, in the form of the examples above. Quote every finding ' +
    'word for word, each in its own sentence, and put its number as [n] in the sentence that quotes it. Leave no ' +
    'finding out. Do not add facts that are not in the findings. With no findings, state that the documents do ' +
    'not contain what the question asks for, and cite nothing.\nAnswer:';
  return ask(guarded, [c.instructions, ...demos, task].join('\n\n\n'), 0);
}

// check: a cited sentence that quotes its passages is verified in code: a run of at least
// QUOTE_WORDS consecutive words of the sentence must be in its cited passages, word for word
// (quote marks are not paired: names in quotes, inner quotes and ellipses are common). a cited
// sentence without such a run is put to the model against its passages; an uncited one is put
// to the model as a statement about the documents. a sentence that passes is released as it
// is, the others are dropped
async function check(draft: string, docs: Doc[]) {
  let sents = sentences(draft);
  let verdicts = await Promise.all(
    sents.map(async (sent) => {
      let refs = numbersIn(sent, docs.length);
      let claim = removeCitations(sent);
      if (refs.length > 0 && longestRun(claim, refs.map((k) => docs[k].text).join('\n')) >= QUOTE_WORDS) {
        return { sent, refs, verdict: 'quoted' };
      }
      let prompt =
        refs.length > 0
          ? `${CHECK_CITED_PROMPT}${refs.map((k) => `Document [${k + 1}](Title: ${docs[k].title}): ${docs[k].text}`).join('\n')}\n\nClaim: ${claim}\n\nAnswer:`
          : `${CHECK_UNCITED_PROMPT}Sentence: ${claim}\n\nAnswer:`;
      let answer = await ask(guarded, prompt, 0);
      // the first verdict word anywhere in the answer, so "**Yes**." and "Yes, because" both count
      let verdict = answer.match(/\b(yes|keep|no)\b/i)?.[1].toLowerCase() ?? 'no';
      return { sent, refs, verdict };
    }),
  );
  let kept: string[] = [];
  let findings: string[] = [];
  for (let [i, { sent, refs, verdict }] of verdicts.entries()) {
    let cites = refs.map((k) => `[${k + 1}]`).join('');
    if (refs.length > 0 && verdict === 'quoted') {
      kept.push(sent);
      findings.push(`s${i + 1}: ${cites} quote verified`);
    } else if (refs.length > 0 && verdict === 'yes') {
      kept.push(sent);
      findings.push(`s${i + 1}: ${cites} supported`);
    } else if (refs.length === 0 && verdict === 'keep') {
      kept.push(sent);
      findings.push(`s${i + 1}: kept, a statement about the documents`);
    } else {
      findings.push(`s${i + 1}: ${cites || 'uncited'} dropped, ${refs.length > 0 ? 'not supported' : 'not about the documents'}`);
    }
  }
  let output = kept.join(' ');
  return { output, findings, changed: output !== draft };
}

// internal helpers

// the longest run of consecutive words of the claim that appears in the text, word for word
function longestRun(claim: string, text: string): number {
  let hay = normalize(text);
  let words = normalize(claim).split(' ');
  let best = 0;
  for (let i = 0; i < words.length; i++) {
    let j = i + best;
    while (j < words.length && hay.includes(words.slice(i, j + 1).join(' '))) j++;
    best = Math.max(best, j - i);
  }
  return best;
}

// letters and digits only, so "sole." matches "sole" and "(b)" matches "b" on both sides
function normalize(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// whitespace- and quote-insensitive containment, for quotes the model reformats slightly
function contains(text: string, quote: string): boolean {
  return normalize(text).includes(normalize(quote));
}

// a simple sentence splitter, the same rule the citation graders use
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function removeCitations(sent: string): string {
  return sent.replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
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

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
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
