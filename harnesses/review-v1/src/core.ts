// Shared review pipeline. Full-scan and retrieval-assisted harnesses differ only in
// which original passage indexes they ask this module to review. Citations retain the
// original document numbers.

const VERSION = '1';
const SCAN_BATCH = 5;
const SCAN_PARALLEL = 8;
const QUOTE_WORDS = 8;
const REST_WORDS = 12;

const FULL_SCAN_PROMPT =
  'Below are a question and numbered passages from the documents. Read the question and any definition ' +
  'it gives, then read every passage on its own. Quote, word for word, every part of a passage that is ' +
  'itself what the question asks for, one quote per line, in the form [n] "quote" where n is the passage ' +
  'number. A provision that does what the question describes counts even when it uses other words. ' +
  'Do not quote definitions of terms, cross-references, or context that only relates to it. ' +
  'Quote only text that is in the passage. If nothing in a passage is what the question asks for, ' +
  'write nothing for that passage. If no passage has it, answer none.\n\n';
const SELECTED_SCAN_PROMPT =
  'Below are a question and numbered candidate passages retrieved from the documents. Read the question and any ' +
  'definition it gives, then read every provided passage on its own. Quote, word for word, every part of a passage ' +
  'that is itself what the question asks for, one quote per line, in the form [n] "quote" where n is the original ' +
  'passage number. A provision that does what the question describes counts even when it uses other words. ' +
  'Do not quote definitions of terms, cross-references, or context that only relates to it. Quote only text that ' +
  'is in the passage. If nothing in a passage is what the question asks for, write nothing for that passage. ' +
  'If no provided passage has it, answer none.\n\n';
const FALLBACK_SCAN_PROMPT =
  'Below are a question and numbered passages not included in the initial retrieval result. Read the question ' +
  'and any definition it gives, then read every provided passage on its own. Quote, word for word, every part ' +
  'of a passage that is itself what the question asks for, one quote per line, in the form [n] "quote" where n ' +
  'is the original passage number. A provision that does what the question describes counts even when it uses ' +
  'other words. Do not quote definitions of terms, cross-references, or context that only relates to it. Quote ' +
  'only text that is in the passage. If nothing in a passage is what the question asks for, write nothing for ' +
  'that passage. If no provided passage has it, answer none.\n\n';

const CHECK_CITED_PROMPT =
  'Below are passages and one claim. Do the passages state every fact in the claim, and contain ' +
  'every quoted part of the claim word for word? Answer with exactly one word: yes or no.\n\n';
const CHECK_UNCITED_PROMPT =
  'Below is one sentence from an answer. Is it a statement about the documents themselves, for example ' +
  'that they do or do not contain something, with no fact taken from the documents? ' +
  'Answer with exactly one word: keep or no.\n\n';

type Doc = { title: string; text: string };
type ReviewCase = {
  input: string;
  instructions: string;
  question?: string;
  docs?: Doc[];
  examples?: { q: string; a: string }[];
};
type Generate = (prompt: string, temperature?: number) => Promise<string>;
type Stage = {
  name: string;
  module: string;
  version: string;
  mode: 'passthrough' | 'regex' | 'llm' | 'hybrid';
  findings: string[];
  decision: 'pass' | 'modified' | 'blocked';
};
type ReviewSelection = { passageIndexes: number[]; finding: string };
type ReviewResult = {
  output: string;
  trace: {
    source: string;
    transformedSource: string;
    rawOutput: string;
    releasedOutput: string;
    stages: Stage[];
  };
};
type Quote = { passage: number; text: string };

export { questionOf, reviewAll, reviewSelected };
export type { Generate, ReviewCase, ReviewResult, ReviewSelection };

async function reviewAll(c: ReviewCase, generate: Generate): Promise<ReviewResult> {
  let docs = c.docs ?? [];
  return review(c, generate, docs.map((_, index) => index), true, []);
}

async function reviewSelected(
  c: ReviewCase,
  generate: Generate,
  selection: ReviewSelection,
): Promise<ReviewResult> {
  let docs = c.docs ?? [];
  validateSelection(selection.passageIndexes, docs.length);
  return review(c, generate, selection.passageIndexes, false, [selection.finding]);
}

async function review(
  c: ReviewCase,
  generate: Generate,
  passageIndexes: number[],
  exhaustive: boolean,
  selectionFindings: string[],
): Promise<ReviewResult> {
  let docs = c.docs ?? [];
  let question = questionOf(c);
  let firstScan = await scan(question, docs, passageIndexes, exhaustive ? 'all' : 'retrieved', generate);
  let quotes = firstScan.quotes;
  let scanFindings = firstScan.findings;
  let evidenceIsExhaustive = exhaustive;
  if (!exhaustive && quotes.length === 0) {
    let selected = new Set(passageIndexes);
    let remaining = docs.map((_, index) => index).filter((index) => !selected.has(index));
    if (remaining.length > 0) {
      let fallback = await scan(question, docs, remaining, 'fallback', generate);
      quotes = fallback.quotes;
      scanFindings.push(
        `retrieval produced no verified quote; scanned all ${remaining.length} remaining passages before composing`,
        ...fallback.findings,
      );
    }
    evidenceIsExhaustive = true;
  }
  let draft = await compose(c, question, quotes, evidenceIsExhaustive, generate);
  let { output, findings: checkFindings, changed } = await check(draft, docs, generate);
  let stages: Stage[] = [
    { name: 'input-safety', module: 'passthrough', version: VERSION, mode: 'passthrough', findings: [], decision: 'pass' },
    {
      name: 'agent',
      module: exhaustive ? 'scan-compose' : 'retrieve-scan-compose',
      version: VERSION,
      mode: exhaustive ? 'llm' : 'hybrid',
      findings: [...selectionFindings, ...scanFindings],
      decision: 'pass',
    },
    {
      name: 'output-safety',
      module: 'citation-check',
      version: VERSION,
      mode: 'llm',
      findings: checkFindings,
      decision: changed ? 'modified' : 'pass',
    },
  ];
  return {
    output,
    trace: { source: c.input, transformedSource: c.input, rawOutput: draft, releasedOutput: output, stages },
  };
}

function questionOf(c: ReviewCase): string {
  return (c.question ?? c.input.split(/\n\nDocument \[1\]/)[0]).trim();
}

async function scan(
  question: string,
  docs: Doc[],
  passageIndexes: number[],
  scope: 'all' | 'retrieved' | 'fallback',
  generate: Generate,
) {
  let batches: number[][] = [];
  for (let i = 0; i < passageIndexes.length; i += SCAN_BATCH) batches.push(passageIndexes.slice(i, i + SCAN_BATCH));
  let quotes: Quote[] = [];
  let discarded = 0;
  await pool(batches, SCAN_PARALLEL, async (batch) => {
    let passages = batch.map((index) => `Document [${index + 1}](Title: ${docs[index].title}): ${docs[index].text}`).join('\n');
    let prompt = scope === 'all'
      ? FULL_SCAN_PROMPT
      : scope === 'retrieved' ? SELECTED_SCAN_PROMPT : FALLBACK_SCAN_PROMPT;
    let answer = await generate(`${prompt}Question: ${question}\n\n${passages}\n\nQuotes:`, 0);
    for (let match of answer.matchAll(/^\s*\[(\d+)\]\s*"?(.+?)"?\s*$/gm)) {
      let index = Number(match[1]) - 1;
      if (!batch.includes(index)) continue;
      if (!contains(docs[index].text, match[2])) {
        discarded++;
        continue;
      }
      quotes.push({ passage: index, text: match[2].trim() });
    }
  });
  quotes.sort((a, b) => a.passage - b.passage);
  let source = scope === 'all'
    ? `${docs.length} passages`
    : `${passageIndexes.length} ${scope === 'retrieved' ? 'retrieved' : 'fallback'} passages`;
  let findings = [
    `scanned ${source} in ${batches.length} calls: ${quotes.length} quote(s) from ${[...new Set(quotes.map((quote) => `[${quote.passage + 1}]`))].join('') || 'no passage'}` +
      (discarded ? `, ${discarded} discarded (not in the passage)` : ''),
  ];
  return { quotes, findings };
}

async function compose(
  c: ReviewCase,
  question: string,
  quotes: Quote[],
  exhaustive: boolean,
  generate: Generate,
): Promise<string> {
  let demos = (c.examples ?? []).map((example) => `${example.q}\nAnswer: ${example.a}`);
  let findings = quotes.map((quote) => `[${quote.passage + 1}] "${quote.text}"`).join('\n');
  let source = exhaustive ? 'after reading every passage' : 'after reviewing the retrieved candidate passages';
  let empty = exhaustive
    ? 'none: no passage contains anything that answers the question'
    : 'none: no retrieved passage contains anything that answers the question';
  let negative = exhaustive
    ? 'With no findings, state that the documents do not contain what the question asks for, and cite nothing.'
    : 'With no findings, state only that no supporting clause was found in the retrieved passages, and cite nothing.';
  let task =
    `Question: ${question}\n\nFindings, quoted word for word from the documents, ${source}:\n` +
    (findings || empty) +
    '\n\nWrite the answer from these findings only, in the form of the examples above. Quote every finding ' +
    'word for word, each in its own sentence, and put its number as [n] in the sentence that quotes it. Leave no ' +
    `finding out. Do not add facts that are not in the findings. ${negative}\n\nAnswer from the findings:`;
  return generate([c.instructions, ...demos, task].join('\n\n\n'), 0);
}

async function check(draft: string, docs: Doc[], generate: Generate) {
  let sents = sentences(draft);
  let verdicts = await Promise.all(
    sents.map(async (sent) => {
      let refs = numbersIn(sent, docs.length);
      let claim = removeCitations(sent);
      let run = refs.length > 0 ? longestRun(claim, refs.map((index) => docs[index].text).join('\n')) : 0;
      if (run >= QUOTE_WORDS && normalize(claim).split(' ').length - run <= REST_WORDS) {
        return { sent, refs, verdict: 'quoted' };
      }
      let prompt =
        refs.length > 0
          ? `${CHECK_CITED_PROMPT}${refs.map((index) => `Document [${index + 1}](Title: ${docs[index].title}): ${docs[index].text}`).join('\n')}\n\nClaim: ${claim}\n\nSupported (yes or no):`
          : `${CHECK_UNCITED_PROMPT}Sentence: ${claim}\n\nAbout the documents (keep or no):`;
      let answer = await generate(prompt, 0);
      let verdict = answer.match(/\b(yes|keep|no)\b/i)?.[1].toLowerCase() ?? 'no';
      return { sent, refs, verdict };
    }),
  );
  let kept: string[] = [];
  let findings: string[] = [];
  for (let [index, { sent, refs, verdict }] of verdicts.entries()) {
    let cites = refs.map((ref) => `[${ref + 1}]`).join('');
    if (refs.length > 0 && verdict === 'quoted') {
      kept.push(sent);
      findings.push(`s${index + 1}: ${cites} quote verified`);
    } else if (refs.length > 0 && verdict === 'yes') {
      kept.push(sent);
      findings.push(`s${index + 1}: ${cites} supported`);
    } else if (refs.length === 0 && verdict === 'keep') {
      kept.push(sent);
      findings.push(`s${index + 1}: kept, a statement about the documents`);
    } else {
      findings.push(
        `s${index + 1}: ${cites || 'uncited'} dropped, ${refs.length > 0 ? 'not supported' : 'not about the documents'}`,
      );
    }
  }
  let output = kept.join(' ');
  return { output, findings, changed: output !== draft };
}

function validateSelection(indexes: number[], count: number) {
  if (indexes.length === 0) throw Error('review selection needs at least one passage');
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw Error('review selection contains an out-of-range passage index');
  }
  if (new Set(indexes).size !== indexes.length) throw Error('review selection contains duplicate passage indexes');
  if (indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    throw Error('review selection must be in document order');
  }
}

function longestRun(claim: string, text: string): number {
  let haystack = normalize(text);
  let words = normalize(claim).split(' ');
  let best = 0;
  for (let start = 0; start < words.length; start++) {
    let end = start + best;
    while (end < words.length && haystack.includes(words.slice(start, end + 1).join(' '))) end++;
    best = Math.max(best, end - start);
  }
  return best;
}

function normalize(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function contains(text: string, quote: string): boolean {
  return normalize(text).includes(normalize(quote));
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function removeCitations(sentence: string): string {
  return sentence.replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
}

function numbersIn(text: string, count: number): number[] {
  let seen: number[] = [];
  for (let match of text.matchAll(/\[(\d+)\]/g)) {
    let index = Number(match[1]) - 1;
    if (index >= 0 && index < count && !seen.includes(index)) seen.push(index);
  }
  return seen;
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
