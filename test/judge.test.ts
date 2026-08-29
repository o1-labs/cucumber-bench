import { describe, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { judgeVia } from '../src/judge.js';
import type { ModelProxy } from '../src/types.js';

// a fake proxy: answers with the given status codes in order, then 200 "yes"
function fakeProxy(statuses: number[]): Promise<{ proxy: ModelProxy; server: Server; calls: () => number }> {
  let n = 0;
  let server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      n++;
      let status = statuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: 'yes' } }] }) : JSON.stringify({ error: { message: 'nope' } }));
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      let { port } = server.address() as AddressInfo;
      let proxy = { url: `http://127.0.0.1:${port}`, register: () => 't', usage: () => ({ modelCalls: 0, tokensIn: 0, tokensOut: 0 }), requests: () => [], close: async () => {} };
      r({ proxy, server, calls: () => n });
    }),
  );
}

describe('judgeVia', () => {
  it('should retry timeouts and rate limits with backoff', async () => {
    let { proxy, server, calls } = await fakeProxy([502, 429]);
    let judge = judgeVia(proxy, 't', 'm', { backoffMs: 1 });
    assert.equal(await judge('q'), 'yes');
    assert.equal(calls(), 3);
    server.close();
  });

  it('should give up after the retries, and not retry client errors', async () => {
    let { proxy, server } = await fakeProxy([502, 502, 502, 502]);
    await assert.rejects(judgeVia(proxy, 't', 'm', { retries: 2, backoffMs: 1 })('q'), /judge call failed: 502/);
    let { proxy: p2, server: s2, calls } = await fakeProxy([401]);
    await assert.rejects(judgeVia(p2, 't', 'm', { backoffMs: 1 })('q'), /judge call failed: 401/);
    assert.equal(calls(), 1);
    server.close();
    s2.close();
  });
});
