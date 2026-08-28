import { describe, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { startProxy } from '../src/proxy.js';
import { sandboxedSystem } from '../src/systems/sandboxed.js';
import { loadCases } from '../src/caseStore.js';
import type { ModelClient, ModelProxy } from '../src/types.js';

// mock upstream: records request bodies, answers "Yes" with fixed usage
let seen: any[] = [];
let upstream: Server;
let proxy: ModelProxy;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Yes' } }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  let { port } = upstream.address() as AddressInfo;
  proxy = await startProxy({
    upstreamUrl: `http://127.0.0.1:${port}/v1`,
    upstreamKey: 'real-key',
    defaultTemperature: 0.3,
    timeoutMs: 5000,
    maxCalls: 3,
  });
});

afterAll(async () => {
  await proxy.close();
  await new Promise((r) => upstream.close(r));
});

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
    assert.deepEqual(proxy.usage(token), { modelCalls: 2, tokensIn: 100, tokensOut: 10 });
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
  it('should run the placeholder entry as a child process end to end', async () => {
    let { pub } = (await loadCases('cases'))[0];
    let system = sandboxedSystem('sandboxed', [process.execPath, 'src/sandbox/placeholder-entry.mjs']);
    let model = { model: 'test-model' } as ModelClient;
    let result = await system.run(pub, { runId: 't', repetition: 1, model, proxy });
    assert.equal(result.output, 'Yes');
    assert.equal(result.error, undefined);
    // two chain steps, accounted by the proxy, not self-reported
    assert.equal(result.modelCalls, 2);
    assert.equal(result.tokensIn, 100);
    // the sandbox got the proxy, not the upstream: it sent our bearer token
    assert.equal(seen[seen.length - 1].model, 'test-model');
  });

  it('should report a sandbox that dies as an errored run', async () => {
    let { pub } = (await loadCases('cases'))[0];
    let system = sandboxedSystem('sandboxed', [process.execPath, '-e', 'process.exit(3)']);
    let model = { model: 'test-model' } as ModelClient;
    let result = await system.run(pub, { runId: 't', repetition: 1, model, proxy });
    assert.match(result.error ?? '', /exited 3/);
  });
});
