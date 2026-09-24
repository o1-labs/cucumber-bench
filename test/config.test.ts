import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { keyFromEnv, resolveModelConfig } from '../src/config.js';

describe('resolveModelConfig', () => {
  let origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('should treat blank env values as unset', () => {
    process.env.BENCH_JUDGE_MODEL = '   ';
    assert.equal(resolveModelConfig().judgeModel, 'qwen3:8b');
  });

  it('should read the env values', () => {
    process.env.BENCH_JUDGE_MODEL = 'm';
    process.env.BENCH_TEMPERATURE = '0.7';
    let cfg = resolveModelConfig();
    assert.equal(cfg.judgeModel, 'm');
    assert.equal(cfg.temperature, 0.7);
  });

  it('should read a provider key from the env variable the manifest names, and fail on a missing one', () => {
    assert.equal(keyFromEnv(undefined, 'harness x'), 'none');
    process.env.MY_TOKEN = 'k';
    assert.equal(keyFromEnv('MY_TOKEN', 'harness x'), 'k');
    assert.throws(() => keyFromEnv('UNSET_TOKEN', 'harness x'), /harness x: the provider key env variable UNSET_TOKEN is not set/);
  });

  it('should fail before a run when OpenRouter has no authentication key', () => {
    process.env.BENCH_BASE_URL = 'https://openrouter.ai/api/v1';
    delete process.env.BENCH_API_KEY;
    delete process.env.BENCH_JUDGE_API_KEY;

    assert.throws(
      () => resolveModelConfig(),
      /BENCH_API_KEY is required when BENCH_BASE_URL uses OpenRouter/,
    );
  });

  it('should reuse the main OpenRouter key for the judge when no judge key is set', () => {
    process.env.BENCH_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.BENCH_API_KEY = 'test-key';
    process.env.BENCH_JUDGE_BASE_URL = 'https://openrouter.ai/api/v1';
    delete process.env.BENCH_JUDGE_API_KEY;

    let cfg = resolveModelConfig();
    assert.equal(cfg.apiKey, 'test-key');
    assert.equal(cfg.judgeApiKey, 'test-key');
  });
});
