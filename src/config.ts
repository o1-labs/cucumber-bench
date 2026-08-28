export { resolveModelConfig };

// env config: BENCH_BASE_URL, BENCH_MODEL, BENCH_API_KEY, BENCH_TEMPERATURE, BENCH_TIMEOUT_MS.
// the values feed the proxy; no system ever sees them directly.
function resolveModelConfig() {
  return {
    baseUrl: env('BENCH_BASE_URL') ?? 'http://localhost:11434/v1',
    model: env('BENCH_MODEL') ?? 'qwen3:8b',
    apiKey: env('BENCH_API_KEY') ?? 'none',
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
