export { resolveModelConfig };

// env config: BENCH_BASE_URL, BENCH_MODEL, BENCH_API_KEY, BENCH_SAFETY_MODEL,
// BENCH_JUDGE_MODEL, BENCH_JUDGE_BASE_URL, BENCH_JUDGE_API_KEY, BENCH_TEMPERATURE,
// BENCH_TIMEOUT_MS. the values feed the proxy; no system ever sees them.
function resolveModelConfig() {
  let baseUrl = env('BENCH_BASE_URL') ?? 'http://localhost:11434/v1';
  let model = env('BENCH_MODEL') ?? 'qwen3:8b';
  let apiKey = env('BENCH_API_KEY') ?? 'none';
  return {
    baseUrl,
    model,
    apiKey,
    // the trusted safety model a harness may show raw data to; same model unless configured
    safetyModel: env('BENCH_SAFETY_MODEL') ?? model,
    // the model graders use as a judge; may live on another provider (e.g. openrouter)
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
