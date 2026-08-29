export { resolveModelConfig };

// env config. providers (urls, keys) live only here: they are infrastructure and
// secrets. the model ids here are defaults: a harness manifest names its own models
// and a benchmark manifest names its judge; these apply when a manifest names none.
function resolveModelConfig() {
  let baseUrl = env('BENCH_BASE_URL') ?? 'http://localhost:11434/v1';
  let model = env('BENCH_MODEL') ?? 'qwen3:8b';
  let apiKey = env('BENCH_API_KEY') ?? 'none';
  return {
    baseUrl,
    model,
    apiKey,
    safetyModel: env('BENCH_SAFETY_MODEL') ?? model,
    judgeModel: env('BENCH_JUDGE_MODEL') ?? model,
    judgeBaseUrl: env('BENCH_JUDGE_BASE_URL') ?? baseUrl,
    judgeApiKey: env('BENCH_JUDGE_API_KEY') ?? apiKey,
    temperature: Number(env('BENCH_TEMPERATURE') ?? 0),
    timeoutMs: Number(env('BENCH_TIMEOUT_MS') ?? 120_000),
  };
}

// internal helpers

// empty or whitespace-only env values count as unset
function env(name: string): string | undefined {
  let v = process.env[name]?.trim();
  return v ? v : undefined;
}
