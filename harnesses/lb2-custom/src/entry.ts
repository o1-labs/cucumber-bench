// lb2-custom for LongBench v2: evidence collected before the answer, and the answer checked.
// frame: one call with no document writes down what the question requires (its constraints) and
// the terms to look for. locate: the document is cut into
// chunks, ranked against the question, the choices and the terms, and the best ones selected;
// every chunk when there are few, so the scan is complete. extract: each selected chunk is scanned
// in its own call, with the constraints in view, for the passages that bear on the question and
// on each choice, quoted word for word and checked against the chunk with their offsets; the
// lines of the text that contain a framed term join them, found by the harness alone (the
// evidence ledger). answer: the baseline's one call with the ledger laid out in document order,
// quotes without the scan's tags, next to the whole document when the manifest asks for it and
// it fits the context, or from the ledger alone. every call's reply is in the trace; the scan's
// calls, tokens and cost are recorded apart from the answer call's. a second reading before or
// after the answer (a verify call, per-choice checks, a challenge, notes for and against each
// choice: versions 2 and 5 to 9) was measured and removed: the model keeps its first reading.
// protocol: stdin {publicCase, proxyUrl, token, models, options} -> stdout {output, trace} | {error}
import assert from 'node:assert/strict';
import { readInput, respond } from '../../lib.js';
import type { Stage, Trace } from '../../../src/types.js';
import { TOKENIZER_VERSION, loadTokenizer } from '../../lb2-direct/src/tokenizer.js';
import { chunkDocument, formatEvidence, mergeQuotes, parseQuotes, rankChunks, termHits, type Quote } from './evidence.js';
import { parseFrame } from './frame.js';

const VERSION = '10';
// the reference implementation's zero-shot prompt (prompts/0shot.txt of THUDM/LongBench at commit
// c5ea10bcd06285223c58dfed76bbc92d22273709, verbatim; copied from lb2-direct) with the evidence
// block after the text; the scan prompt is part of this version
const PROMPT_VERSION = '0shot.txt@c5ea10bcd06285223c58dfed76bbc92d22273709+custom/10';
const BASE_PROMPT =
  'Please read the following text and answer the question below.\n\n<text>\n$DOC$\n</text>\n\n' +
  'What is the correct answer to this question: $Q$\nChoices:\n(A) $C_A$\n(B) $C_B$\n(C) $C_C$\n(D) $C_D$\n\n' +
  'Format your response as follows: "The correct answer is (insert answer here)".';
const EVIDENCE_HEADER =
  'Passages collected from the text, in order of appearance. Answer with one of the four letters even when no choice is fully shown.';
const SCAN_PROMPT =
  'Quote every passage of this excerpt that bears on the question or on one of the choices, word for word, ' +
  'one passage per line. Start each line with the letter of the choice the passage supports or contradicts ' +
  'and + or - (for example "B+" or "D-"), or "?" when it bears on the question but on no single choice. ' +
  'Quote only what is in the excerpt. If nothing in the excerpt bears on the question or the choices, write None.\nEvidence:';
const FRAME_PROMPT =
  'Before reading the text, write down what the question requires. Two parts, one item per line:\n' +
  'Constraints: the conditions an answer must meet (who, when, according to which source, which part of the text).\n' +
  'Terms: the names, terms and numbers to look for in the text.\nFrame:';
// lines quoted per framed term, and the count above which a term is too common to be a lookup
const HITS_PER_TERM = 12;
const HIT_MAX_LINES = 40;
// scan calls in flight at once, and the output budget of one; the frame call's budget
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
  context: 'document+evidence' | 'evidence';
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
    name, module: 'lb2-custom', version: VERSION, policy: `context=${o.context}`, mode, findings, decision,
  });

  // the frame call shares the scan's settings and is counted with it
  let side = { calls: 0, attempts: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  let raws: string[] = [];
  let sideCall = async (name: string, prompt: string) => {
    let body: any = { model: models.main, messages: [{ role: 'user', content: prompt }], max_tokens: SCAN_OUTPUT_TOKENS };
    if (o.scanReasoning !== undefined) body.reasoning = o.scanReasoning;
    let reply = await callWithRetries(body);
    side.calls++;
    side.attempts += reply.attempts.length;
    side.promptTokens += reply.usage?.prompt_tokens ?? 0;
    side.completionTokens += reply.usage?.completion_tokens ?? 0;
    side.costUsd += Number(reply.usage?.cost ?? 0);
    raws.push(`--- ${name} ---\n${reply.content}`);
    return reply.content;
  };

  // frame: what the question requires, with no document in view
  let head = `Question: ${question}\nChoices:\n${choices}\n\n`;
  let frame = parseFrame(await sideCall('frame', `${head}${FRAME_PROMPT}`));
  let constraints = frame.constraints.length ? `What the question requires:\n${frame.constraints.map((x) => `- ${x}`).join('\n')}\n\n` : '';
  let findings = [
    `model ${models.main}; prompt ${PROMPT_VERSION}; tokenizer ${TOKENIZER_VERSION}`,
    `frame: ${frame.constraints.length} constraint(s), ${frame.terms.length} term(s)`,
  ];

  // locate: the chunks, and the ones to scan
  let doc = c.input.trim();
  let chunks = chunkDocument(tok, doc, o.chunkTokens);
  let docTokens = chunks.reduce((n, ch) => n + ch.tokens, 0);
  let selected = rankChunks(chunks, `${question}\n${choices}\n${frame.terms.join('\n')}`, o.topChunks);
  let complete = selected.length === chunks.length;
  findings.push(
    `document ${docTokens} tokens in ${chunks.length} chunk(s) of at most ${o.chunkTokens}`,
    `locate: ${selected.length} chunk(s) selected (${complete ? 'every chunk: the scan is complete' : `the best ${o.topChunks} by term score: the scan is partial`})` +
      (complete ? '' : `: ${selected.map((ch) => ch.index).join(', ')}`),
  );

  // extract: one call per selected chunk; the quotes are checked against their chunk and kept in document order
  let perChunk = new Map<number, { quotes: Quote[]; dropped: number; reply: string }>();
  await pool(selected, SCAN_PARALLEL, async (chunk) => {
    let prompt =
      `${head}${constraints}Excerpt ${chunk.index} of ${chunks.length} of the text:\n` +
      `<excerpt>\n${chunk.text}\n</excerpt>\n\n${SCAN_PROMPT}`;
    let reply = await sideCall(`scan chunk ${chunk.index}`, prompt);
    perChunk.set(chunk.index, { ...parseQuotes(reply, chunk, o.quotesPerChunk), reply });
  });
  let scanned = selected.flatMap((ch) => perChunk.get(ch.index)!.quotes);
  let dropped = selected.reduce((n, ch) => n + perChunk.get(ch.index)!.dropped, 0);
  findings.push(`extract: ${selected.length} call(s); ${scanned.length} quote(s) kept, ${dropped} dropped (not in the excerpt or no tag)`);

  // the lines holding a framed term, with no model: a lookup the scan may have passed over
  let terms = frame.terms.map((t) => t.replace(/\s*\([^)]*\)\s*$/, '').replace(/^["'“‘]+|["'”’]+$/g, '').trim()).filter(Boolean);
  let hits = termHits(doc, chunks, terms, HITS_PER_TERM, HIT_MAX_LINES);
  let quotes = mergeQuotes(scanned, hits.quotes);
  let evidence = formatEvidence(quotes, chunks.length);
  findings.push(
    `terms: ${terms.length} searched, ${hits.quotes.length} line group(s) found, ${hits.skipped.length} term(s) on more than ${HIT_MAX_LINES} lines skipped` +
      (hits.skipped.length ? ` (${hits.skipped.join('; ')})` : '') + `; ${quotes.length} passage(s) in the ledger after the merge`,
  );

  // answer: the document next to the evidence when the manifest asks for it and it fits, the evidence alone otherwise
  let withEvidence = BASE_PROMPT.replace('</text>\n\n', `</text>\n\n${EVIDENCE_HEADER}\n$EVIDENCE$\n\n`);
  let frameTokens = tok.encode(fill(withEvidence, '').replace('$EVIDENCE$', evidence)).length;
  let budget = o.contextTokens - o.outputTokens - OVERHEAD_TOKENS - frameTokens;
  let withDoc = o.context === 'document+evidence' && docTokens <= budget;
  let prompt = withDoc ? fill(withEvidence, doc).replace('$EVIDENCE$', evidence) : fill(BASE_PROMPT, `${EVIDENCE_HEADER}\n${evidence}`);

  findings.push(
    `answer context: ${withDoc ? 'document+evidence' : 'evidence'}${o.context === 'document+evidence' && !withDoc ? ' (the document does not fit)' : ''}; ` +
      `document ${docTokens} tokens, budget ${budget}`,
  );

  findings.push(
    `side usage: ${side.calls} call(s) in ${side.attempts} attempt(s); prompt ${side.promptTokens} tokens, completion ${side.completionTokens}, cost $${side.costUsd.toFixed(4)}; ` +
      `reasoning ${JSON.stringify(o.scanReasoning ?? null)}; max_tokens ${SCAN_OUTPUT_TOKENS}`,
  );
  let input = stage('input-safety', 'llm', withDoc ? 'pass' : 'modified', findings);
  let body: any = { model: models.main, messages: [{ role: 'user', content: prompt }], max_tokens: o.outputTokens };
  if (o.reasoning !== undefined) body.reasoning = o.reasoning;
  let final = await callWithRetries(body);
  raws.push(`--- answer ---\n${final.reasoning ? `<think>\n${final.reasoning}\n</think>\n` : ''}${final.content}`);
  let agent = stage('agent', 'llm', 'pass', [
    `max_tokens ${o.outputTokens}; reasoning ${JSON.stringify(o.reasoning ?? null)}; temperature: the benchmark default (proxy)`,
    `answer usage: prompt ${final.usage?.prompt_tokens ?? '?'} tokens, completion ${final.usage?.completion_tokens ?? '?'}` +
      (final.usage?.completion_tokens_details?.reasoning_tokens !== undefined ? `, reasoning ${final.usage.completion_tokens_details.reasoning_tokens}` : '') +
      `, cost $${Number(final.usage?.cost ?? 0).toFixed(4)}`,
    `finish_reason ${final.finishReason ?? '?'}${final.finishReason === 'length' ? ' (the output hit max_tokens: the answer may be cut off)' : ''}`,
    `attempts ${final.attempts.length}: ${final.attempts.join('; ')}`,
  ]);
  let trace: Trace = {
    source: '(the case input)',
    // the record keeps the tags: what the scan model judged, which the answer call never saw
    transformedSource: formatEvidence(quotes, chunks.length, true),
    rawOutput: raws.join('\n\n'),
    releasedOutput: final.content,
    stages: [input, agent, stage('output-safety', 'passthrough', 'pass')],
  };
  respond({ output: final.content, trace });
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
  assert(o.context === 'document+evidence' || o.context === 'evidence', `options.context must be document+evidence or evidence, got ${JSON.stringify(o.context)}`);
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
