import assert from 'node:assert/strict';
import type { ModelClient, Generation } from './types.js';

export { createModelClient, resolveModelConfig, type ModelConfig };

type ModelConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
};

// env vars are the defaults (BENCH_BASE_URL, BENCH_MODEL, BENCH_API_KEY,
// BENCH_TEMPERATURE, BENCH_TIMEOUT_MS); overrides beat them
function resolveModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  let cfg: ModelConfig = {
    baseUrl: env('BENCH_BASE_URL') ?? 'http://localhost:11434/v1',
    model: env('BENCH_MODEL') ?? 'qwen3:8b',
    apiKey: env('BENCH_API_KEY') ?? 'none',
    temperature: Number(env('BENCH_TEMPERATURE') ?? 0),
    timeoutMs: Number(env('BENCH_TIMEOUT_MS') ?? 120_000),
    ...definedOnly(overrides),
  };
  assert(cfg.model.trim() !== '', 'resolveModelConfig: model is empty, set BENCH_MODEL or pass an override');
  return cfg;
}

// openai-compatible chat client; works with ollama (/v1) and hosted apis.
// a system may create its own client with overrides, and override temperature per call
function createModelClient(overrides: Partial<ModelConfig> = {}): ModelClient {
  let { baseUrl, model, apiKey, temperature, timeoutMs } = resolveModelConfig(overrides);

  return {
    model,
    async generate(prompt, opts): Promise<Generation> {
      let messages: { role: string; content: string }[] = [];
      if (opts?.system) messages.push({ role: 'system', content: opts.system });
      messages.push({ role: 'user', content: prompt });

      let res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: opts?.temperature ?? temperature }),
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

// empty or whitespace-only env values count as unset
function env(name: string): string | undefined {
  let v = process.env[name]?.trim();
  return v ? v : undefined;
}

// keys set to undefined must not clobber the defaults when spread
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// qwen3 and other reasoning models may emit <think>...</think> before the answer
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
