import assert from 'node:assert/strict';
import type { ModelClient } from './types.js';

export { createModelClient, resolveModelConfig };

// env config: BENCH_BASE_URL, BENCH_MODEL, BENCH_API_KEY, BENCH_TEMPERATURE, BENCH_TIMEOUT_MS
function resolveModelConfig() {
  return {
    baseUrl: env('BENCH_BASE_URL') ?? 'http://localhost:11434/v1',
    model: env('BENCH_MODEL') ?? 'qwen3:8b',
    apiKey: env('BENCH_API_KEY') ?? 'none',
    temperature: Number(env('BENCH_TEMPERATURE') ?? 0),
    timeoutMs: Number(env('BENCH_TIMEOUT_MS') ?? 120_000),
  };
}

// openai-compatible chat client; works with ollama (/v1) and hosted apis.
// temperature may be overridden per call
function createModelClient(): ModelClient {
  let { baseUrl, model, apiKey, temperature, timeoutMs } = resolveModelConfig();

  return {
    model,
    async generate(prompt, opts) {
      let res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: opts?.temperature ?? temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // read the body once; the assert message must not consume it eagerly
      let raw = await res.text();
      assert(res.ok, `model call failed: ${res.status} ${raw}`);

      let data: any = JSON.parse(raw);
      return {
        text: stripThink(data.choices?.[0]?.message?.content ?? ''),
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

// empty or whitespace-only env values count as unset
function env(name: string): string | undefined {
  let v = process.env[name]?.trim();
  return v ? v : undefined;
}

// qwen3 and other reasoning models may emit <think>...</think> before the answer
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
