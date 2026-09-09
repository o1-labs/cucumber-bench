// the plain baseline for LongBench v2: one model call with the whole document, the question and
// the four choices in the reference implementation's zero-shot prompt. no retrieval, no document
// transformation, no tools, no second call. the request is counted with the model's own tokenizer
// before the call: a document that does not fit the context is skipped (overflow: skip, the
// full-context lane) or cut in the middle until it fits (overflow: truncate_middle, the coverage
// lane), never silently. a transient request failure is retried a bounded number of times; a wrong
// or malformed answer is never retried. the manifest's options name the versions of this code, the
// prompt and the tokenizer, so a run record says exactly what produced it.
// protocol: stdin {publicCase, proxyUrl, token, models, options} -> stdout {output, trace} | {skipped, trace} | {error}
import assert from 'node:assert/strict';
import { readInput, respond } from '../../lib.js';
import type { Stage, Trace } from '../../../src/types.js';
import { TOKENIZER_VERSION, encodeChunked, loadTokenizer, truncateMiddle, type Tok } from './tokenizer.js';

const VERSION = '1';
// prompts/0shot.txt of https://github.com/THUDM/LongBench at this commit
// (sha256 68a162252bc9ff71d5d7abca3d69bb31aac3c35f832d657a2866f2018b8a6950), verbatim
const PROMPT_VERSION = '0shot.txt@c5ea10bcd06285223c58dfed76bbc92d22273709';
const PROMPT =
  'Please read the following text and answer the question below.\n\n<text>\n$DOC$\n</text>\n\n' +
  'What is the correct answer to this question: $Q$\nChoices:\n(A) $C_A$\n(B) $C_B$\n(C) $C_C$\n(D) $C_D$\n\n' +
  'Format your response as follows: "The correct answer is (insert answer here)".';
// tokens reserved for the chat template around the one message and the provider's own additions
const OVERHEAD_TOKENS = 64;
// a cut document is re-tokenized; the seam may cost a few tokens, so the cut aims this far under the budget
const SEAM_TOKENS = 8;
const RETRIES = 3;
const BACKOFF_MS = 2000;

type Options = {
  version: string;
  prompt: string;
  tokenizer: string;
  contextTokens: number;
  outputTokens: number;
  overflow: 'skip' | 'truncate_middle';
  reasoning?: unknown;
};

let { publicCase: c, proxyUrl, token, models, options } = await readInput();

try {
  let o = checkOptions(options);
  assert(c.question !== undefined && c.choices?.length === 4, `${c.id}: a longbench case needs a question and four choices`);
  let tok = loadTokenizer();

  // the prompt without the document has a fixed size; the rest of the context is the document's budget
  let fill = (doc: string) =>
    PROMPT.replace('$DOC$', doc)
      .replace('$Q$', c.question!.trim())
      .replace('$C_A$', c.choices![0].trim())
      .replace('$C_B$', c.choices![1].trim())
      .replace('$C_C$', c.choices![2].trim())
      .replace('$C_D$', c.choices![3].trim());
  let frameTokens = tok.encode(fill('')).length;
  let budget = o.contextTokens - o.outputTokens - OVERHEAD_TOKENS - frameTokens;
  assert(budget > 0, `no room for the document: context ${o.contextTokens} - output ${o.outputTokens} - overhead ${OVERHEAD_TOKENS + frameTokens}`);

  let doc = c.input.trim();
  let original = encodeChunked(tok, doc).length;
  let retained = original;
  let findings = [
    `model ${models.main}; prompt ${PROMPT_VERSION}; tokenizer ${TOKENIZER_VERSION}`,
    `document ${original} tokens; budget ${budget} (context ${o.contextTokens} - output ${o.outputTokens} - prompt ${frameTokens} - overhead ${OVERHEAD_TOKENS})`,
  ];
  let stage = (name: string, mode: Stage['mode'], decision: Stage['decision'], findings: string[] = []): Stage => ({
    name, module: 'lb2-direct', version: VERSION, policy: `overflow=${o.overflow}`, mode, findings, decision,
  });
  let trace = (rawOutput: string, releasedOutput: string, agentFindings: string[], input: Stage): Trace => ({
    // the case file holds the document; the record keeps it only when the model saw a cut version
    source: '(the case input)',
    transformedSource: retained === original ? '(the case input, unchanged)' : doc,
    rawOutput,
    releasedOutput,
    stages: [input, stage('agent', 'llm', 'pass', agentFindings), stage('output-safety', 'passthrough', 'pass')],
  });

  if (original > budget) {
    if (o.overflow === 'skip') {
      let reason = `context_overflow: ${original} document tokens, ${budget} fit`;
      respond({ skipped: reason, trace: trace('', '', [], stage('input-safety', 'passthrough', 'blocked', [...findings, reason])) });
      process.exit(0);
    }
    let cut = truncateMiddle(tok, doc, budget - SEAM_TOKENS);
    assert(cut.retained <= budget, `truncate_middle: ${cut.retained} tokens retained, ${budget} fit`);
    doc = cut.text;
    retained = cut.retained;
    findings.push(`truncate_middle: ${original} tokens cut to ${retained} (${((100 * retained) / original).toFixed(1)}% retained)`);
  }
  let input = stage('input-safety', retained === original ? 'passthrough' : 'regex', retained === original ? 'pass' : 'modified', findings);

  // the one call, with the effective generation settings recorded
  let body: any = { model: models.main, messages: [{ role: 'user', content: fill(doc) }], max_tokens: o.outputTokens };
  if (o.reasoning !== undefined) body.reasoning = o.reasoning;
  let { content, reasoning, finishReason, attempts, usage } = await callWithRetries(body);
  let agentFindings = [
    `max_tokens ${o.outputTokens}; reasoning ${JSON.stringify(o.reasoning ?? null)}; temperature: the benchmark default (proxy)`,
    `prompt ${usage?.prompt_tokens ?? '?'} tokens by the provider (${frameTokens + retained} by the tokenizer); completion ${usage?.completion_tokens ?? '?'}` +
      (usage?.completion_tokens_details?.reasoning_tokens !== undefined ? `, reasoning ${usage.completion_tokens_details.reasoning_tokens}` : ''),
    `finish_reason ${finishReason ?? '?'}${finishReason === 'length' ? ' (the output hit max_tokens: the answer may be cut off)' : ''}`,
    `attempts ${attempts.length}: ${attempts.join('; ')}`,
  ];
  let raw = reasoning ? `<think>\n${reasoning}\n</think>\n${content}` : content;
  respond({ output: content, trace: trace(raw, content, agentFindings, input) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the manifest's options: the versions must be the ones this code implements
function checkOptions(raw: { [key: string]: unknown }): Options {
  let o = raw as Options;
  assert(o.version === VERSION, `options.version ${JSON.stringify(o.version)} is not this harness's version ${VERSION}`);
  assert(o.prompt === PROMPT_VERSION, `options.prompt ${JSON.stringify(o.prompt)} is not the prompt this harness implements, ${PROMPT_VERSION}`);
  assert(o.tokenizer === TOKENIZER_VERSION, `options.tokenizer ${JSON.stringify(o.tokenizer)} is not the tokenizer this harness ships, ${TOKENIZER_VERSION}`);
  for (let k of ['contextTokens', 'outputTokens'] as const) {
    assert(Number.isInteger(o[k]) && o[k] > 0, `options.${k} must be a positive integer, got ${JSON.stringify(o[k])}`);
  }
  assert(o.overflow === 'skip' || o.overflow === 'truncate_middle', `options.overflow must be skip or truncate_middle, got ${JSON.stringify(o.overflow)}`);
  return o;
}

// the guarded route, with bounded retries on transient failures only: a network error, a rate
// limit, a timeout or an upstream error (the proxy reports those as 5xx). any other status is
// final. every attempt is counted by the proxy, and listed here with its outcome and time
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
