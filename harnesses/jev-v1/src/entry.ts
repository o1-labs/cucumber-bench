import { readInput, respond } from '../../lib.js';
import type { Stage } from '../../../src/types.js';
import {
  chunk, buildNouls, buildSentenceNouls, select, expand, sentenceSpans, trimmed, mergeAdjacent, spansAsQuotes,
  THRESHOLD, NEIGHBOUR_THRESHOLD, SENTENCE_THRESHOLD, FLOOR_KEEP, MAX_SELECTED_CHARS, type Chunk,
} from './pipeline.js';

// jev-v1: evidence selection without generation. code cuts each document into clause-sized
// passages with their character offsets; jev scores every passage against the question
// (one noul per passage, many passages per request); the selection grows into neighbouring
// passages that score moderately, so a long clause comes in whole; then jev scores every
// sentence of the selected passages in its context, and the sentences that pass are the
// quotes. every quote is a slice of the document, so the output is always verbatim json.

// one jev request holds this many passages: well inside the 32k-token state budget, and
// small enough that unrelated passages do not crowd out the relevant one
const BATCH_CHUNKS = 60;
const BATCH_CHARS = 60_000;
const JEV_CONCURRENCY = 4;

const { publicCase: c, proxyUrl, token, models } = await readInput();
try {
  const docs = new Map((c.docs ?? []).map((d) => [d.title, d.text]));
  if (docs.size === 0) throw Error('jev-v1 needs at least one document');

  const chunks = [...docs].flatMap(([file_path, text], d) => chunk(file_path, text, d));
  const stages: Stage[] = [
    { name: 'chunk', module: 'sentence-chunker', version: '1', mode: 'regex', findings: [`chunks:${chunks.length}`], decision: 'pass' },
  ];

  // stage 1: passages
  await scorePassages(chunks);
  const seeds = select(chunks);
  const selected = expand(chunks, seeds);
  const passages = mergeAdjacent(selected);
  stages.push({
    name: 'jev-passages', module: 'typesafe-noul', version: '2',
    policy: `threshold=${THRESHOLD},neighbour=${NEIGHBOUR_THRESHOLD},floorKeep=${FLOOR_KEEP},maxChars=${MAX_SELECTED_CHARS}`,
    mode: 'llm', findings: selected.map((ch) => `${ch.id}:${ch.noul.toFixed(2)}${seeds.includes(ch) ? '' : ' (neighbour)'}`), decision: 'modified',
  });

  // stage 2: sentences of the selected passages, each read in its passage
  const sents = sentenceSpans(passages, docs);
  const answers = await askJev({
    question: c.input,
    passages: Object.fromEntries(passages.map((p, i) => [`p${i}`, p.text])),
    sentences: Object.fromEntries(sents.map((s) => [s.id, s.text])),
  }, buildSentenceNouls(sents), sents.map((s) => s.id));
  for (const s of sents) s.noul = answers[s.id];
  let kept = sents.filter((s) => s.noul >= SENTENCE_THRESHOLD);
  if (kept.length === 0) kept = [...sents].sort((a, b) => b.noul - a.noul).slice(0, 1);
  stages.push({
    name: 'jev-sentences', module: 'typesafe-noul', version: '1', policy: `threshold=${SENTENCE_THRESHOLD}`,
    mode: 'llm', findings: kept.map((s) => `${s.id}:${s.noul.toFixed(2)}`), decision: 'modified',
  });

  const findings: string[] = [];
  const quotes = spansAsQuotes(mergeAdjacent(kept).map(trimmed), docs, findings);
  const output = JSON.stringify(quotes);
  stages.push({ name: 'emit', module: 'verbatim-spans', version: '1', mode: 'regex', findings, decision: 'pass' });

  const passageLines = passages.map((p) => JSON.stringify({ file_path: p.file_path, text: p.text })).join('\n');
  respond({ output, trace: { source: c.input, transformedSource: passageLines, rawOutput: output, releasedOutput: output, stages } });
} catch (error) {
  respond({ error: String(error instanceof Error ? error.message : error) });
}

// one noul per passage, batched: every question in a request sees the same state and is
// answered in parallel. the noul lands on the chunk
async function scorePassages(chunks: Chunk[]): Promise<void> {
  const batches: Chunk[][] = [];
  let batch: Chunk[] = [];
  let chars = 0;
  for (const ch of chunks) {
    if (batch.length > 0 && (batch.length >= BATCH_CHUNKS || chars + ch.text.length > BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(ch);
    chars += ch.text.length;
  }
  if (batch.length > 0) batches.push(batch);

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const mine = batches[next++];
      const ids = mine.map((ch) => ch.id);
      const answers = await askJev({ question: c.input, passages: Object.fromEntries(mine.map((ch) => [ch.id, ch.text])) }, buildNouls(ids), ids);
      for (const ch of mine) ch.noul = answers[ch.id];
    }
  };
  await Promise.all(Array.from({ length: Math.min(JEV_CONCURRENCY, batches.length) }, worker));
}

// one system one request through the proxy: the nouls by question id
async function askJev(state: unknown, questions: unknown, ids: string[]): Promise<{ [id: string]: number }> {
  const body = JSON.stringify({ model: models.main, state, questions });
  let status = 0;
  let text = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    try {
      const res = await fetch(`${proxyUrl}/jev/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      status = 0;
      text = String(err instanceof Error ? err.message : err);
    }
    if (status >= 200 && status < 300) break;
    // the proxy's own 429 is the run's call limit: final. a network error, an upstream rate
    // limit (429), overload (529) or a server error is transient: back off and retry
    const transient = status === 0 || status === 429 || status === 529 || status >= 500;
    if (!transient || text.includes('exceeded the limit')) break;
  }
  if (status < 200 || status >= 300) throw Error(`jev call failed: ${status} ${text}`);
  const data: any = JSON.parse(text);
  const out: { [id: string]: number } = {};
  for (const id of ids) {
    const noul = data.answers?.[id]?.noul;
    if (typeof noul !== 'number') throw Error(`jev answer missing for ${id}`);
    out[id] = noul;
  }
  return out;
}
