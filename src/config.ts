import assert from 'node:assert/strict';

export { resolveModelConfig, providerFor };

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

// a named provider a harness selects with "provider" in its manifest, e.g. a finetuned
// model on its own server. BENCH_PROVIDER_<NAME>_BASE_URL and _API_KEY (default: none)
function providerFor(name: string): { url: string; key: string } {
  let prefix = `BENCH_PROVIDER_${name.toUpperCase().replace(/-/g, '_')}`;
  let url = env(`${prefix}_BASE_URL`);
  assert(url, `provider ${name}: set ${prefix}_BASE_URL in .env`);
  return { url, key: env(`${prefix}_API_KEY`) ?? 'none' };
}

// internal helpers

// empty or whitespace-only env values count as unset
function env(name: string): string | undefined {
  let v = process.env[name]?.trim();
  return v ? v : undefined;
}
