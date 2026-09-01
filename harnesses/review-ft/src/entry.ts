// the review harness built around a finetuned extractor. the extractor was trained on
// (excerpt, question) -> verbatim quotes, one per line, or None. the harness gives it
// what it was trained for and adds what it does not produce:
//   scan:    consecutive passages are joined into excerpts of EXCERPT_PASSAGES; the
//            extractor quotes what answers the question; the harness locates every quote
//            in its passage and attaches the passage citation
//   compose: a general model writes the answer from the quotes only, in the benchmark's
//            form (its instructions and worked examples)
//   check:   every cited sentence is verified against its cited passages; an unsupported
//            sentence is dropped. the same rules as review-v1
// nothing here is specific to a task: the question, the passages and the answer form all
// come from the case; the models and their providers come from the manifest.
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { readInput, generateVia, respond, type Generate } from '../../lib.js';
import type { PublicCase, Stage } from '../../../src/types.js';

const VERSION = '1';
// consecutive passages per extractor call: 3 x 200 words is one excerpt
const EXCERPT_PASSAGES = 3;
// extractor calls in flight at once; a local server processes them in turn anyway
const SCAN_PARALLEL = 4;
// a cited sentence counts as a verified quotation when this many consecutive words of it are
// in its cited passages, and at most REST_WORDS other words stand around the quotation
const QUOTE_WORDS = 8;
const REST_WORDS = 12;

const CHECK_CITED_PROMPT =
  'Below are passages and one claim. Do the passages state every fact in the claim, and contain ' +
  'every quoted part of the claim word for word? Answer with exactly one word: yes or no.\n\n';
const CHECK_UNCITED_PROMPT =
  'Below is one sentence from an answer. Is it a statement about the documents themselves, for example ' +
  'that they do or do not contain something, with no fact taken from the documents? ' +
  'Answer with exactly one word: keep or no.\n\n';

type Doc = { title: string; text: string };
type Quote = { passage: number; text: string };

let { publicCase: c, proxyUrl, token, models } = await readInput();
let extractor = generateVia(proxyUrl, token, models.main);
let general = generateVia(proxyUrl, token, models.compose);

try {
  if (!models.compose) throw Error('review-ft needs models.compose in its manifest');
  let docs = c.docs ?? [];
  let question = questionOf(c);
  let { quotes, findings: scanFindings } = await scan(question, docs);
  let draft = await compose(question, quotes);
  let { output, findings: checkFindings, changed } = await check(draft, docs);
  let stages: Stage[] = [
    { name: 'input-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
    { name: 'agent', module: 'extractor-scan+compose', version: VERSION, mode: 'llm', findings: scanFindings, decision: 'pass' },
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

// scan: the extractor reads one excerpt per call and answers with verbatim quote lines or
// None. the harness finds each quote's passage; a quote in no passage is discarded
async function scan(question: string, docs: Doc[]) {
  let batches: number[][] = [];
  for (let i = 0; i < docs.length; i += EXCERPT_PASSAGES) batches.push(docs.map((_, k) => k).slice(i, i + EXCERPT_PASSAGES));
  let quotes: Quote[] = [];
  let discarded = 0;
  await pool(batches, SCAN_PARALLEL, async (batch) => {
    let excerpt = batch.map((k) => docs[k].text).join('\n');
    // question before excerpt: the extractor was trained in this order and misses
    // clauses in the other one (verified against the live model)
    let answer = await extractor(`${question}\n\nExcerpt:\n${excerpt}\n\nVerbatim quotes:`, 0);
    if (/^none\b/i.test(answer.trim())) return;
    for (let line of answer.split('\n')) {
      // a quote line, with any [n], bullet or numbering the extractor may add stripped
      let text = line.replace(/^\s*(?:\[\d+\]|[-*•]|\d+[.)])?\s*/, '').replace(/^"(.*)"$/s, '$1').trim();
      if (!text || /^none\b/i.test(text)) continue;
      let k = batch.find((k) => contains(docs[k].text, text));
      if (k === undefined) {
        discarded++;
        continue;
      }
      quotes.push({ passage: k, text });
    }
  });
  quotes.sort((a, b) => a.passage - b.passage);
  let findings = [
    `scanned ${docs.length} passages in ${batches.length} excerpts: ${quotes.length} quote(s) from ${[...new Set(quotes.map((q) => `[${q.passage + 1}]`))].join('') || 'no passage'}` +
      (discarded ? `, ${discarded} discarded (in no passage)` : ''),
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
    'not contain what the question asks for, and cite nothing.\n\nAnswer from the findings:';
  return general([c.instructions, ...demos, task].join('\n\n\n'), 0);
}

// check: a cited sentence that quotes its passages is verified in code (a run of QUOTE_WORDS
// consecutive words in its cited passages, at most REST_WORDS around it); any other cited
// sentence is put to the model against its passages; an uncited one is put to the model as a
// statement about the documents. a sentence that fails is dropped
async function check(draft: string, docs: Doc[]) {
  let sents = sentences(draft);
  let verdicts = await Promise.all(
    sents.map(async (sent) => {
      let refs = numbersIn(sent, docs.length);
      let claim = removeCitations(sent);
      let run = refs.length > 0 ? longestRun(claim, refs.map((k) => docs[k].text).join('\n')) : 0;
      if (run >= QUOTE_WORDS && normalize(claim).split(' ').length - run <= REST_WORDS) {
        return { sent, refs, verdict: 'quoted' };
      }
      let prompt =
        refs.length > 0
          ? `${CHECK_CITED_PROMPT}${refs.map((k) => `Document [${k + 1}](Title: ${docs[k].title}): ${docs[k].text}`).join('\n')}\n\nClaim: ${claim}\n\nSupported (yes or no):`
          : `${CHECK_UNCITED_PROMPT}Sentence: ${claim}\n\nAbout the documents (keep or no):`;
      let answer = await general(prompt, 0);
      let verdict = answer.match(/\b(yes|keep|no)\b/i)?.[1].toLowerCase() ?? 'no';
      return { sent, refs, verdict };
    }),
  );
  let kept: string[] = [];
  let findings: string[] = [];
  for (let [i, { sent, refs, verdict }] of verdicts.entries()) {
    let cites = refs.map((k) => `[${k + 1}]`).join('');
    if (refs.length > 0 && (verdict === 'quoted' || verdict === 'yes')) {
      kept.push(sent);
      findings.push(`s${i + 1}: ${cites} ${verdict === 'quoted' ? 'quote verified' : 'supported'}`);
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
