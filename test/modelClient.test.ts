import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createModelClient } from '../src/modelClient.js';

describe('createModelClient', () => {
  let origFetch = globalThis.fetch;
  let origEnv = { ...process.env };
  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env = { ...origEnv };
  });

  it('should treat blank env values as unset', () => {
    process.env.BENCH_MODEL = '   ';
    assert.equal(createModelClient().model, 'qwen3:8b');
  });

  it('should send per-call temperature over the env default', async () => {
    let sent: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
    }) as typeof fetch;

    process.env.BENCH_TEMPERATURE = '0.7';
    let client = createModelClient();
    await client.generate('hi');
    await client.generate('hi', { temperature: 0 });
    assert.equal(sent[0].temperature, 0.7);
    assert.equal(sent[1].temperature, 0);
  });
});
