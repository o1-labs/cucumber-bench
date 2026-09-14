// the pure part of lb2-custom: cutting a document into chunks with their offsets, ranking the
// chunks against the question's terms, checking the scan model's quotes against their chunk, and
// laying the evidence out for the answer call. no model, no io: a test brings a toy tokenizer
import assert from 'node:assert/strict';
import type { Tok } from '../../lb2-direct/src/tokenizer.js';

export { chunkDocument, rankChunks, parseQuotes, termHits, mergeQuotes, formatEvidence, NO_EVIDENCE, type Chunk, type Quote };

type Chunk = { index: number; start: number; text: string; tokens: number }; // index from 1; start: offset in the document
type Quote = { chunk: number; tag: string; text: string; start: number; end: number }; // tag: A+ .. D-, or ?; text = doc.slice(start, end)

const NO_EVIDENCE = 'No passage of the text was found to bear on the question or the choices.';
// a line of the scan answer: an optional bullet, the tag, an optional separator, the quote
const LINE_RE = /^\s*(?:[-*•]\s*)?[\[(]?([A-D][+-]|\?)[\])]?\s*[:.)-]?\s*(.+?)\s*$/;
// bm25 constants (Robertson et al.): term saturation and length normalization
const K1 = 1.2;
const B = 0.75;

// pieces of at most size tokens, each a substring of the document at its offset, so a quote can
// be checked against the original text. a piece ends at a newline when it has one in its second
// half, so a paragraph is split as rarely as possible
function chunkDocument(tok: Tok, doc: string, size: number): Chunk[] {
  assert(size > 0, `chunkDocument: size must be positive, got ${size}`);
  let chunks: Chunk[] = [];
  let pos = 0;
  while (pos < doc.length) {
    // first guess by characters, then shrink until the piece fits the token budget
    let end = Math.min(doc.length, pos + size * 4);
    let tokens = tok.encode(doc.slice(pos, end)).length;
    while (tokens > size) {
      // proportionally, and always by at least one character, so the loop ends
      let next = pos + Math.floor(((end - pos) * size) / tokens);
      end = Math.max(pos + 1, Math.min(next, end - 1));
      tokens = tok.encode(doc.slice(pos, end)).length;
    }
    if (end < doc.length) {
      let nl = doc.lastIndexOf('\n', end - 1);
      if (nl > pos + (end - pos) / 2) {
        end = nl + 1;
        tokens = tok.encode(doc.slice(pos, end)).length;
      }
    }
    chunks.push({ index: chunks.length + 1, start: pos, text: doc.slice(pos, end), tokens });
    pos = end;
  }
  return chunks;
}

// the k chunks that score highest against the query's terms (bm25 over the chunks as documents),
// in document order; every chunk when there are at most k. a term that is in every chunk scores
// nothing, so common words need no stop list
function rankChunks(chunks: Chunk[], query: string, k: number): Chunk[] {
  assert(k > 0, `rankChunks: k must be positive, got ${k}`);
  if (chunks.length <= k) return chunks;
  let docs = chunks.map((c) => words(c.text));
  let avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  let terms = [...new Set(words(query))];
  let scores = chunks.map((_, i) => {
    let counts = new Map<string, number>();
    for (let w of docs[i]) counts.set(w, (counts.get(w) ?? 0) + 1);
    let score = 0;
    for (let t of terms) {
      let tf = counts.get(t) ?? 0;
      if (tf === 0) continue;
      let df = docs.filter((d) => d.includes(t)).length;
      let idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * docs[i].length) / avg)));
    }
    return { i, score };
  });
  let top = scores.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k).map((s) => s.i).sort((a, b) => a - b);
  return top.map((i) => chunks[i]);
}

// the quotes of one scan answer that are in the chunk word for word (whitespace and quote marks
// aside), with their offsets in the document, at most cap of them; the rest is dropped and
// counted. a line without a tag continues the quote before it (the model wraps long quotes as
// the text is wrapped); a quote with an ellipsis is looked up as its pieces. "None" is no evidence
function parseQuotes(answer: string, chunk: Chunk, cap: number): { quotes: Quote[]; dropped: number } {
  let quotes: Quote[] = [];
  let dropped = 0;
  if (/^\s*none\b/i.test(answer)) return { quotes, dropped };
  let items: { tag: string; text: string }[] = [];
  for (let line of answer.split('\n')) {
    if (!line.trim()) continue;
    let m = line.match(LINE_RE);
    if (m) items.push({ tag: m[1], text: m[2] });
    else if (items.length) items[items.length - 1].text += ` ${line.trim()}`;
  }
  for (let { tag, text } of items) {
    text = text.replace(/^["“]|["”]$/g, '').trim();
    if (!text || /^none$/i.test(text)) {
      dropped++;
      continue;
    }
    let pieces = locate(chunk.text, text) ? [text] : text.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.split(/\s+/).length >= 3);
    let found = pieces.map((piece) => locate(chunk.text, piece)).filter((at) => at !== undefined);
    if (found.length === 0) {
      dropped++;
      continue;
    }
    for (let at of found) {
      if (quotes.length >= cap) return { quotes, dropped };
      quotes.push({ chunk: chunk.index, tag, text: chunk.text.slice(at.start, at.end), start: chunk.start + at.start, end: chunk.start + at.end });
    }
  }
  return { quotes, dropped };
}

// the lines of the document that contain a term (case-insensitive, whitespace collapsed), each
// with the line before and after it, as quotes tagged "?" with their offsets; at most perTerm per
// term, in document order. a term on more than maxLines lines is too common to be a lookup and is
// skipped; the skipped terms are returned. no model: a hit is in the text by construction
function termHits(doc: string, chunks: Chunk[], terms: string[], perTerm: number, maxLines: number): { quotes: Quote[]; skipped: string[] } {
  let starts: number[] = [0];
  for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') starts.push(i + 1);
  let lines = doc.split('\n');
  let quotes: Quote[] = [];
  let skipped: string[] = [];
  for (let term of terms) {
    let needle = normalize(term);
    if (needle.length < 2) continue;
    let hits: number[] = [];
    for (let i = 0; i < lines.length && hits.length <= maxLines; i++) if (normalize(lines[i]).includes(needle)) hits.push(i);
    if (hits.length > maxLines) {
      skipped.push(term);
      continue;
    }
    for (let i of hits.slice(0, perTerm)) {
      let from = Math.max(0, i - 1);
      let to = Math.min(lines.length - 1, i + 1);
      let start = starts[from];
      let end = starts[to] + lines[to].length;
      let chunk = 1;
      for (let c of chunks) if (c.start <= start) chunk = c.index;
      quotes.push({ chunk, tag: '?', text: doc.slice(start, end).trim(), start, end });
    }
  }
  return { quotes, skipped };
}

// the quotes in document order, a quote inside or across one already there dropped
function mergeQuotes(...lists: Quote[][]): Quote[] {
  let all = lists.flat().sort((a, b) => a.start - b.start || b.end - a.end);
  let out: Quote[] = [];
  for (let q of all) {
    let last = out[out.length - 1];
    if (last && q.start < last.end) continue;
    out.push(q);
  }
  return out;
}

// the evidence block: one line per quote, in document order; the tags only in the record, since
// they are the scan model's judgment and steer the answer when it sees them
function formatEvidence(quotes: Quote[], chunks: number, tags = false): string {
  if (quotes.length === 0) return NO_EVIDENCE;
  return quotes.map((q) => `[chunk ${q.chunk} of ${chunks}] ${tags ? `(${q.tag}) ` : ''}"${q.text}"`).join('\n');
}

// internal helpers

function normalize(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

// where the quote is in the text, whitespace runs and quote marks matched loosely, case exact
function locate(text: string, quote: string): { start: number; end: number } | undefined {
  let pattern = quote
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/["“”]/g, '["“”]').replace(/['‘’]/g, "['‘’]"))
    .join('\\s+');
  let m = new RegExp(pattern).exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}
