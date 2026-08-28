import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadBenchmarks, loadHarnesses } from '../src/manifests.js';

describe('manifests', () => {
  it('should discover every harness with its suites and image', async () => {
    let hs = await loadHarnesses('harnesses');
    assert.deepEqual(hs.map((h) => h.name), ['cite-v1', 'direct', 'legal-v1', 'placeholder']);
    let legal = hs.find((h) => h.name === 'legal-v1')!;
    assert.equal(legal.image, 'cucumber-harness-legal-v1');
    assert.equal(legal.imageEntry, '/app/dist/entry.js');
    assert.deepEqual(legal.suites, ['legalbench', 'redaction']);
    let direct = hs.find((h) => h.name === 'direct')!;
    assert.equal(direct.image, 'cucumber-harness-base');
    assert.equal(direct.imageEntry, '/app/direct/src/entry.ts');
  });

  it('should load core graders by name and custom graders from a module', async () => {
    let bs = await loadBenchmarks('benchmarks');
    assert.deepEqual(bs.map((b) => [b.name, b.graders.map((g) => g.name)]), [
      ['asqa', ['str-em', 'citation-recall', 'citation-precision']],
      ['asqa-dev', ['str-em', 'citation-recall', 'citation-precision']],
      ['legalbench', ['exact']],
      ['redaction', ['removal', 'leakage', 'retention']],
    ]);
  });
});
