import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCases, type Case } from '../src/caseStore.js';
import { startProxy } from '../src/proxy.js';
import { sandboxedSystem } from '../src/sandbox.js';
import { runSuite } from '../src/runner.js';
import { graders } from '../benchmarks/legalbenchrag/graders.js';
import { tsx } from './upstream.js';
import type { ModelProxy } from '../src/types.js';

// a contract with one relevant clause among filler sections; the gold span is the sentence
// inside the clause that states the term. every filler section is longer than the harness's
// chunk target, so each one is a chunk of its own
const GOLD = 'The term of this Agreement is one year from the Effective Date.';
const FILLER = 'This paragraph is about notices delivered after the Effective Date between the parties.';
const SECTION = Array(5).fill(FILLER).join(' ');
const CLAUSE = `5. Term and Termination. ${GOLD} Either party may terminate on ninety days written notice.`;
const TEXT = [
  'MASTER SERVICES AGREEMENT',
  ...Array.from({ length: 6 }, (_, i) => `${i + 1}. Section ${i + 1}. ${SECTION}`),
  CLAUSE,
  ...Array.from({ length: 6 }, (_, i) => `${i + 8}. Section ${i + 8}. ${SECTION}`),
].join('\n\n');

let root: string;
let cases: Case[];
let upstream: Server;
let proxy: ModelProxy;
let seen: any[];
// the mock jev: a passage scores by what it holds, a sentence by whether it is the gold one.
// the clause is short, so its chunk runs into section 8; the chunk after that (section 9)
// scores as a moderate neighbour. failFirst makes the first request of a test fail with 529 once
let failFirst = false;
function mockNoul(state: any, id: string, instructions: string): number {
  const sentence = instructions.match(/`sentences\.(s\d+)`/)?.[1];
  // the clause heading passes too, so the heading filter has something to drop
  if (sentence) return /one year|Term and Termination/.test(state.sentences[sentence]) ? 0.9 : 0.1;
  const passage: string = state.passages[id];
  if (passage.includes('Term and Termination')) return 0.92;
  if (passage.includes('Section 9.')) return 0.4;
  return 0.05;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'jev-v1-'));
  const suite = join(root, 'legalbenchrag-dev');
  await mkdir(join(suite, 'cases'), { recursive: true });
  await mkdir(join(suite, 'documents'));
  const document = JSON.stringify({ title: 'msa.txt', text: TEXT });
  const hash = createHash('sha256').update(document).digest('hex');
  await writeFile(join(suite, 'documents', `${hash}.json`), document);
  const start = TEXT.indexOf(GOLD);
  await writeFile(join(suite, 'cases', 'sample-1.public.json'), JSON.stringify({
    id: 'sample-1', suite: 'legalbenchrag-dev', task: 'retrieval',
    instructions: 'Return only a JSON array of objects with "file_path" and "quote".',
    input: 'Question: What is the term of the agreement?', documentRefs: [hash],
  }));
  await writeFile(join(suite, 'cases', 'sample-1.private.json'), JSON.stringify({
    id: 'sample-1', graders: ['rag-recall', 'rag-precision'], snippets: [{ file_path: 'msa.txt', span: [start, start + GOLD.length] }],
  }));
  cases = await loadCases(root);

  seen = [];
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (!req.url?.endsWith('/systemone')) {
      res.statusCode = 404;
      res.end('{"error":"the harness must not use a chat route"}');
      return;
    }
    if (failFirst) {
      failFirst = false;
      res.statusCode = 529;
      res.end('{"error":"overloaded"}');
      return;
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, q]: [string, any]) => [id, { type: 'noul', noul: mockNoul(body.state, id, q.instructions) }]),
    );
    res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1000, output_tokens: 10 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await startProxy({
    upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    upstreamKey: 'unused-key', defaultTemperature: 0, timeoutMs: 5000, maxCalls: 40, maxJudgeCalls: 1,
  });
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function runOnce() {
  const manifest = JSON.parse(await readFile('harnesses/jev-v1/harness.json', 'utf8'));
  const jev = manifest.models.main;
  const upstreams = { [jev]: { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, key: 'jev-key', costIn: manifest.providers[jev].costIn } };
  const system = sandboxedSystem(manifest.name, tsx(join('harnesses/jev-v1', manifest.entry)),
    { main: jev, safety: jev }, manifest.suites, manifest.maxCalls, upstreams);
  const [record] = await runSuite({ runId: 'jev', cases, systems: [system], graders, proxy, judgeFor: () => 'unused', repetitions: 1 });
  return { record, manifest };
}

describe('jev-v1 (two-stage jev evidence selection)', () => {
  it('should score passages, grow into the moderate neighbour, score sentences, and emit the gold sentence', async () => {
    seen.length = 0;
    const { record, manifest } = await runOnce();
    assert.equal(record.status, 'ok', record.run.error);
    assert.deepEqual(record.grades.map((g) => `${g.grader}:${g.score}`), ['rag-recall:1', 'rag-precision:1']);
    assert.deepEqual(JSON.parse(record.run.output), [{ file_path: 'msa.txt', quote: GOLD }]);

    // one passage batch for a document this small, then one sentence request; no chat call
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => s.url.endsWith('/systemone') && s.auth === 'Bearer jev-key' && s.body.model === manifest.models.main));
    assert.equal(record.run.modelCalls, 2);
    assert.equal(record.run.tokensIn, 2000);
    assert.equal(record.run.costUsd, (2000 * manifest.providers[manifest.models.main].costIn) / 1e6);
    assert.deepEqual(record.run.models, [manifest.models.main]);

    // stage 1: a noul per passage over the whole document
    const passages: { [id: string]: string } = seen[0].body.state.passages;
    assert.equal(Object.values(passages).join(''), TEXT, 'the passages cover the document exactly');
    assert.deepEqual(Object.keys(seen[0].body.questions), Object.keys(passages));
    // stage 2: the clause passage and its moderate neighbour (section 9), sentence by sentence
    const stage2 = seen[1].body.state;
    assert.equal(Object.keys(stage2.passages).length, 1, 'clause and neighbour merged into one passage');
    assert.ok(stage2.passages.p0.includes('Term and Termination') && stage2.passages.p0.includes('Section 9.'));
    assert.ok(!stage2.passages.p0.includes('Section 10.'), 'expansion stops at the neighbour');
    assert.ok(!stage2.passages.p0.includes('Section 6.'), 'the section before scored too low to join');
    assert.ok(Object.values(stage2.sentences as { [k: string]: string }).some((s) => s.includes(GOLD)));

    const stages = record.run.trace!.stages;
    assert.deepEqual(stages.map((s) => `${s.name}:${s.mode}:${s.decision}`), [
      'chunk:regex:pass', 'jev-passages:llm:modified', 'jev-sentences:llm:modified', 'emit:regex:pass',
    ]);
    assert.ok(stages[1].findings.some((f) => f.endsWith('(neighbour)')));
    // the heading "Term and Termination." scored high but is not part of the answer
    assert.ok(stages[2].findings.some((f) => f.includes('dropped heading "Term and Termination."')));
  });

  it('should retry a transient upstream failure and still answer', async () => {
    seen.length = 0;
    failFirst = true;
    const { record } = await runOnce();
    assert.equal(record.status, 'ok', record.run.error);
    assert.deepEqual(JSON.parse(record.run.output), [{ file_path: 'msa.txt', quote: GOLD }]);
    // the failed attempt is a call the proxy counted too
    assert.equal(seen.length, 3);
    assert.equal(record.run.modelCalls, 3);
  });
});
