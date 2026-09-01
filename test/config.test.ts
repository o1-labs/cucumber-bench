import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { providerFor, resolveModelConfig } from '../src/config.js';

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

  it('should resolve a named provider, with dashes as underscores, and fail on a missing one', () => {
    process.env.BENCH_PROVIDER_MY_FT_BASE_URL = 'http://ft:1234/v1';
    assert.deepEqual(providerFor('my-ft'), { url: 'http://ft:1234/v1', key: 'none' });
    process.env.BENCH_PROVIDER_MY_FT_API_KEY = 'k';
    assert.equal(providerFor('my-ft').key, 'k');
    assert.throws(() => providerFor('nope'), /BENCH_PROVIDER_NOPE_BASE_URL/);
  });
});
