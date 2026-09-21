// the pure parts of jev-v1: cutting a document into passages and sentences, the jev questions,
// selection and expansion, and spans as quotes. no io here, so a lab script can drive them
export {
  chunk, sentences, buildNouls, buildSentenceNouls, select, expand, sentenceSpans, headingLike, trimmed, mergeAdjacent, spansAsQuotes, occurrences,
  CHUNK_TARGET, CHUNK_MAX, CHUNK_MIN, THRESHOLD, NEIGHBOUR_THRESHOLD, SENTENCE_THRESHOLD, FLOOR_KEEP, MAX_SELECTED_CHARS,
  type Chunk, type Passage, type Quote, type Span, type Sentence,
};

// passage cutting: sentences are packed to about TARGET chars, never past MAX; a trailing
// piece under MIN joins its predecessor. gold spans are a few hundred chars, so this is the
// granularity that keeps precision possible
const CHUNK_TARGET = 400;
const CHUNK_MAX = 700;
const CHUNK_MIN = 120;
// stage 1 selection: passages at or above THRESHOLD seed the selection; a neighbour of a
// selected passage joins it from NEIGHBOUR_THRESHOLD, so a clause longer than one passage
// comes in whole (the middle of a long clause scores lower than its opening). when nothing
// clears the threshold, the top FLOOR_KEEP by noul, so the next stage always sees something;
// at most MAX_SELECTED_CHARS of text. tuned on 16 dev cases, 2026-09-21
const THRESHOLD = 0.7;
const NEIGHBOUR_THRESHOLD = 0.3;
const FLOOR_KEEP = 2;
const MAX_SELECTED_CHARS = 8000;
// stage 2: every sentence of the selected passages gets its own noul, with its passage as
// context; sentences from SENTENCE_THRESHOLD are the answer, at least the top one
const SENTENCE_THRESHOLD = 0.5;

type Span = { file_path: string; start: number; end: number; text: string };
type Chunk = Span & { id: string; noul: number };
type Passage = Span;
type Sentence = Span & { id: string; passage: string; noul: number };
type Quote = { file_path: string; quote: string; occurrence?: number };

// cut one document into passages. boundaries are newlines and sentence enders followed by
// whitespace; sentence pieces are packed greedily; a piece with no boundary inside MAX is
// split at whitespace. every passage is text.slice(start, end), so quotes stay verbatim
function chunk(file_path: string, text: string, docIndex: number, target = CHUNK_TARGET, max = CHUNK_MAX): Chunk[] {
  const spans: [number, number][] = [];
  let open: [number, number] | undefined;
  for (const [start, end] of sentences(text)) {
    for (const [s, e] of splitLong(text, start, end, max)) {
      if (open && (open[1] - open[0] >= target || e - open[0] > max)) {
        spans.push(open);
        open = undefined;
      }
      open = open ? [open[0], e] : [s, e];
    }
  }
  if (open) {
    const last = spans[spans.length - 1];
    if (last && open[1] - open[0] < CHUNK_MIN) last[1] = open[1];
    else spans.push(open);
  }
  return spans
    .filter(([s, e]) => text.slice(s, e).trim().length > 0)
    .map(([start, end], i) => ({ id: `d${docIndex}p${String(i).padStart(4, '0')}`, file_path, start, end, text: text.slice(start, end), noul: 0 }));
}

// sentence pieces of a text as [start, end) offsets: a boundary is a newline, or a sentence
// ender followed by whitespace. the pieces cover the text exactly
function sentences(text: string, from = 0, to = text.length): [number, number][] {
  const pieces: [number, number][] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    const boundary = ch === '\n' || ((ch === '.' || ch === '!' || ch === '?' || ch === ';') && /\s/.test(text[i + 1] ?? ' '));
    if (!boundary) continue;
    pieces.push([start, i + 1]);
    start = i + 1;
  }
  if (start < to) pieces.push([start, to]);
  return pieces;
}

// a piece longer than max (a long run without sentence enders) is split at whitespace
function splitLong(text: string, start: number, end: number, max: number): [number, number][] {
  const out: [number, number][] = [];
  let from = start;
  while (end - from > max) {
    let cut = text.lastIndexOf(' ', from + max);
    if (cut <= from) cut = from + max;
    out.push([from, cut]);
    from = cut;
  }
  out.push([from, end]);
  return out;
}

// one noul per span over a shared state: does `passages.<id>` answer `question`?
function buildNouls(ids: string[], field = 'passages') {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        type: 'noul',
        instructions: `Does the passage \`${field}.${id}\` contain text that answers \`question\`?`,
        criteria: {
          true: 'The passage itself states the specific term, condition, right, obligation, exception, or fact the question asks about.',
          false: 'The passage is unrelated, or only touches the topic without stating what the question asks about, or merely names the concept.',
        },
      },
    ]),
  );
}

// one noul per sentence, each read in its passage: does it state part of the answer?
function buildSentenceNouls(sents: { id: string; passage: string }[]) {
  return Object.fromEntries(
    sents.map((s) => [
      s.id,
      {
        type: 'noul',
        instructions: `Does the sentence \`sentences.${s.id}\`, read in its context \`passages.${s.passage}\`, state part of the answer to \`question\`?`,
        criteria: {
          true: 'The sentence states the specific term, condition, right, obligation, exception, or fact the question asks about, or is the heading or lead-in that the answer sentence depends on.',
          false: 'The sentence is surrounding context, boilerplate, or another topic, and the answer would be complete without it.',
        },
      },
    ]),
  );
}

// the sentences of the selected passages, each knowing its passage id
function sentenceSpans(passages: Passage[], docs: Map<string, string>): Sentence[] {
  const out: Sentence[] = [];
  passages.forEach((p, pi) => {
    const text = docs.get(p.file_path)!;
    for (const [start, end] of sentences(text, p.start, p.end)) {
      if (text.slice(start, end).trim().length === 0) continue;
      out.push({ id: `s${out.length}`, passage: `p${pi}`, file_path: p.file_path, start, end, text: text.slice(start, end), noul: 0 });
    }
  });
  return out;
}

// a seed selection grows into neighbouring chunks that score at least tNeighbour, until
// stable or maxChars is reached
function expand(chunks: Chunk[], seeds: Chunk[], tNeighbour = NEIGHBOUR_THRESHOLD, maxChars = MAX_SELECTED_CHARS): Chunk[] {
  const index = new Map(chunks.map((ch, i) => [ch.id, i]));
  const picked = new Set(seeds.map((ch) => ch.id));
  let chars = seeds.reduce((n, ch) => n + ch.text.length, 0);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...picked]) {
      const i = index.get(id)!;
      for (const neighbour of [chunks[i - 1], chunks[i + 1]]) {
        if (!neighbour || picked.has(neighbour.id) || neighbour.file_path !== chunks[i].file_path) continue;
        if (neighbour.noul < tNeighbour || chars + neighbour.text.length > maxChars) continue;
        picked.add(neighbour.id);
        chars += neighbour.text.length;
        grew = true;
      }
    }
  }
  return chunks.filter((ch) => picked.has(ch.id));
}

// a heading or a bare label: a short line like "ARTICLE II ASSIGNMENTS", "Section 2.1 Transferred
// IP." or "(b) Assignment of Assigned IP." jev passes these as lead-ins to the answer, but gold
// spans rarely include them, so they cost precision for nothing (+2 points on 42 dev cases)
function headingLike(span: Span): boolean {
  const t = span.text.trim();
  if (t.length >= 60) return false;
  return /^(ARTICLE|Article|SECTION|Section)\s+[\dIVX]/.test(t) || /^[A-Z][A-Za-z\s;,&-]{2,50}\.?$/.test(t) || /^\(?[a-z\d]{1,3}\)\s+[A-Z][A-Za-z\s;,&-]{2,40}\.$/.test(t);
}

// a span without its leading and trailing whitespace: the grader counts every character
function trimmed<T extends Span>(span: T): T {
  const lead = span.text.length - span.text.trimStart().length;
  const text = span.text.trim();
  return { ...span, start: span.start + lead, end: span.start + lead + text.length, text };
}

// the spans the next stage will see: above the threshold, or the top floorKeep when nothing
// is, at most maxChars, in document order
function select<T extends Chunk>(chunks: T[], threshold = THRESHOLD, floorKeep = FLOOR_KEEP, maxChars = MAX_SELECTED_CHARS): T[] {
  const ranked = [...chunks].sort((a, b) => b.noul - a.noul);
  let keep = ranked.filter((ch) => ch.noul >= threshold);
  if (keep.length === 0) keep = ranked.slice(0, floorKeep);
  const out: T[] = [];
  let chars = 0;
  for (const ch of keep) {
    if (out.length > 0 && chars + ch.text.length > maxChars) break;
    out.push(ch);
    chars += ch.text.length;
  }
  return out.sort((a, b) => a.file_path.localeCompare(b.file_path) || a.start - b.start);
}

// neighbouring selected spans become one passage, so a clause cut in two reads whole
function mergeAdjacent(selected: Span[]): Passage[] {
  const out: Passage[] = [];
  for (const ch of selected) {
    const last = out[out.length - 1];
    if (last && last.file_path === ch.file_path && last.end === ch.start) {
      last.end = ch.end;
      last.text += ch.text;
    } else out.push({ file_path: ch.file_path, start: ch.start, end: ch.end, text: ch.text });
  }
  return out;
}

// spans as quotes, with the occurrence index the grader needs when the text repeats
function spansAsQuotes(spans: Span[], docs: Map<string, string>, findings: string[] = []): Quote[] {
  return spans.map((p) => {
    const matches = occurrences(docs.get(p.file_path)!, p.text);
    if (matches.length === 1) return { file_path: p.file_path, quote: p.text };
    // a self-overlapping span may not be a scan match at its own start; the first is then the nearest
    const at = matches.indexOf(p.start);
    if (at < 0) findings.push(`span at ${p.start} is not a scan match; occurrence 0 used`);
    return { file_path: p.file_path, quote: p.text, occurrence: Math.max(at, 0) };
  });
}
// start indices of every non-overlapping match, as the grader counts them
function occurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    out.push(at);
    from = at + Math.max(quote.length, 1);
  }
  return out;
}
