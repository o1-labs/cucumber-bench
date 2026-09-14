// lb2-custom for LongBench v2: evidence collected before the answer. the document is cut into
// chunks (locate: the chunks are ranked against the question and the choices, and the best ones
// selected; every chunk when there are few, so the scan is complete), each selected chunk is
// scanned in its own call for the passages that bear on the question and on each choice, quoted
// word for word and checked against the chunk with their offsets (extract: the evidence ledger),
// and the answer is given in the baseline's one call with the ledger laid out in document order
// next to the whole document when it fits the context, or from the ledger alone when it does not
// (answer). the scan's calls, tokens and cost are recorded apart from the answer call's.
// protocol: stdin {publicCase, proxyUrl, token, models, options} -> stdout {output, trace} | {error}
import assert from 'node:assert/strict';
import { readInput, respond } from '../../lib.js';
import type { Stage, Trace } from '../../../src/types.js';
import { TOKENIZER_VERSION, loadTokenizer } from '../../lb2-direct/src/tokenizer.js';
import { chunkDocument, formatEvidence, parseQuotes, rankChunks, type Quote } from './evidence.js';

const VERSION = '1';
// the reference implementation's zero-shot prompt (prompts/0shot.txt of THUDM/LongBench at commit
// c5ea10bcd06285223c58dfed76bbc92d22273709, verbatim; copied from lb2-direct) with the evidence
// block after the text; the scan prompt is part of this version
const PROMPT_VERSION = '0shot.txt@c5ea10bcd06285223c58dfed76bbc92d22273709+custom/1';
const BASE_PROMPT =
  'Please read the following text and answer the question below.\n\n<text>\n$DOC$\n</text>\n\n' +
  'What is the correct answer to this question: $Q$\nChoices:\n(A) $C_A$\n(B) $C_B$\n(C) $C_C$\n(D) $C_D$\n\n' +
  'Format your response as follows: "The correct answer is (insert answer here)".';
const EVIDENCE_HEADER = 'Evidence collected from the text, in order of appearance:';
const SCAN_PROMPT =
  'Quote every passage of this excerpt that bears on the question or on one of the choices, word for word, ' +
  'one passage per line. Start each line with the letter of the choice the passage supports or contradicts ' +
  'and + or - (for example "B+" or "D-"), or "?" when it bears on the question but on no single choice. ' +
  'Quote only what is in the excerpt. If nothing in the excerpt bears on the question or the choices, write None.\nEvidence:';
// scan calls in flight at once, and the output budget of one
const SCAN_PARALLEL = 8;
const SCAN_OUTPUT_TOKENS = 4096;
// tokens reserved for the chat template around the one message and the provider's own additions
const OVERHEAD_TOKENS = 64;
const RETRIES = 3;
const BACKOFF_MS = 2000;

type Options = {
  version: string;
  prompt: string;
  tokenizer: string;
  contextTokens: number;
  outputTokens: number;
  reasoning?: unknown;
  chunkTokens: number;
  topChunks: number;
  quotesPerChunk: number;
  scanReasoning?: unknown;
};

let { publicCase: c, proxyUrl, token, models, options } = await readInput();

try {
  let o = checkOptions(options);
  assert(c.question !== undefined && c.choices?.length === 4, `${c.id}: a longbench case needs a question and four choices`);
  let tok = loadTokenizer();
  let question = c.question.trim();
  let choices = c.choices.map((ch, i) => `(${'ABCD'[i]}) ${ch.trim()}`).join('\n');
  let fill = (template: string, doc: string) =>
    template.replace('$DOC$', doc)
      .replace('$Q$', question)
      .replace('$C_A$', c.choices![0].trim())
      .replace('$C_B$', c.choices![1].trim())
      .replace('$C_C$', c.choices![2].trim())
      .replace('$C_D$', c.choices![3].trim());
  let stage = (name: string, mode: Stage['mode'], decision: Stage['decision'], findings: string[] = []): Stage => ({
    name, module: 'lb2-custom', version: VERSION, policy: `topChunks=${o.topChunks}`, mode, findings, decision,
  });

  // locate: the chunks, and the ones to scan
  let doc = c.input.trim();
  let chunks = chunkDocument(tok, doc, o.chunkTokens);
  let docTokens = chunks.reduce((n, ch) => n + ch.tokens, 0);
  let selected = rankChunks(chunks, `${question}\n${choices}`, o.topChunks);
  let complete = selected.length === chunks.length;
  let findings = [
    `model ${models.main}; prompt ${PROMPT_VERSION}; tokenizer ${TOKENIZER_VERSION}`,
    `document ${docTokens} tokens in ${chunks.length} chunk(s) of at most ${o.chunkTokens}`,
    `locate: ${selected.length} chunk(s) selected (${complete ? 'every chunk: the scan is complete' : `the best ${o.topChunks} by term score: the scan is partial`})` +
      (complete ? '' : `: ${selected.map((ch) => ch.index).join(', ')}`),
  ];

  // extract: one call per selected chunk; the quotes are checked against their chunk and kept in document order
  let perChunk = new Map<number, Quote[]>();
  let dropped = 0, scanAttempts = 0;
  let scan = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  await pool(selected, SCAN_PARALLEL, async (chunk) => {
    let prompt =
      `Question: ${question}\nChoices:\n${choices}\n\nExcerpt ${chunk.index} of ${chunks.length} of the text:\n` +
      `<excerpt>\n${chunk.text}\n</excerpt>\n\n${SCAN_PROMPT}`;
    let body: any = { model: models.main, messages: [{ role: 'user', content: prompt }], max_tokens: SCAN_OUTPUT_TOKENS };
    if (o.scanReasoning !== undefined) body.reasoning = o.scanReasoning;
    let reply = await callWithRetries(body);
    scanAttempts += reply.attempts.length;
    scan.promptTokens += reply.usage?.prompt_tokens ?? 0;
    scan.completionTokens += reply.usage?.completion_tokens ?? 0;
    scan.costUsd += Number(reply.usage?.cost ?? 0);
    let parsed = parseQuotes(reply.content, chunk, o.quotesPerChunk);
    perChunk.set(chunk.index, parsed.quotes);
    dropped += parsed.dropped;
  });
  let quotes = selected.flatMap((ch) => perChunk.get(ch.index)!);
  let evidence = formatEvidence(quotes, chunks.length);
  findings.push(
    `extract: ${selected.length} call(s) in ${scanAttempts} attempt(s); ${quotes.length} quote(s) kept, ${dropped} dropped (not in the excerpt or no tag); ` +
      `reasoning ${JSON.stringify(o.scanReasoning ?? null)}; max_tokens ${SCAN_OUTPUT_TOKENS}`,
    `extract usage: prompt ${scan.promptTokens} tokens, completion ${scan.completionTokens}, cost $${scan.costUsd.toFixed(4)}`,
  );

  // answer: the document next to the evidence when it fits, the evidence alone otherwise
  let withEvidence = BASE_PROMPT.replace('</text>\n\n', `</text>\n\n${EVIDENCE_HEADER}\n$EVIDENCE$\n\n`);
  let frameTokens = tok.encode(fill(withEvidence, '').replace('$EVIDENCE$', evidence)).length;
  let budget = o.contextTokens - o.outputTokens - OVERHEAD_TOKENS - frameTokens;
  let withDoc = docTokens <= budget;
  let prompt = withDoc ? fill(withEvidence, doc).replace('$EVIDENCE$', evidence) : fill(BASE_PROMPT, `${EVIDENCE_HEADER}\n${evidence}`);
  findings.push(`answer context: ${withDoc ? 'document+evidence' : 'evidence (the document does not fit)'}; document ${docTokens} tokens, budget ${budget}`);
  let input = stage('input-safety', 'llm', withDoc ? 'pass' : 'modified', findings);
  let body: any = { model: models.main, messages: [{ role: 'user', content: prompt }], max_tokens: o.outputTokens };
  if (o.reasoning !== undefined) body.reasoning = o.reasoning;
  let { content, reasoning, finishReason, attempts, usage } = await callWithRetries(body);
  let agent = stage('agent', 'llm', 'pass', [
    `max_tokens ${o.outputTokens}; reasoning ${JSON.stringify(o.reasoning ?? null)}; temperature: the benchmark default (proxy)`,
    `answer usage: prompt ${usage?.prompt_tokens ?? '?'} tokens, completion ${usage?.completion_tokens ?? '?'}` +
      (usage?.completion_tokens_details?.reasoning_tokens !== undefined ? `, reasoning ${usage.completion_tokens_details.reasoning_tokens}` : '') +
      `, cost $${Number(usage?.cost ?? 0).toFixed(4)}`,
    `finish_reason ${finishReason ?? '?'}${finishReason === 'length' ? ' (the output hit max_tokens: the answer may be cut off)' : ''}`,
    `attempts ${attempts.length}: ${attempts.join('; ')}`,
  ]);
  let trace: Trace = {
    source: '(the case input)',
    transformedSource: evidence,
    rawOutput: reasoning ? `<think>\n${reasoning}\n</think>\n${content}` : content,
    releasedOutput: content,
    stages: [input, agent, stage('output-safety', 'passthrough', 'pass')],
  };
  respond({ output: content, trace });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the manifest's options: the versions must be the ones this code implements
function checkOptions(raw: { [key: string]: unknown }): Options {
  let o = raw as Options;
  assert(o.version === VERSION, `options.version ${JSON.stringify(o.version)} is not this harness's version ${VERSION}`);
  assert(o.prompt === PROMPT_VERSION, `options.prompt ${JSON.stringify(o.prompt)} is not the prompt this harness implements, ${PROMPT_VERSION}`);
  assert(o.tokenizer === TOKENIZER_VERSION, `options.tokenizer ${JSON.stringify(o.tokenizer)} is not the tokenizer this harness ships, ${TOKENIZER_VERSION}`);
  for (let k of ['contextTokens', 'outputTokens', 'chunkTokens', 'topChunks', 'quotesPerChunk'] as const) {
    assert(Number.isInteger(o[k]) && o[k] > 0, `options.${k} must be a positive integer, got ${JSON.stringify(o[k])}`);
  }
  return o;
}

// runs fn over items with at most n in flight
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

// the guarded route, with bounded retries on transient failures only: a network error, a rate
// limit, a timeout or an upstream error (the proxy reports those as 5xx). any other status is
// final. every attempt is counted by the proxy, and listed here with its outcome and time.
// copied from lb2-direct
async function callWithRetries(body: unknown) {
  let attempts: string[] = [];
  for (let attempt = 1; ; attempt++) {
    let t0 = Date.now();
    let res: Response | undefined;
    let failure: string | undefined;
    try {
      res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      failure = `network error: ${String(err?.message ?? err)}`;
    }
    let secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (res?.ok) {
      let data: any = await res.json();
      let choice = data.choices?.[0];
      assert(choice?.message, `model reply has no message: ${JSON.stringify(data).slice(0, 300)}`);
      attempts.push(`${attempt}: ok in ${secs}s`);
      return {
        content: String(choice.message.content ?? ''),
        reasoning: choice.message.reasoning ? String(choice.message.reasoning) : undefined,
        finishReason: choice.finish_reason as string | undefined,
        attempts,
        usage: data.usage,
      };
    }
    if (res) failure = `${res.status} ${(await res.text()).slice(0, 200)}`;
    attempts.push(`${attempt}: ${failure} in ${secs}s`);
    let transient = !res || res.status === 408 || res.status === 429 || res.status >= 500;
    assert(transient && attempt <= RETRIES, `model call failed after ${attempts.length} attempt(s): ${attempts.join('; ')}`);
    await new Promise((r) => setTimeout(r, BACKOFF_MS * 2 ** (attempt - 1)));
  }
}
