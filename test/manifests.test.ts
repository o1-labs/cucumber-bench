import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadBenchmarks, loadHarnesses, uniqueGraders } from '../src/manifests.js';
import { loadCases } from '../src/caseStore.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('manifests', () => {
  it('should discover every harness with its suites and image', async () => {
    let hs = await loadHarnesses('harnesses');
    assert.deepEqual(hs.map((h) => h.name), ['cite-v1', 'direct', 'direct-4b', 'direct-4b-ft', 'legal-v1', 'placeholder', 'review-ft', 'review-v1']);
    // a variant harness: reuses the direct entry, brings its own model and provider
    assert.deepEqual(hs.find((h) => h.name === 'direct-4b')!.providers, {
      'Qwen/Qwen3-4B-Instruct-2507:nscale': { baseUrl: 'https://router.huggingface.co/v1', keyEnv: 'HF_TOKEN' },
    });
    assert.equal(hs.find((h) => h.name === 'review-v1')!.maxCalls, 120);
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
      ['cuad', ['clause-recall', 'clause-precision', 'citation-support']],
      ['cuad-dev', ['clause-recall', 'clause-precision', 'citation-support']],
      ['cuad-hard', ['clause-recall', 'clause-precision', 'citation-support']],
      ['cuad-hard-dev', ['clause-recall', 'clause-precision', 'citation-support']],
      ['legalbench', ['exact']],
      ['redaction', ['removal', 'leakage', 'retention']],
    ]);
  });

  it('should give the project every grader once, and refuse one name from two implementations', async () => {
    let bs = await loadBenchmarks('benchmarks');
    let all = uniqueGraders(bs);
    assert.deepEqual(all.map((g) => g.name), [
      'str-em', 'citation-recall', 'citation-precision', 'clause-recall', 'clause-precision', 'citation-support', 'exact', 'removal', 'leakage', 'retention',
    ]);
    // asqa and asqa-dev load the same module: the same grader objects
    assert.equal(bs[0].graders[1], bs[1].graders[1]);
    let clash = { ...bs[0], name: 'other', graders: [{ ...bs[0].graders[0] }] };
    assert.throws(() => uniqueGraders([bs[0], clash]), /the grader name str-em is already taken/);
  });

  it('should refuse a case whose file name, folder or id does not agree', async () => {
    let root = await mkdtemp(join(tmpdir(), 'cases-'));
    let write = async (suite: string, file: string, id: string, caseSuite = suite) => {
      await mkdir(join(root, suite, 'cases'), { recursive: true });
      await writeFile(join(root, suite, 'cases', `${file}.public.json`), JSON.stringify({ id, suite: caseSuite, task: 't', instructions: '', input: '' }));
      await writeFile(join(root, suite, 'cases', `${file}.private.json`), JSON.stringify({ id, graders: ['exact'] }));
    };
    await write('s1', 's1-000', 's1-000');
    await write('s1', 's1-001', 's1-000');
    await assert.rejects(loadCases(root), /holds the case s1-000/);
    await write('s1', 's1-001', 's1-001', 's2');
    await assert.rejects(loadCases(root), /is in s1 but names the suite s2/);
  });
});
