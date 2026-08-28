import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { containsSpan, leakageGrader, removalGrader, retentionGrader, tokens } from '../benchmarks/redaction/graders.js';
import type { PublicCase, PrivateCase, RunResult } from '../src/types.js';

let source = 'Patient Ann Kowalski (ann.k@example.com, +41 79 123 45 67) reports chest pain since Monday. Plan: ECG and troponin.';
let pub = { id: 'r1', suite: 'redaction', task: 'pii-redaction', instructions: '', input: source } as PublicCase;
let priv: PrivateCase = { id: 'r1', graders: ['removal', 'leakage', 'retention'], protected: ['Ann Kowalski', 'ann.k@example.com', '+41 79 123 45 67'] };

let ctx = { judge: async () => 'no' };

function result(output: string, modelRequests?: string[]): RunResult {
  return {
    caseId: 'r1', system: 's', repetition: 1, output, modelRequests,
    latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0,
  };
}

describe('containsSpan', () => {
  it('should match case-insensitively with flexible whitespace and whole words', () => {
    assert.equal(containsSpan('contact ANN  KOWALSKI now', 'Ann Kowalski'), true);
    assert.equal(containsSpan('Kowalskis', 'Kowalski'), false);
    assert.equal(containsSpan('email: ann.k@example.com.', 'ann.k@example.com'), true);
  });
});

describe('tokens', () => {
  it('should lowercase and keep only words of 3+ letters or digits', () => {
    assert.deepEqual(tokens('ECG and troponin, 45 67!'), ['ecg', 'and', 'troponin']);
  });
});

describe('removalGrader', () => {
  it('should pass only when every protected span is gone', async () => {
    let clean = 'Patient [REDACTED] ([REDACTED], [REDACTED]) reports chest pain since Monday. Plan: ECG and troponin.';
    let g = await removalGrader().grade(pub, priv, result(clean), ctx);
    assert.equal(g.pass, true);
    assert.equal(g.score, 1);
    let partial = await removalGrader().grade(pub, priv, result('Patient Ann Kowalski reports chest pain.'), ctx);
    assert.equal(partial.pass, false);
    assert.ok(Math.abs(partial.score - 2 / 3) < 1e-9);
    assert.match(partial.detail ?? '', /Ann Kowalski/);
  });
});

describe('leakageGrader', () => {
  it('should measure what reached the model, not the output', async () => {
    let clean = 'Patient [REDACTED] reports chest pain.';
    let leaked = await leakageGrader().grade(pub, priv, result(clean, [`Redact this: ${source}`]), ctx);
    assert.equal(leaked.pass, false);
    assert.equal(leaked.score, 0);
    let safe = await leakageGrader().grade(pub, priv, result(clean, ['Redact this: Patient [REDACTED] reports chest pain.']), ctx);
    assert.equal(safe.pass, true);
    let noCalls = await leakageGrader().grade(pub, priv, result(clean), ctx);
    assert.equal(noCalls.pass, true);
  });
});

describe('retentionGrader', () => {
  it('should reward keeping the non-protected content and punish over-removal', async () => {
    let kept = await retentionGrader().grade(pub, priv, result('Patient [REDACTED] reports chest pain since Monday. Plan: ECG and troponin.'), ctx);
    assert.equal(kept.pass, true);
    assert.equal(kept.score, 1);
    let gutted = await retentionGrader().grade(pub, priv, result('[REDACTED]'), ctx);
    assert.equal(gutted.pass, false);
    assert.equal(gutted.score, 0);
  });
});
