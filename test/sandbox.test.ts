import { describe, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { startProxy } from '../src/proxy.js';
import { sandboxedSystem } from '../src/systems/sandboxed.js';
import { loadCases } from '../src/caseStore.js';
import type { ModelProxy } from '../src/types.js';

// mock upstream: records request bodies; answers the pii-detection prompt with a
// json list of names, everything else with "Yes"; fixed usage
let seen: any[] = [];
let upstream: Server;
let proxy: ModelProxy;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      let prompt = (body.messages ?? []).map((m: any) => m.content).join('\n');
      let content = prompt.includes('Return only a JSON array') ? '["Heder", "Sanavi"]' : 'Yes';
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.001 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  let { port } = upstream.address() as AddressInfo;
  proxy = await startProxy({
    upstreamUrl: `http://127.0.0.1:${port}/v1`,
    upstreamKey: 'real-key',
    safetyModel: 'safety-model',
    judgeModel: 'judge-model',
    defaultTemperature: 0.3,
    timeoutMs: 5000,
    maxCalls: 3,
    maxJudgeCalls: 5,
  });
});

afterAll(async () => {
  await proxy.close();
  await new Promise((r) => upstream.close(r));
});

// typescript entries run under tsx in process mode, as the cli does
function tsx(entry: string) {
  return [process.execPath, 'node_modules/tsx/dist/cli.mjs', entry];
}

function call(token: string, body: any = { model: 'm', messages: [] }) {
  return fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('proxy', () => {
  it('should reject unknown tokens and wrong routes', async () => {
    assert.equal((await call('bogus')).status, 401);
    let token = proxy.register('r1');
    let res = await fetch(`${proxy.url}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404);
  });

  it('should forward calls, inject defaults, and account usage server-side', async () => {
    let token = proxy.register('r2');
    let res = await call(token);
    assert.equal(res.status, 200);
    let data: any = await res.json();
    assert.equal(data.choices[0].message.content, 'Yes');
    // default temperature injected because the sandbox did not set one
    assert.equal(seen[seen.length - 1].temperature, 0.3);
    // explicit temperature passes through
    await call(token, { model: 'm', messages: [], temperature: 0 });
    assert.equal(seen[seen.length - 1].temperature, 0);
    assert.deepEqual(proxy.usage(token), { modelCalls: 2, tokensIn: 100, tokensOut: 10, costUsd: 0.002 });
  });

  it('should serve the trusted safety model on its own route, outside the leakage record', async () => {
    let token = proxy.register('r5');
    let res = await fetch(`${proxy.url}/safety/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'raw document' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[seen.length - 1].model, 'safety-model');
    assert.deepEqual(proxy.requests(token), []);
    assert.equal(proxy.usage(token).modelCalls, 1);
  });

  it('should serve the judge model on its own route, outside the leakage record', async () => {
    let token = proxy.register('r6');
    let res = await fetch(`${proxy.url}/judge/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Premise: x' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[seen.length - 1].model, 'judge-model');
    assert.deepEqual(proxy.requests(token), []);
  });

  it('should enforce the per-run call limit', async () => {
    let token = proxy.register('r3');
    await call(token); await call(token); await call(token);
    assert.equal((await call(token)).status, 429);
    // other runs are unaffected
    assert.equal((await call(proxy.register('r4'))).status, 200);
  });
});

describe('sandboxedSystem', () => {
  it('should run the direct baseline entry: one few-shot call, the raw input reaches the model', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let system = sandboxedSystem('direct', tsx('harnesses/direct/src/entry.ts'));
    let result = await system.run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
    assert.equal(result.output, 'Yes');
    assert.equal(result.modelCalls, 1);
    assert.equal(result.trace, undefined);
    assert.ok(result.modelRequests![0].includes(pub.input));
    assert.ok(result.modelRequests![0].includes('A:'));
  });

  it('should run the placeholder entry as a child process end to end', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let system = sandboxedSystem('sandboxed', tsx('harnesses/placeholder/src/entry.ts'));
    let result = await system.run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
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
    let system = sandboxedSystem('sandboxed', tsx('harnesses/placeholder/src/entry.ts'));
    let result = await system.run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
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
    let system = sandboxedSystem('sandboxed', [process.execPath, '-e', 'process.exit(3)']);
    let result = await system.run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
    assert.match(result.error ?? '', /exited 3/);
  });
});

describe('legal-v1 (vercel ai sdk harness)', () => {
  let argv = tsx('harnesses/legal-v1/src/entry.ts');

  it('should run a label case through the guarded model with passthrough safety', async () => {
    let { pub } = (await loadCases('benchmarks/legalbench'))[0];
    let result = await sandboxedSystem('legal-v1', argv).run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'Yes');
    assert.equal(result.modelCalls, 2);
    assert.deepEqual(result.trace?.stages.map((s) => s.mode), ['passthrough', 'llm', 'passthrough']);
  });

  it('should scrub regex hits and safety-model findings before the guarded model sees the document', async () => {
    let { pub } = (await loadCases('benchmarks/redaction')).find((c) => c.pub.id === 'pii-40805A')!;
    let result = await sandboxedSystem('legal-v1', argv).run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
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
  it('step 2: should plan the readings greedily, then answer with the few-shot prompt plus the coverage requirement', async () => {
    let { pub } = (await loadCases('benchmarks/asqa')).find((c) => c.pub.id === 'asqa-000')!;
    let system = sandboxedSystem('cite-v1', tsx('harnesses/cite-v1/src/entry.ts'));
    let result = await system.run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'Yes');
    assert.equal(result.modelCalls, 2);
    let [plan, answer] = result.modelRequests!;
    assert.ok(plan.includes('list the distinct readings') && plan.includes(pub.input));
    assert.equal(seen[seen.length - 2].temperature, 0);
    // the answer prompt is direct's prompt with the plan inserted before "Answer:"
    let direct = await sandboxedSystem('direct', tsx('harnesses/direct/src/entry.ts')).run(pub, { runId: 't', repetition: 1, model: 'test-model', proxy });
    let expected = direct.modelRequests![0].replace(/\nAnswer:$/, '\n\nCover each of these readings in one or two sentences, each with its citations:\nYes\nAnswer:');
    assert.equal(answer, expected);
    assert.deepEqual(result.trace?.stages[1].findings, ['Yes']);
  });
});
