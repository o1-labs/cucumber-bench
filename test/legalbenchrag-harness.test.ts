import { it } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCases } from '../src/caseStore.js';
import { startProxy } from '../src/proxy.js';
import { sandboxedSystem } from '../src/sandbox.js';
import { runSuite } from '../src/runner.js';
import { graders } from '../benchmarks/legalbenchrag/graders.js';
import { tsx } from './upstream.js';

it('runs the Qwen reference once through the proxy, resolves shared documents, grades, and rejects tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legalbenchrag-'));
  const suite = join(root, 'legalbenchrag-dev');
  await mkdir(join(suite, 'cases'), { recursive: true });
  await mkdir(join(suite, 'documents'));
  const document = JSON.stringify({ title: 'contract.txt', text: 'The term is one year.' });
  const hash = createHash('sha256').update(document).digest('hex');
  const path = join(suite, 'documents', `${hash}.json`);
  await writeFile(path, document);
  for (const id of ['sample-1', 'sample-2']) {
    await writeFile(join(suite, 'cases', `${id}.public.json`), JSON.stringify({
      id, suite: 'legalbenchrag-dev', task: 'retrieval', instructions: 'Return verbatim quotes.',
      input: 'What is the term?', documentRefs: [hash],
    }));
    await writeFile(join(suite, 'cases', `${id}.private.json`), JSON.stringify({
      id, graders: ['rag-recall', 'rag-precision'], snippets: [{ file_path: 'contract.txt', span: [0, 21] }],
    }));
  }
  const seen: any[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '[{"file_path":"contract.txt","quote":"The term is one year."}]' } }],
      usage: { prompt_tokens: 30, completion_tokens: 15 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy({ upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    upstreamKey: 'test-key', defaultTemperature: 0, timeoutMs: 5000, maxCalls: 1, maxJudgeCalls: 1 });
  try {
    const cases = await loadCases(root);
    assert.equal(cases[0].pub.docs![0], cases[1].pub.docs![0], 'same document object is cached');
    const manifest = JSON.parse(await readFile('harnesses/direct-qwen38/harness.json', 'utf8'));
    assert.equal(manifest.models.main, 'qwen/qwen3.8-27b');
    assert.equal(manifest.maxCalls, 1);
    const system = sandboxedSystem(manifest.name, tsx(join('harnesses/direct-qwen38', manifest.entry)),
      { main: manifest.models.main, safety: manifest.models.main }, manifest.suites, manifest.maxCalls);
    const [record] = await runSuite({ runId: 'smoke', cases: cases.slice(0, 1), systems: [system], graders,
      proxy, judgeFor: () => 'unused', repetitions: 1 });
    assert.equal(record.status, 'ok');
    assert(record.grades.every((grade) => grade.score === 1));
    assert.equal(record.run.modelCalls, 1);
    assert.equal(record.judge.modelCalls, 0);
    assert.equal(seen[0].model, manifest.models.main);
    assert.equal(seen[0].temperature, 0);
    assert.match(seen[0].messages[0].content, /The term is one year\./);
    assert(!seen[0].messages[0].content.includes('"span"'));
    assert(seen[0].messages[0].content.endsWith('Retrieved snippets (JSON array):'));
    await writeFile(path, document + ' ');
    await assert.rejects(loadCases(root), /checksum mismatch/);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
