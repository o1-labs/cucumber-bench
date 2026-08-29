import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mockUpstream, type Mock } from './upstream.js';
import type { ModelProxy } from '../src/types.js';

let mock: Mock;
let seen: any[];
let proxy: ModelProxy;
beforeAll(async () => {
  mock = await mockUpstream();
  ({ seen, proxy } = mock);
});
afterAll(() => mock.close());

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
    assert.deepEqual(proxy.usage(token), { modelCalls: 2, tokensIn: 100, tokensOut: 10, costUsd: 0.002, models: ['m'] });
  });

  it('should serve the safety route outside the leakage record, with the model the harness names', async () => {
    let token = proxy.register('r5');
    let res = await fetch(`${proxy.url}/safety/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'safety-model', messages: [{ role: 'user', content: 'raw document' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[seen.length - 1].model, 'safety-model');
    assert.deepEqual(proxy.usage(token).models, ['safety-model']);
    assert.deepEqual(proxy.requests(token), []);
    assert.equal(proxy.usage(token).modelCalls, 1);
  });

  it('should serve the judge route outside the leakage record, with the model the grader names', async () => {
    let token = proxy.register('r6');
    let res = await fetch(`${proxy.url}/judge/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'judge-model', messages: [{ role: 'user', content: 'Premise: x' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[seen.length - 1].model, 'judge-model');
    assert.deepEqual(proxy.requests(token), []);
  });

  it('should enforce the per-run call limit', async () => {
    let token = proxy.register('r3');
    await call(token); await call(token); await call(token); await call(token);
    assert.equal((await call(token)).status, 429);
    // other runs are unaffected
    assert.equal((await call(proxy.register('r4'))).status, 200);
  });
});
