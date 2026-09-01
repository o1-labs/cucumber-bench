export { resolveModelConfig, keyFromEnv };

// env config. providers (urls, keys) live only here: they are infrastructure and
// secrets. a harness manifest names its own models; a benchmark manifest names its
// judge, and BENCH_JUDGE_MODEL is the default for a benchmark that names none.
function resolveModelConfig() {
  let baseUrl = env('BENCH_BASE_URL') ?? 'http://localhost:11434/v1';
  let apiKey = env('BENCH_API_KEY') ?? 'none';
  return {
    baseUrl,
    apiKey,
    judgeModel: env('BENCH_JUDGE_MODEL') ?? 'qwen3:8b',
    judgeBaseUrl: env('BENCH_JUDGE_BASE_URL') ?? baseUrl,
    judgeApiKey: env('BENCH_JUDGE_API_KEY') ?? apiKey,
    temperature: Number(env('BENCH_TEMPERATURE') ?? 0),
    timeoutMs: Number(env('BENCH_TIMEOUT_MS') ?? 120_000),
  };
}

// the key for a harness provider: the manifest names the env variable (keyEnv), the
// key itself stays in .env. absent keyEnv: no key (a local ollama)
function keyFromEnv(keyEnv: string | undefined, context: string): string {
  if (!keyEnv) return 'none';
  let key = env(keyEnv);
  if (!key) throw Error(`${context}: the provider key env variable ${keyEnv} is not set`);
  return key;
}

// internal helpers

// empty or whitespace-only env values count as unset
function env(name: string): string | undefined {
  let v = process.env[name]?.trim();
  return v ? v : undefined;
}
