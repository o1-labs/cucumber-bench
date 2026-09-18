import assert from 'node:assert/strict';
import { fieldsOf } from '../../src/gold.js';
import type { GradeResult, Grader, PublicCase, RunResult } from '../../src/types.js';

// LegalBench-RAG character precision/recall, ported from ZeroEntropy-AI/legalbenchrag
// run_benchmark.py at 431bc8f2488a81569ab7259fa633dcc50ab77f9a (MIT).
// Deviation: returned spans are merged when they overlap or touch, so duplicate or overlapping
// quotes cannot make precision or recall exceed 1.
export {
  graders,
  legalBenchRagGold,
  parseLegalBenchRagOutput,
  scoreLegalBenchRag,
  ragRecallGrader,
  ragPrecisionGrader,
  type LegalBenchRagGold,
  type LegalBenchRagScore,
  type ResolvedSnippet,
};

type ResolvedSnippet = { file_path: string; start: number; end: number };
type LegalBenchRagGold = { snippets: ResolvedSnippet[] };
type LegalBenchRagScore = { precision: number; recall: number; detail: string };
type ParsedOutput = { ok: true; snippets: ResolvedSnippet[] } | { ok: false; detail: string };

function ragRecallGrader(): Grader<LegalBenchRagGold> {
  return {
    name: 'rag-recall',
    description: 'Returned verbatim quotes cover the gold LegalBench-RAG character spans. The score is character recall.',
    gold: legalBenchRagGold,
    async grade(pub, gold, result) {
      let parsed = parseLegalBenchRagOutput(pub, result.output);
      if (!parsed.ok) return invalid('rag-recall', parsed.detail);
      let scored = scoreLegalBenchRag(gold.snippets, parsed.snippets);
      return {
        grader: 'rag-recall',
        pass: scored.recall === 1,
        score: scored.recall,
        detail: scored.detail,
      };
    },
  };
}

function ragPrecisionGrader(): Grader<LegalBenchRagGold> {
  return {
    name: 'rag-precision',
    description: 'Returned verbatim quotes are inside the gold LegalBench-RAG character spans. The score is character precision.',
    gold: legalBenchRagGold,
    async grade(pub, gold, result) {
      let parsed = parseLegalBenchRagOutput(pub, result.output);
      if (!parsed.ok) return invalid('rag-precision', parsed.detail);
      let scored = scoreLegalBenchRag(gold.snippets, parsed.snippets);
      return {
        grader: 'rag-precision',
        pass: scored.precision === 1,
        score: scored.precision,
        detail: scored.detail,
      };
    },
  };
}

let graders: Grader[] = [ragRecallGrader(), ragPrecisionGrader()];

function legalBenchRagGold(raw: unknown, id: string): LegalBenchRagGold {
  let { snippets } = fieldsOf(raw, id, 'legalbenchrag graders');
  assert(Array.isArray(snippets) && snippets.length > 0, `legalbenchrag graders: case ${id} needs nonempty snippets`);
  let checked = snippets.map((s, i) => {
    assert(
      s !== null &&
        typeof s === 'object' &&
        !Array.isArray(s) &&
        typeof (s as { file_path?: unknown }).file_path === 'string' &&
        ((s as { file_path: string }).file_path).length > 0 &&
        Array.isArray((s as { span?: unknown }).span) &&
        ((s as { span: unknown[] }).span).length === 2,
      `legalbenchrag graders: case ${id} snippet ${i} needs file_path and span`,
    );
    let file_path = (s as { file_path: string }).file_path;
    let [rawStart, rawEnd] = (s as { span: unknown[] }).span;
    assert(
      typeof rawStart === 'number' && typeof rawEnd === 'number' && Number.isInteger(rawStart) && Number.isInteger(rawEnd) && rawStart >= 0 && rawEnd > rawStart,
      `legalbenchrag graders: case ${id} snippet ${i} needs a valid nonempty [start,end] span`,
    );
    let start = rawStart;
    let end = rawEnd;
    return { file_path, start, end } as ResolvedSnippet;
  });
  validateDisjointNonAdjacent(checked, id);
  return { snippets: checked };
}

function parseLegalBenchRagOutput(pub: PublicCase, output: string): ParsedOutput {
  let docs = docsByTitle(pub);
  let json = stripJsonFence(output.trim());
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { ok: false, detail: `invalid JSON output: ${(err as Error).message}` };
  }
  if (!Array.isArray(value)) return { ok: false, detail: 'output must be a JSON array' };
  let snippets: ResolvedSnippet[] = [];
  for (let i = 0; i < value.length; i++) {
    let item = value[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, detail: `item ${i} must be an object` };
    let { file_path, quote, occurrence, span } = item as { file_path?: unknown; quote?: unknown; occurrence?: unknown; span?: unknown };
    if (span !== undefined) return { ok: false, detail: `item ${i} uses span output; LegalBench-RAG output must use verbatim quote` };
    if (typeof file_path !== 'string' || file_path.length === 0) return { ok: false, detail: `item ${i} needs file_path` };
    if (typeof quote !== 'string' || quote.length === 0) return { ok: false, detail: `item ${i} needs a nonempty quote` };
    if (!docs.has(file_path)) return { ok: false, detail: `item ${i} names unknown file_path ${file_path}` };
    let occurrenceIndex: number | undefined;
    if (occurrence !== undefined) {
      if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0) {
        return { ok: false, detail: `item ${i} occurrence must be a 0-based integer` };
      }
      occurrenceIndex = occurrence;
    }
    let matches = exactMatches(docs.get(file_path)!, quote);
    if (matches.length === 0) return { ok: false, detail: `item ${i} quote is not verbatim in ${file_path}` };
    if (occurrenceIndex === undefined && matches.length > 1) return { ok: false, detail: `item ${i} quote appears ${matches.length} times in ${file_path}; add occurrence` };
    let match = matches[occurrenceIndex === undefined ? 0 : occurrenceIndex];
    if (!match) return { ok: false, detail: `item ${i} occurrence ${occurrenceIndex} is out of range for ${file_path}` };
    snippets.push({ file_path, start: match.start, end: match.end });
  }
  return { ok: true, snippets };
}

function scoreLegalBenchRag(gold: ResolvedSnippet[], returned: ResolvedSnippet[]): LegalBenchRagScore {
  let mergedReturned = mergeRanges(returned);
  let overlap = pairwiseIntersection(gold, mergedReturned);
  let goldLength = totalLength(gold);
  let returnedLength = totalLength(mergedReturned);
  let precision = returnedLength === 0 ? 0 : overlap / returnedLength;
  let recall = goldLength === 0 ? 0 : overlap / goldLength;
  return {
    precision,
    recall,
    detail: `${overlap} overlapping chars; ${returnedLength} returned chars; ${goldLength} gold chars`,
  };
}

function invalid(grader: string, detail: string): GradeResult {
  return { grader, pass: false, score: 0, detail };
}

function docsByTitle(pub: PublicCase): Map<string, string> {
  assert(pub.docs && pub.docs.length > 0, `legalbenchrag graders: case ${pub.id} needs docs`);
  let docs = new Map<string, string>();
  for (let [i, doc] of pub.docs.entries()) {
    assert(typeof doc.title === 'string' && doc.title.length > 0, `legalbenchrag graders: case ${pub.id} doc ${i} needs title`);
    assert(typeof doc.text === 'string', `legalbenchrag graders: case ${pub.id} doc ${i} needs text`);
    assert(!docs.has(doc.title), `legalbenchrag graders: case ${pub.id} has duplicate doc title ${doc.title}`);
    docs.set(doc.title, doc.text);
  }
  return docs;
}

function stripJsonFence(output: string): string {
  let fenced = output.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1].trim() : output;
}

function exactMatches(text: string, quote: string): ResolvedSnippet[] {
  let matches: ResolvedSnippet[] = [];
  let from = 0;
  while (from <= text.length) {
    let index = text.indexOf(quote, from);
    if (index < 0) break;
    let start = codePointLength(text.slice(0, index));
    let end = start + codePointLength(quote);
    matches.push({ file_path: '', start, end });
    from = index + Math.max(quote.length, 1);
  }
  return matches;
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

function validateDisjointNonAdjacent(snippets: ResolvedSnippet[], id: string): void {
  let byFile = groupByFile(snippets);
  for (let [file, ranges] of byFile) {
    let sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++) {
      assert(sorted[i - 1].end < sorted[i].start, `legalbenchrag graders: case ${id} has overlapping or adjacent gold spans in ${file}`);
    }
  }
}

function mergeRanges(snippets: ResolvedSnippet[]): ResolvedSnippet[] {
  let merged: ResolvedSnippet[] = [];
  for (let [file, ranges] of groupByFile(snippets)) {
    let sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let range of sorted) {
      let last = merged[merged.length - 1];
      if (last && last.file_path === file && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
  }
  return merged;
}

function pairwiseIntersection(gold: ResolvedSnippet[], returned: ResolvedSnippet[]): number {
  let total = 0;
  for (let g of gold) {
    for (let r of returned) {
      if (g.file_path !== r.file_path) continue;
      total += Math.max(0, Math.min(g.end, r.end) - Math.max(g.start, r.start));
    }
  }
  return total;
}

function totalLength(snippets: ResolvedSnippet[]): number {
  return snippets.reduce((sum, s) => sum + s.end - s.start, 0);
}

function groupByFile(snippets: ResolvedSnippet[]): Map<string, ResolvedSnippet[]> {
  let grouped = new Map<string, ResolvedSnippet[]>();
  for (let snippet of snippets) {
    let ranges = grouped.get(snippet.file_path) ?? [];
    ranges.push(snippet);
    grouped.set(snippet.file_path, ranges);
  }
  return grouped;
}
