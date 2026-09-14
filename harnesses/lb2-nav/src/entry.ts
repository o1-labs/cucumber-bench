// the navigator for LongBench v2. the model reads the text with two commands, search (the lines
// containing some words, with line numbers) and read (a range of lines), one command per turn, in
// one conversation, until it answers or the step budget is spent; then it is asked to answer
// from what it has read. two contexts, chosen per case by the tokenizer: when the document fits
// the context it is given whole, in the baseline's prompt, and the commands are for checking
// passages, as many as the remaining room allows (none for the largest documents: then the call
// is the baseline's); when it does not fit, the model sees the head of the text and navigates,
// so any document length works: there is no overflow. the answer form is the baseline's, so the
// grader is the same. the trace keeps the whole transcript: what the model saw of the text, and
// every command with its result.
// the model's reasoning can loop until the output budget is spent and the content is empty; an
// empty reply is neither a command nor an answer, so the call is repeated once with reasoning off.
// protocol: stdin {publicCase, proxyUrl, token, models, options} -> stdout {output, trace} | {error}
import assert from 'node:assert/strict';
import { readInput, respond } from '../../lib.js';
import type { Stage, Trace } from '../../../src/types.js';
import { TOKENIZER_VERSION, encodeChunked, loadTokenizer } from '../../lb2-direct/src/tokenizer.js';
import { parseCommand, read, search } from './tools.js';

const VERSION = '2';
const PROMPT_VERSION = 'nav/2';
// the reference implementation's zero-shot prompt (prompts/0shot.txt of THUDM/LongBench at commit
// c5ea10bcd06285223c58dfed76bbc92d22273709, verbatim; copied from lb2-direct): the whole-text
// call, and the answer form in both contexts, so the grader reads the answer as the baseline's
const BASE_PROMPT =
  'Please read the following text and answer the question below.\n\n<text>\n$DOC$\n</text>\n\n' +
  'What is the correct answer to this question: $Q$\nChoices:\n(A) $C_A$\n(B) $C_B$\n(C) $C_C$\n(D) $C_D$\n\n' +
  'Format your response as follows: "The correct answer is (insert answer here)".';
const FORMAT = 'Format your response as follows: "The correct answer is (insert answer here)".';
const NEXT = 'Next command:';
// tokens reserved for the chat template and the model's own command lines over the whole conversation
const OVERHEAD_TOKENS = 4096;
const RETRIES = 3;
const BACKOFF_MS = 2000;

type Options = {
  version: string;
  prompt: string;
  tokenizer: string;
  contextTokens: number;
  outputTokens: number;
  reasoning?: unknown;
  maxSteps: number;
  searchHits: number;
  readTokens: number;
  headTokens: number;
};
type Message = { role: 'user' | 'assistant'; content: string };

let { publicCase: c, proxyUrl, token, models, options } = await readInput();

try {
  let o = checkOptions(options);
  assert(c.question !== undefined && c.choices?.length === 4, `${c.id}: a longbench case needs a question and four choices`);
  let tok = loadTokenizer();
  let count = (s: string) => tok.encode(s).length;

  // the document, as lines, and its size: whole when it fits the context with the frame
  let doc = c.input.trim();
  let lines = doc.split('\n');
  let docTokens = encodeChunked(tok, doc).length;
  let fill = (text: string) =>
    BASE_PROMPT.replace('$DOC$', text)
      .replace('$Q$', c.question!.trim())
      .replace('$C_A$', c.choices![0].trim())
      .replace('$C_B$', c.choices![1].trim())
      .replace('$C_C$', c.choices![2].trim())
      .replace('$C_D$', c.choices![3].trim());
  let commands =
    `search: <words>   every line of the text that contains the words (case-insensitive), up to ${o.searchHits} hits with line numbers\n` +
    `read: <from>-<to>   the lines from..to, at most ${o.readTokens} tokens per read\n`;
  let budget = o.contextTokens - o.outputTokens - OVERHEAD_TOKENS - count(fill(''));
  let whole = docTokens <= budget;
  // the commands that fit next to the whole text; none for the largest documents
  let limit = whole ? Math.min(o.maxSteps, Math.floor((budget - docTokens) / o.readTokens)) : o.maxSteps;
  let stage = (name: string, mode: Stage['mode'], decision: Stage['decision'], findings: string[] = []): Stage => ({
    name, module: 'lb2-nav', version: VERSION, policy: `context=${whole ? 'whole' : 'navigate'}`, mode, findings, decision,
  });
  let choices = c.choices.map((ch, i) => `(${'ABCD'[i]}) ${ch.trim()}`).join('\n');
  let first: (text: string) => string;
  let head = { lines: 0, text: '' };
  if (whole && limit === 0) {
    first = fill;
  } else if (whole) {
    first = (text) =>
      'You answer a question about a long text. The whole text is below. Before you answer, you can check passages with ' +
      `commands, one command as the last line of a message, at most ${limit} in all:\n${commands}` +
      'Check the passages your answer rests on, and every choice, against the text. When you have checked enough, reply ' +
      'with the answer alone, without a command.\n\n' + fill(text);
  } else {
    head = read(lines, 1, lines.length, count, o.headTokens);
    first = () =>
      'You answer a question about a long text. You cannot see the text whole: you read it with commands. ' +
      `Reply with one command as the last line of your message:\n${commands}` +
      'Search for the names, terms and numbers in the question and in each choice, read around the hits, and check every ' +
      `choice against the text before you answer. When you have read enough, reply with the answer alone, without a command. ${FORMAT}\n\n` +
      `What is the correct answer to this question: ${c.question!.trim()}\nChoices:\n${choices}\n\n` +
      `The text has ${lines.length} lines and ${docTokens} tokens. Lines 1-${head.lines}:\n${head.text}\n\n${NEXT}`;
  }
  let input = stage('input-safety', 'passthrough', 'pass', [
    `model ${models.main}; prompt ${PROMPT_VERSION}; tokenizer ${TOKENIZER_VERSION}`,
    `document ${lines.length} lines, ${docTokens} tokens; budget ${budget}; ` +
      (whole ? `context: whole, ${limit} command(s) fit` : `context: navigate; head: ${head.lines} line(s) of at most ${o.headTokens} tokens`),
  ]);

  // the loop: one command per turn, the result as the next user message
  let messages: Message[] = [{ role: 'user', content: first(doc) }];
  let log: string[] = [];
  let raws: string[] = [];
  let usage = { calls: 0, attempts: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  let seen = new Set<number>();
  let steps = 0, searches = 0, reads = 0, empties = 0;
  let forced = false, repeated = false;
  let content: string;
  let call = async (reasoning: unknown) => {
    let body: any = { model: models.main, messages, max_tokens: o.outputTokens };
    if (reasoning !== undefined) body.reasoning = reasoning;
    let reply = await callWithRetries(body);
    usage.calls++;
    usage.attempts += reply.attempts.length;
    usage.promptTokens += reply.usage?.prompt_tokens ?? 0;
    usage.completionTokens += reply.usage?.completion_tokens ?? 0;
    usage.reasoningTokens += reply.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    usage.costUsd += Number(reply.usage?.cost ?? 0);
    raws.push(reply.reasoning ? `<think>\n${reply.reasoning}\n</think>\n${reply.content}` : reply.content);
    return reply;
  };
  for (;;) {
    let reply = await call(o.reasoning);
    repeated = reply.content.trim() === '' && o.reasoning !== undefined;
    if (repeated) {
      empties++;
      log.push(`${steps + 1}: empty reply (finish_reason ${reply.finishReason ?? '?'}); repeated with reasoning off`);
      reply = await call({ enabled: false });
    }
    let cmd = parseCommand(reply.content);
    if (cmd === undefined || forced || limit === 0) {
      content = reply.content;
      break;
    }
    messages.push({ role: 'assistant', content: reply.content });
    steps++;
    let result: string;
    if (cmd.kind === 'search') {
      searches++;
      let r = search(lines, cmd.words, o.searchHits);
      log.push(`${steps}: search "${cmd.words}" -> ${r.total} line(s)`);
      result = r.text;
    } else {
      reads++;
      let r = read(lines, cmd.from, cmd.to, count, o.readTokens);
      for (let n = cmd.from; n < cmd.from + r.lines; n++) seen.add(n);
      log.push(`${steps}: read ${cmd.from}-${cmd.to} -> ${r.lines} line(s)`);
      result = r.text;
    }
    if (steps >= limit) {
      forced = true;
      result += `\n\nNo more commands. Answer now from what you have read.\n${FORMAT}`;
    } else {
      result += `\n\n${NEXT}`;
    }
    messages.push({ role: 'user', content: result });
  }

  let agent = stage('agent', 'llm', 'pass', [
    `max_tokens ${o.outputTokens}; reasoning ${JSON.stringify(o.reasoning ?? null)}; temperature: the benchmark default (proxy)`,
    ...log,
    `${steps} step(s): ${searches} search(es), ${reads} read(s); ${seen.size} distinct line(s) read (${((100 * seen.size) / lines.length).toFixed(1)}% of the text)` +
      (forced ? '; the answer was forced at the step limit' : '') + (empties ? `; ${empties} empty repl${empties === 1 ? 'y' : 'ies'} repeated with reasoning off` : '') +
      (repeated ? '; the answer came from a repeat' : ''),
    `usage: ${usage.calls} call(s) in ${usage.attempts} attempt(s); prompt ${usage.promptTokens} tokens, completion ${usage.completionTokens}, ` +
      `reasoning ${usage.reasoningTokens}, cost $${usage.costUsd.toFixed(4)}`,
  ]);
  let trace: Trace = {
    source: '(the case input)',
    // the case file holds the document; the record keeps the first message without it
    transformedSource: [`[user]\n${first('(the case input)')}`, ...messages.slice(1).map((m) => `[${m.role}]\n${m.content}`)].join('\n\n'),
    rawOutput: raws.map((r, i) => `--- call ${i + 1} ---\n${r}`).join('\n\n'),
    releasedOutput: content,
    stages: [input, agent, stage('output-safety', 'passthrough', 'pass')],
  };
  respond({ output: content, trace });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// the manifest's options: the versions must be the ones this code implements, and a navigated
// conversation must fit the context: the head, every read at its limit, and the answer
function checkOptions(raw: { [key: string]: unknown }): Options {
  let o = raw as Options;
  assert(o.version === VERSION, `options.version ${JSON.stringify(o.version)} is not this harness's version ${VERSION}`);
  assert(o.prompt === PROMPT_VERSION, `options.prompt ${JSON.stringify(o.prompt)} is not the prompt this harness implements, ${PROMPT_VERSION}`);
  assert(o.tokenizer === TOKENIZER_VERSION, `options.tokenizer ${JSON.stringify(o.tokenizer)} is not the tokenizer this harness ships, ${TOKENIZER_VERSION}`);
  for (let k of ['contextTokens', 'outputTokens', 'maxSteps', 'searchHits', 'readTokens', 'headTokens'] as const) {
    assert(Number.isInteger(o[k]) && o[k] > 0, `options.${k} must be a positive integer, got ${JSON.stringify(o[k])}`);
  }
  let need = o.headTokens + o.maxSteps * o.readTokens + o.outputTokens + OVERHEAD_TOKENS;
  assert(need <= o.contextTokens, `the conversation can reach ${need} tokens, over the context of ${o.contextTokens}`);
  return o;
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
