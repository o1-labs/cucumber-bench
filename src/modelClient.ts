import assert from 'node:assert/strict';
import type { ModelClient, Generation } from './types.js';

export { createModelClient };

// openai-compatible chat client; works with ollama (/v1) and hosted apis
// config via env: BENCH_BASE_URL, BENCH_MODEL, BENCH_API_KEY, BENCH_TEMPERATURE, BENCH_TIMEOUT_MS
function createModelClient(): ModelClient {
  let baseUrl = process.env.BENCH_BASE_URL ?? 'http://localhost:11434/v1';
  let model = process.env.BENCH_MODEL ?? 'qwen3:8b';
  let apiKey = process.env.BENCH_API_KEY ?? 'none';
  let temperature = Number(process.env.BENCH_TEMPERATURE ?? 0);
  let timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 120_000);

  return {
    model,
    async generate(prompt, opts): Promise<Generation> {
      let messages: { role: string; content: string }[] = [];
      if (opts?.system) messages.push({ role: 'system', content: opts.system });
      messages.push({ role: 'user', content: prompt });

      let res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // read the body once; the assert message must not consume it eagerly
      let raw = await res.text();
      assert(res.ok, `model call failed: ${res.status} ${raw}`);

      let data: any = JSON.parse(raw);
      let text = stripThink(data.choices?.[0]?.message?.content ?? '');
      return {
        text,
        usage: {
          modelCalls: 1,
          tokensIn: data.usage?.prompt_tokens ?? 0,
          tokensOut: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

// internal helpers

// qwen3 and other reasoning models may emit <think>...</think> before the answer
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
