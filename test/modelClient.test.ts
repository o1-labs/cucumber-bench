import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createModelClient } from '../src/modelClient.js';

describe('createModelClient', () => {
  let origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('should let overrides beat env defaults', () => {
    let client = createModelClient({ model: 'other:1b' });
    assert.equal(client.model, 'other:1b');
  });

  it('should treat blank env values as unset', () => {
    let orig = process.env.BENCH_MODEL;
    process.env.BENCH_MODEL = '   ';
    try {
      assert.equal(createModelClient().model, 'qwen3:8b');
    } finally {
      if (orig === undefined) delete process.env.BENCH_MODEL;
      else process.env.BENCH_MODEL = orig;
    }
  });

  it('should ignore overrides that are explicitly undefined', () => {
    assert.equal(createModelClient({ model: undefined }).model, 'qwen3:8b');
  });

  it('should send per-call temperature over the client setting', async () => {
    let sent: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
    }) as typeof fetch;

    let client = createModelClient({ temperature: 0.7 });
    await client.generate('hi');
    await client.generate('hi', { temperature: 0 });
    assert.equal(sent[0].temperature, 0.7);
    assert.equal(sent[1].temperature, 0);
  });
});
