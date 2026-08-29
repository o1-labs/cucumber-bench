import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mockUpstream, models, tsx, type Mock } from './upstream.js';
import { sandboxedSystem } from '../src/sandbox.js';
import { loadCases } from '../src/caseStore.js';
import type { ModelProxy } from '../src/types.js';

let mock: Mock;
let seen: any[];
let proxy: ModelProxy;
beforeAll(async () => {
  mock = await mockUpstream();
  ({ seen, proxy } = mock);
});
afterAll(() => mock.close());

describe('sandboxedSystem', () => {
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

describe('review-v1 (review harness)', () => {
  it('should scan every passage in batches, compose from the quotes, and check each cited sentence', async () => {
    let { pub } = (await loadCases('benchmarks/cuad')).find((c) => c.pub.id === 'cuad-000')!;
    let n = pub.docs!.length, batches = Math.ceil(n / 5);
    // the manifest's own call limit: the scan calls + compose + two checks are over the test proxy's 4
    let system = sandboxedSystem('review-v1', tsx('harnesses/review-v1/src/entry.ts'), models, undefined, 10);
    let result = await system.run(pub, { runId: 't', repetition: 1, proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.modelCalls, batches + 3);
    assert.ok(seen.slice(-(batches + 3)).every((r) => r.temperature === 0));
    let quote = pub.docs![1].text.split(' ').slice(0, 8).join(' ');
    // the composed draft is two sentences; the uncited "Yes." is dropped by the check
    assert.equal(result.trace!.rawOutput, `Yes. The contract contains the clause: "${quote}" [2].`);
    assert.equal(result.output, `The contract contains the clause: "${quote}" [2].`);
    let [, agent, check] = result.trace!.stages;
    assert.equal(agent.module, 'scan-compose');
    assert.deepEqual(agent.findings, [`scanned ${n} passages in ${batches} calls: 1 quote(s) from [2]`]);
    assert.equal(check.module, 'citation-check');
    assert.deepEqual(check.findings, ['s1: uncited dropped, not about the documents', 's2: [2] supported']);
    assert.equal(check.decision, 'modified');
  });
});
