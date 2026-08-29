import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { resolveModelConfig } from '../src/config.js';

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
});
