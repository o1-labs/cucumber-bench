# lb2-custom: evidence before the answer

The custom harness for LongBench v2 (version 10, prompt `+custom/10`). It answers a multiple-choice
question over one long document with the same model and the same answer form as the baseline
`lb2-direct`, so the grader `mc-answer` reads both alike. The difference to the baseline is what
the model sees next to the document: verbatim passages collected from the text, checked by the
harness, laid out in document order.

## The approach

The baseline reads once and concludes. Its failures on the dev set were of four kinds: facts spread
over the text were not aggregated, a qualifier in the question was read past, options that differ
in one clause were confused, and a lookup was asserted rather than made. The harness collects the
passages that bear on the question before the answer call, so the aggregation, the lookup and the
qualifier are on the page when the model decides. Everything the model sees of the text is either
the text itself or a verbatim span of it: no summary, no paraphrase, no judgment of the harness.

Single-turn calls only. The model loops on short multi-turn command replies (see `lb2-nav`), and
it does not loop on a single call that reads and answers.

## The stages

1. **Frame**, one call, no document, reasoning off. The model writes what the question requires
   (its constraints: who, when, according to which source, which part of the text) and the terms
   to look for (names, terms, numbers). `frame.ts` parses the two sections.
2. **Locate**, no model. The document is cut into chunks of `chunkTokens` (4,096) at line
   boundaries; every chunk keeps its offset. The chunks are ranked against the question, the
   choices and the framed terms with the BM25 formula; the best `topChunks` (64) are selected, or
   every chunk when there are at most 64, which the trace calls a complete scan.
3. **Extract**, one call per selected chunk, eight in flight, reasoning off. The prompt carries the
   question, the choices and the constraints. The model quotes the passages that bear on the
   question or on a choice, one per line, tagged with the choice it supports or contradicts. A
   quote is kept only when it is found in the chunk (whitespace and quote marks matched loosely),
   with its offsets; a quote wrapped over several reply lines is joined; a quote with an ellipsis
   is looked up as its pieces; at most `quotesPerChunk` (12) per chunk. The lines that contain a
   framed term join the quotes, found by the harness alone with one line of context, at most 12
   per term, a term on more than 40 lines skipped as too common. Quotes and hits are merged in
   document order; one inside another is dropped.
4. **Answer**, one call, reasoning on, the baseline's prompt. When `context` is `document+evidence`
   and the document fits the context, the passages follow the text; otherwise the passages are the
   text. The block is headed "Passages collected from the text, in order of appearance. Answer
   with one of the four letters even when no choice is fully shown." The tags never reach this
   call: they steer the answer when they do.

## What a run records

The trace keeps every reply: the frame, each scan under `--- scan chunk k ---` (so a dropped quote
can be read next to the text it failed to match), and the answer with its reasoning. The input
stage lists the frame counts, the chunk count, the selected chunks and whether the scan is
complete, the quotes kept and dropped, the term hits, the answer context and its budget, and the
frame and scan usage summed as "side usage", apart from the answer call's usage in the agent
stage. `transformedSource` is the passage block with the tags.

## Settings

`contextTokens` 262,144, `outputTokens` 16,384, `reasoning` on for the answer call and off for the
frame and scan calls, `chunkTokens` 4,096, `topChunks` 64, `quotesPerChunk` 12, `context`
`document+evidence`, `maxCalls` 150. The entry refuses options that name versions it does not
implement. It runs in the `cucumber-harness-lb2-direct` image, which holds the tokenizer.

## What it does not do

No document is skipped or truncated. No answer is re-asked or repaired. No embeddings, no
reranking, no second model. No second reading of the text before or after the answer: a verify
call without the document (version 2), one check call per choice (5), a challenge of the drafted
answer with a decision call (7, 8) and notes for and against each choice before any draft (9) were
each measured on chosen cases or on the dev set and removed. In every form the model kept its
first reading, at up to twice the cost. Version 10 is the version 6 pipeline.

## Measured so far

On the 30-case dev set, one repetition per version: 13 to 14 right of the 27 cases the baseline
can take, against 12, 12 and 13 for the baseline over three runs, which is inside the baseline's
own run-to-run noise of 4 letter flips. Two or three of the three long documents right in every
version, where the baseline answers none. One invalid answer in four runs against about one in 30
for the baseline. About $0.03 per case, twice the baseline. The results table and the negative
results are in `docs/LONGBENCH-V2.md`.
