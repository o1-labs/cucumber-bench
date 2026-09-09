import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mockUpstream, models, tsx, type Mock } from './upstream.js';
import { containerName, sandboxedSystem } from '../src/sandbox.js';
import { loadCases } from '../src/caseStore.js';
import type { ModelProxy, PublicCase } from '../src/types.js';

let mock: Mock;
let seen: any[];
let proxy: ModelProxy;
beforeAll(async () => {
  mock = await mockUpstream();
  ({ seen, proxy } = mock);
});
afterAll(() => mock.close());

describe('sandboxedSystem', () => {
  it('should give two systems on the same case and repetition different container names', () => {
    let a = containerName('2026-08-30T10-00-00-000Z', 'direct', 'cuad-000', 1);
    let b = containerName('2026-08-30T10-00-00-000Z', 'review-v1', 'cuad-000', 1);
    assert.notEqual(a, b);
    assert.match(a, /^[a-zA-Z0-9_.-]+$/);
  });

  it('should run the direct baseline entry: one few-shot call, the raw input reaches the model', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let system = sandboxedSystem('direct', tsx('harnesses/direct/src/entry.ts'), models);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.output, 'Yes');
    assert.equal(result.modelCalls, 1);
    assert.equal(result.trace, undefined);
    assert.ok(result.modelRequests![0].includes(pub.input));
    assert.ok(result.modelRequests![0].includes('A:'));
  });

  it('should run the placeholder entry as a child process end to end', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let system = sandboxedSystem('sandboxed', tsx('harnesses/placeholder/src/entry.ts'), models);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.output, 'Yes');
    assert.equal(result.error, undefined);
    // two chain steps, accounted by the proxy, not self-reported
    assert.equal(result.modelCalls, 2);
    assert.equal(result.tokensIn, 100);
    assert.equal(result.modelRequests?.length, 2);
    // the sandbox got the proxy, not the upstream: it sent our bearer token
    assert.equal(seen[seen.length - 1].model, 'test-model');
    // legalbench has no safety policy: both safety stages are recorded as passthrough
    assert.deepEqual(result.trace?.stages.map((s) => `${s.name}:${s.mode}:${s.decision}`), [
      'input-safety:passthrough:pass', 'agent:llm:pass', 'output-safety:passthrough:pass',
    ]);
  });

  it('should scrub regex-detectable pii before the model on redaction cases', async () => {
    let { pub } = (await loadCases('benchmarks/redaction')).find((c) => c.pub.id === 'pii-40790C')!;
    let system = sandboxedSystem('sandboxed', tsx('harnesses/placeholder/src/entry.ts'), models);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    let input = result.trace!.stages[0];
    assert.equal(input.mode, 'regex');
    assert.equal(input.decision, 'modified');
    assert.ok(input.findings.some((f) => f.startsWith('email:K@tutanota.com')));
    // what reached the model no longer contains the email
    assert.ok(!result.modelRequests![0].includes('K@tutanota.com'));
    assert.ok(result.modelRequests![0].includes('[REDACTED]'));
  });

  it('should not pass the parent environment to the child', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    process.env.BENCH_API_KEY = 'sentinel-key';
    // the child reports every BENCH_* variable it sees (the os may add a few of its own)
    let probe = 'process.stdout.write(JSON.stringify({ output: Object.keys(process.env).filter((k) => k.startsWith("BENCH_")).join(",") }))';
    let result = await sandboxedSystem('probe', [process.execPath, '-e', probe], models).run(pub, { runId: 't', repetition: 1, proxy });
    delete process.env.BENCH_API_KEY;
    assert.equal(result.output, '');
  });

  it('should forward the manifest options on stdin, and {} without any', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    // the child answers with the options it was given
    let echo = 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({ output: JSON.stringify(JSON.parse(s).options) })))';
    let argv = [process.execPath, '-e', echo];
    let ctx = { runId: 't', repetition: 1, proxy };
    let withOptions = sandboxedSystem('probe', argv, models, undefined, undefined, undefined, { contextTokens: 250000 });
    assert.equal((await withOptions.run(pub, ctx)).output, '{"contextTokens":250000}');
    assert.deepEqual(withOptions.options, { contextTokens: 250000 });
    assert.equal((await sandboxedSystem('probe', argv, models).run(pub, ctx)).output, '{}');
  });

  it('should pass a skipped case through with its reason and trace, not as an error', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let decline = 'process.stdout.write(JSON.stringify({ skipped: "context_overflow: 300 tokens > 200", trace: { stages: [] } }))';
    let result = await sandboxedSystem('probe', [process.execPath, '-e', decline], models).run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.skipped, 'context_overflow: 300 tokens > 200');
    assert.equal(result.output, '');
    assert.deepEqual(result.trace, { stages: [] });
  });

  it('should report a sandbox that dies as an errored run', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let system = sandboxedSystem('sandboxed', [process.execPath, '-e', 'process.exit(3)'], models);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.match(result.error ?? '', /exited 3/);
  });
});

describe('legal-v1 (vercel ai sdk harness)', () => {
  let argv = tsx('harnesses/legal-v1/src/entry.ts');

  it('should run a label case through the guarded model with passthrough safety', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let result = await sandboxedSystem('legal-v1', argv, models).run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'Yes');
    assert.equal(result.modelCalls, 2);
    assert.deepEqual(result.trace?.stages.map((s) => s.mode), ['passthrough', 'llm', 'passthrough']);
  });

  it('should scrub regex hits and safety-model findings before the guarded model sees the document', async () => {
    let { pub } = (await loadCases('benchmarks/redaction')).find((c) => c.pub.id === 'pii-40805A')!;
    let result = await sandboxedSystem('legal-v1', argv, models).run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    let input = result.trace!.stages[0];
    assert.equal(input.mode, 'hybrid');
    assert.ok(input.findings.includes('llm:Heder') && input.findings.includes('llm:Sanavi'), input.findings.join(','));
    // three calls: detect (safety route), agent (guarded), detect on output (safety route)
    assert.equal(result.modelCalls, 3);
    // only the agent call is leakage ground truth, and the names never reached it
    assert.equal(result.modelRequests!.length, 1);
    assert.ok(!result.modelRequests![0].includes('Sanavi'));
    assert.ok(result.modelRequests![0].includes('[REDACTED]'));
  });
});

describe('cite-v1 (citation harness)', () => {
  it('step 4: should answer like direct, then rewrite each sentence with its minimal supporting set or drop it', async () => {
    let { pub } = (await loadCases('benchmarks/asqa')).find((c) => c.pub.id === 'asqa-000')!;
    let direct = await sandboxedSystem('direct', tsx('harnesses/direct/src/entry.ts'), models).run(pub, { runId: 't', repetition: 1, proxy });
    let system = sandboxedSystem('cite-v1', tsx('harnesses/cite-v1/src/entry.ts'), models);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    // one answer call plus one greedy check per sentence
    assert.equal(result.modelCalls, 4);
    let [answerPrompt, ...checks] = result.modelRequests!;
    // direct's prompt, plus the fact rules before every "Answer:": the demonstrations and the question
    let lines = answerPrompt.split('\n');
    let rules = lines.filter((l) => l.startsWith('State only facts'));
    assert.equal(rules.length, pub.examples!.length + 1);
    assert.equal(lines.filter((l) => !rules.includes(l)).join('\n'), direct.modelRequests![0]);
    assert.ok(answerPrompt.endsWith(`${rules[0]}\nAnswer:`));
    assert.ok(checks.every((p) => p.includes('Document [20]') && p.includes('Claim: ')));
    assert.ok(seen.slice(-3).every((r) => r.temperature === 0));
    // sentence 1 keeps the minimal set the check returned; sentence 2 is dropped;
    // sentence 3 speaks about the documents and is kept without citation
    assert.equal(result.output, 'Alpha holds the record [2][7]. The documents do not say who holds the gamma record.');
    let check = result.trace!.stages[2];
    assert.equal(check.module, 'citation-check');
    assert.equal(check.decision, 'modified');
    assert.deepEqual(check.findings, [
      's1: [1][2][3] -> [2][7] (changed)',
      's2: dropped, no passage supports it',
      's3: kept without citation, a statement about the documents',
    ]);
    assert.equal(result.trace!.rawOutput, 'Alpha holds the record [1][2][3]. Beta is unsupported [4]. The documents do not say who holds the gamma record.');
  });
});

describe('review-ft (finetuned extractor review harness)', () => {
  it('should scan excerpts with the extractor, attach citations, then compose and check with the general model', async () => {
    let { pub } = (await loadCases('benchmarks/cuad')).find((c) => c.pub.id === 'cuad-000')!;
    let n = pub.docs!.length, batches = Math.ceil(n / 3);
    let system = sandboxedSystem('review-ft', tsx('harnesses/review-ft/src/entry.ts'), { ...models, main: 'extractor', compose: 'composer' }, undefined, 12);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.modelCalls, batches + 2);
    // the extractor scanned every excerpt; the general model composed and checked the uncited "Yes."
    let calls = seen.slice(-(batches + 2));
    assert.equal(calls.filter((r) => r.model === 'extractor').length, batches);
    assert.equal(calls.filter((r) => r.model === 'composer').length, 2);
    // the extractor answered a bare quote; the harness located it in passage 2 and cited it
    let quote = '(b) Rogers reserves the right, in its sole';
    assert.equal(result.output, `The contract contains the clause: "${quote}" [2].`);
    let [, agent, check] = result.trace!.stages;
    assert.equal(agent.module, 'extractor-scan+compose');
    assert.deepEqual(agent.findings, [`scanned ${n} passages in ${batches} excerpts: 1 quote(s) from [2]`]);
    assert.equal(check.decision, 'modified');
  });
});

describe('review-v1 (review harness)', () => {
  it('should scan every passage in batches, compose from the quotes, and check each cited sentence', async () => {
    let { pub } = (await loadCases('benchmarks/cuad')).find((c) => c.pub.id === 'cuad-000')!;
    let n = pub.docs!.length, batches = Math.ceil(n / 5);
    // the manifest's own call limit: the scan calls + compose + one check are over the test proxy's 4;
    // the quoted sentence is verified in code, so only the uncited "Yes." goes to the model
    let system = sandboxedSystem('review-v1', tsx('harnesses/review-v1/src/entry.ts'), models, undefined, 10);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.modelCalls, batches + 2);
    assert.ok(seen.slice(-(batches + 2)).every((r) => r.temperature === 0));
    let quote = pub.docs![1].text.split(' ').slice(0, 8).join(' ');
    // the composed draft is two sentences; the uncited "Yes." is dropped by the check
    assert.equal(result.trace!.rawOutput, `Yes. The contract contains the clause: "${quote}" [2].`);
    assert.equal(result.output, `The contract contains the clause: "${quote}" [2].`);
    let [, agent, check] = result.trace!.stages;
    assert.equal(agent.module, 'scan-compose');
    assert.deepEqual(agent.findings, [`scanned ${n} passages in ${batches} calls: 1 quote(s) from [2]`]);
    assert.equal(check.module, 'citation-check');
    assert.deepEqual(check.findings, ['s1: uncited dropped, not about the documents', 's2: [2] quote verified']);
    assert.equal(check.decision, 'modified');
  });
});

// the tokenizer files are downloaded, not in git (harnesses/lb2-direct/fetch-tokenizer.ts)
describe.skipIf(!existsSync('harnesses/lb2-direct/tokenizer/tokenizer.json'))('lb2-direct (longbench v2 baseline)', () => {
  let argv = tsx('harnesses/lb2-direct/src/entry.ts');
  let options = JSON.parse(readFileSync('harnesses/lb2-direct/harness.json', 'utf8')).options;
  // about 600 tokens: HEAD, 300 words, MIDDLE, 300 words, TAIL. the mock answers the letter named in the question
  let pub: PublicCase = {
    id: 'lb-1', suite: 'longbench-v2-dev', task: 'longbench-v2', instructions: 'Please read the following text and answer the question below.',
    input: `HEAD ${'word '.repeat(300)}MIDDLE ${'word '.repeat(300)}TAIL`, question: 'Which one? MOCK_ANSWER_C', choices: ['alpha', 'beta', 'gamma', 'delta'],
  };
  let run = (over: { [k: string]: unknown }, p: ModelProxy = proxy) =>
    sandboxedSystem('lb2-direct', argv, models, undefined, undefined, undefined, { ...options, ...over }).run(pub, { runId: 't', repetition: 1, proxy: p });

  it('should make one call in the reference prompt layout with the generation settings, and keep the answer raw', async () => {
    let result = await run({});
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'The correct answer is (C)');
    assert.equal(result.modelCalls, 1);
    let prompt = result.modelRequests![0];
    assert.ok(prompt.startsWith('Please read the following text and answer the question below.\n\n<text>\nHEAD word'));
    assert.ok(prompt.includes('MIDDLE'));
    assert.ok(
      prompt.endsWith(
        'TAIL\n</text>\n\nWhat is the correct answer to this question: Which one? MOCK_ANSWER_C\nChoices:\n(A) alpha\n(B) beta\n(C) gamma\n(D) delta\n\n' +
          'Format your response as follows: "The correct answer is (insert answer here)".',
      ),
    );
    let body = seen[seen.length - 1];
    assert.equal(body.max_tokens, options.outputTokens);
    assert.deepEqual(body.reasoning, options.reasoning);
    assert.equal(body.messages.length, 1);
    let [input, agent] = result.trace!.stages;
    assert.equal(input.decision, 'pass');
    assert.match(input.findings[1], /^document \d+ tokens; budget \d+ /);
    assert.match(agent.findings.join('\n'), /attempts 1: 1: ok in \ds/);
    assert.equal(result.trace!.transformedSource, '(the case input, unchanged)');
  });

  it('should skip a document beyond the context limit as context_overflow, with the counts, and call no model', async () => {
    let calls = seen.length;
    let result = await run({ contextTokens: 400, outputTokens: 100 });
    assert.equal(result.error, undefined);
    assert.match(result.skipped!, /^context_overflow: \d+ document tokens, \d+ fit$/);
    assert.equal(result.modelCalls, 0);
    assert.equal(seen.length, calls);
    assert.equal(result.trace!.stages[0].decision, 'blocked');
  });

  it('should cut the middle of the document with truncate_middle and record the original and retained counts', async () => {
    let result = await run({ contextTokens: 400, outputTokens: 100, overflow: 'truncate_middle' });
    assert.equal(result.error, undefined);
    let prompt = result.modelRequests![0];
    assert.ok(prompt.includes('<text>\nHEAD word') && prompt.includes('word TAIL\n</text>') && !prompt.includes('MIDDLE'));
    let input = result.trace!.stages[0];
    assert.equal(input.decision, 'modified');
    let text = input.findings.join('\n');
    let [, original, retained] = text.match(/truncate_middle: (\d+) tokens cut to (\d+)/)!;
    let [, budget] = text.match(/budget (\d+)/)!;
    assert.ok(Number(retained) <= Number(budget) && Number(retained) < Number(original), text);
    assert.ok(result.trace!.transformedSource.startsWith('HEAD word') && !result.trace!.transformedSource.includes('MIDDLE'));
  });

  it('should refuse options that name another prompt or harness version', async () => {
    let result = await run({ prompt: '0shot.txt@other' });
    assert.match(result.error!, /options\.prompt "0shot.txt@other" is not the prompt this harness implements/);
    result = await run({ version: '0' });
    assert.match(result.error!, /options\.version "0" is not this harness's version/);
  });

  it('should retry a transient failure, and not a final one', async () => {
    // a stand-in for the proxy: fails as told, then answers
    let statuses: number[] = [];
    let server = createServer((req, res) => {
      let status = statuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: 'The correct answer is (A)' }, finish_reason: 'stop' }] }) : JSON.stringify({ error: { message: `status ${status}` } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    let stub: ModelProxy = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, register: () => 't',
      usage: () => ({ modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] }), requests: () => [], close: async () => {},
    };
    try {
      statuses = [503];
      let result = await run({}, stub);
      assert.equal(result.output, 'The correct answer is (A)');
      assert.match(result.trace!.stages[1].findings.join('\n'), /attempts 2: 1: 503 .* in \ds; 2: ok in \ds/);
      statuses = [400];
      result = await run({}, stub);
      assert.match(result.error!, /^model call failed after 1 attempt\(s\): 1: 400/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
