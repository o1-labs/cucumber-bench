import { describe, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { startProxy } from '../src/proxy.js';

// two mock upstreams: the judge route must reach the second one with its own key
function mock(name: string, seen: any[]): Promise<Server> {
  let server = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ upstream: name, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: name } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

describe('judge upstream', () => {
  it('should send judge calls to the judge provider with the judge key, and harness calls to the main one', async () => {
    let seen: any[] = [];
    let main = await mock('main', seen);
    let judge = await mock('judge', seen);
    let port = (s: Server) => (s.address() as AddressInfo).port;
    let proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${port(main)}/v1`,
      upstreamKey: 'main-key',
      judgeUpstreamUrl: `http://127.0.0.1:${port(judge)}/v1`,
      judgeUpstreamKey: 'judge-key',
      defaultTemperature: 0,
      timeoutMs: 5000,
      maxCalls: 5,
      maxJudgeCalls: 5,
    });
    let token = proxy.register('r');
    let post = (path: string) =>
      fetch(`${proxy.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      });
    assert.equal((await post('/v1/chat/completions')).status, 200);
    assert.equal((await post('/judge/v1/chat/completions')).status, 200);
    assert.deepEqual(seen.map((s) => [s.upstream, s.auth, s.body.model]), [
      ['main', 'Bearer main-key', 'm'],
      ['judge', 'Bearer judge-key', 'm'],
    ]);
    await proxy.close();
    main.close();
    judge.close();
  });
});
