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
});
