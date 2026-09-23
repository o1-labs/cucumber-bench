# Retrieval-assisted review development experiment

This plan connects the local retrieval study to the answer-and-citation benchmark without
pretending that retrieval coverage is answer quality. The generated run receipt and report,
not this document, remain the source of truth for what actually ran.

## Decision

Can a deployable retrieval stage reduce the full-document review harness's model work while
preserving clause recall, clause precision, and citation support on `cuad-hard-dev`?

This is a development decision only. The treatment is not eligible for `cuad-hard` until its
implementation and development result have been reviewed and frozen.

## Comparable lanes

| Lane | System | Role |
| --- | --- | --- |
| Control | `review-v1` | Exhaustively scans every passage before compose and citation check. |
| Treatment | `review-bm25-v1` | Selects bounded context with BM25, then uses the same scan, compose, and citation-check module. |

Both lanes use `qwen/qwen3.6-35b-a3b`, temperature 0, the same cases, examples, graders,
repetitions, provider, and runner. The shared review module keeps the post-retrieval prompts
and citation checks aligned. The intentional difference is which passages enter the scan.

## Frozen treatment

For each public case, the treatment:

1. extracts the question before `Document [1]`;
2. ranks passage text with BM25 (`k1 = 1.2`, `b = 0.75`);
3. keeps the top five passages;
4. considers the immediate previous and next passage in seed-rank order;
5. skips a neighbor that would take the selection above 3,000 whitespace-delimited words;
6. restores document order while preserving the original passage numbers;
7. scans only the selected passages, composes only from verified verbatim quotes, and checks
   every cited sentence against its original passages;
8. if the selected passages yield no verified quote, scans every remaining passage before
   composing, so an absence answer is based on the complete contract.

The trace records seed passage numbers, selected passage count, word count, scan-call count,
fallback use, quotes, and citation-check decisions. With at most 15 selected passages, a
positive retrieval path needs at most three scan calls; `review-v1` needs up to 21 for a
104-passage development contract. A no-quote path is deliberately slower because it scans
the remainder before making an exhaustive absence claim.

## Why BM25 is the first integrated adapter

The local study's BGE-M3 and reranker weights require a separate Python runtime and several
gigabytes of model storage. The isolated harness currently has a 1 GiB memory limit. Bundling
that stack into this lane would change retrieval, deployment footprint, memory, startup time,
and review behavior at once.

BM25 is dependency-free, deterministic, and small enough to run inside the existing sandbox.
This experiment therefore isolates the value and cost of retrieval-assisted review. A dense
or hybrid adapter is a follow-up only after it has a reviewed lifecycle that preserves the
same selection interface and reports its resource cost.

## Metrics and development gates

The primary quality metric is mean `clause-recall`. `clause-precision` and
`citation-support` must not regress materially. Operational metrics are model calls, input
tokens, cost, latency, and run errors.

Development promotion requires all of the following:

- zero run or grader errors;
- every absence claim follows a complete scan, recorded in the trace;
- at least 40% fewer scan calls and model-input tokens than `review-v1`;
- no more than a five-point mean regression in clause recall, clause precision, or citation
  support;
- source-level review of every treatment loss and win;
- an uncertainty interval and an explicit warning that 15 cases are exploratory evidence.

If the treatment misses these gates, do not compensate by tuning on `cuad-hard`. Diagnose
candidate-generation misses separately from scan, compose, and citation-check failures.

## Run sequence

The repository owner runs benchmark commands after committing a clean revision.

```sh
npm test
npm run typecheck

# Positive fast path plus absence fallback plumbing and cost smoke test.
BENCH_SANDBOX=docker npm run bench -- --systems review-v1,review-bm25-v1 --cases cuad-hard-dev-100,cuad-hard-dev-102 --reps 1 --concurrency 1

# Development comparison. This is not a locked-test run.
BENCH_SANDBOX=docker npm run bench -- --systems review-v1,review-bm25-v1 --suites cuad-hard-dev --reps 3 --concurrency 2
```

Review `run.json` before interpreting the report: it must show a clean commit, both systems,
the same model and provider, temperature 0, 15 cases, three repetitions, and the expected
90 records. Keep the resulting directory ignored and unpinned while tuning.

## Follow-up boundary

If BM25-assisted review passes the development gates, freeze it before considering a dense
adapter. If quality fails because relevant clauses never enter the candidate set, evaluate
contextual indexing or query expansion. If relevant clauses enter the candidate set but the
scan misses them, improve the scan/reranking stage instead. Do not change both in one
comparison.

The fallback currently triggers only when retrieval yields zero verified quotes. A partial
hit on a multi-instance question does not prove that every instance was found and does not
trigger fallback. Treat any resulting clause-recall loss as a known design limitation, not
as model noise.
