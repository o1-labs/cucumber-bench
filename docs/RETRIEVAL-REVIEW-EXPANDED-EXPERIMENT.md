# Expanded retrieval-assisted review development experiment

This follow-up is registered after `review-bm25-v1` failed its quality gates. It preserves
that treatment and changes only the candidate-selection policy. The generated run receipt
and report, not this document, remain the source of truth for what actually ran.

## Decision

Can a wider BM25 candidate set recover the quality lost by the 3,000-word treatment while
retaining a meaningful reduction in model work relative to full-document review?

This is a development decision on `cuad-hard-dev`. The treatment is ineligible for the
locked `cuad-hard` suite until its implementation and development result have been reviewed
and frozen.

## Comparable lanes

| Lane | System | Role |
| --- | --- | --- |
| Control | `review-v1` | Exhaustively scans every passage. |
| Treatment | `review-bm25-expanded-v1` | Scans an expanded BM25 candidate set, with the same compose and citation-check stages. |

Both lanes use `qwen/qwen3.6-35b-a3b`, temperature 0, the same provider, cases, examples,
graders, repetitions, and runner. They share the model adapter and review module. Candidate
selection is the only intentional difference.

## Frozen treatment

For each public case, the treatment:

1. extracts the question before `Document [1]`;
2. ranks passage text with the existing BM25 implementation (`k1 = 1.2`, `b = 0.75`);
3. keeps the top ten passages;
4. considers each seed's immediate previous and next passage in seed-rank order;
5. skips a neighbor that would take the selection above 6,000 whitespace-delimited words;
6. restores document order and preserves original passage numbers;
7. runs the unchanged scan, compose, and citation-check stages;
8. scans every remaining passage before an absence claim when the candidate scan yields no
   verified quote.

The trace records the policy, seed limit, radius, budget, seed passage IDs, complete selected
passage IDs, and word counts as structured metadata. Existing trace findings record fallback,
quotes, and citation-check decisions. The earlier `review-bm25-v1` policy remains five seeds,
radius one, and 3,000 words.

## Why this treatment

The frozen treatment selected 11 of 20 unique relevant passage locations in the positive
development cases: complete coverage in six cases, partial in three, and none in two. An
offline sensitivity diagnostic on the same development cases found that ten seeds plus
neighbors under 6,000 words selected 16 of 20 locations: complete coverage in nine cases,
partial in two, and none in zero. Average selected context increased from 2,666 to 5,052
words.

Those numbers motivate this treatment but do not validate it: they use the same 15-case
development set and say nothing about scan, answer, or citation quality. The parameters are
frozen here before the answer-level run. Do not tune them against `cuad-hard`.

## Metrics and development gates

The primary metric is mean `clause-recall`; `clause-precision` and `citation-support` are
co-equal non-regression metrics. Operational metrics are scan calls, model-input tokens,
cost, latency, fallback rate, and run errors.

Promotion requires all of the following:

- zero run or grader errors;
- every absence claim follows a complete scan recorded in the trace;
- at least 20% fewer scan calls, model-input tokens, and harness cost than `review-v1`;
- no more than a five-point mean regression in clause recall, clause precision, or citation
  support;
- source-level review of every treatment loss and win;
- an uncertainty interval and an explicit warning that 15 cases are exploratory evidence.

The lower 20% efficiency threshold is declared before the run because the candidate word
budget intentionally doubled to address the observed coverage failure. If the treatment
misses any gate, keep it development-only and diagnose candidate coverage separately from
scan, compose, and citation checking.

## Run sequence

The repository owner runs benchmark commands after reviewing the change and committing a
clean revision.

```sh
npm test
npm run typecheck
npm run sandbox:build

# Positive retrieval, exhaustive absence, and known partial-coverage plumbing.
BENCH_SANDBOX=docker npm run bench -- \
  --systems review-v1,review-bm25-expanded-v1 \
  --cases cuad-hard-dev-100,cuad-hard-dev-102,cuad-hard-dev-111 \
  --reps 1 \
  --concurrency 1

# Development comparison. This is not a locked-test run.
BENCH_SANDBOX=docker npm run bench -- \
  --systems review-v1,review-bm25-expanded-v1 \
  --suites cuad-hard-dev \
  --reps 3 \
  --concurrency 2
```

The smoke receipt must contain six records; the full receipt must contain 90. Both must show
a clean commit, Docker isolation, the same model and provider for both lanes, temperature 0,
and the configured cases and repetitions. Keep development runs ignored and unpinned.

## Development result: 2026-09-23

Run `2026-09-23T08-15-38-571Z` compared the two lanes on all 15 `cuad-hard-dev`
cases with three repetitions. The receipt recorded a clean commit, Docker isolation,
temperature 0, 90/90 records, `qwen/qwen3.6-35b-a3b` for both lanes, and
`deepseek/deepseek-v4-flash-0731` as judge. All 90 runs completed without a sandbox or
grader error. This remains development evidence from 15 independent cases, not a locked-test
claim; the three repetitions measure run variability rather than increasing the case count.

| Measure | Full review | Expanded BM25 | Treatment difference |
| --- | ---: | ---: | ---: |
| Mean clause recall | 72.2% | 69.6% | −2.6 points |
| Mean clause precision | 78.7% | 80.6% | +1.9 points |
| Mean citation support | 90.0% | 96.7% | +6.7 points |
| Scan calls per run | 9.00 | 5.78 | −35.8% |
| Model input tokens per run | 20,293 | 13,177 | −35.1% |
| Total model calls per run | 11.73 | 8.67 | −26.1% |
| Harness cost per run | $0.0192 | $0.0138 | −28.1% |
| Latency per run | 73.1 s | 76.6 s | +4.7% |
| Run or grader errors | 0/45 | 0/45 | no change |

The paired 95% intervals all included zero: full review minus expanded BM25 was
`+3 [−4, +9]` points for recall, `−2 [−11, +7]` for precision, and
`−7 [−16, 0]` for citation support. The run therefore does not establish a quality
difference. The treatment does pass the declared development thresholds for scan calls,
input tokens, harness cost, errors, and mean-score non-regression.

Trace review preserved the earlier candidate-coverage diagnosis: the expanded policy selected
16 of 20 unique relevant development locations, with complete coverage in nine positive
cases and partial coverage in two. The remaining failures are not retrieval-only. The scanner
can miss a relevant clause even when its passage is selected, and an incorrect partial quote
can still suppress the exhaustive fallback. Citation-support gains also require caution: an
unsupported absence answer can pass citation support while failing clause recall.

The treatment is therefore an efficiency candidate, not an accuracy improvement. Freeze this
policy rather than tuning it again on the same development cases. It may proceed to review for
a single locked comparison only after the implementation and experiment result are accepted.

## Stop conditions

Do not compensate for a failed result by changing the graders, cases, full-review control,
or locked suite. If candidate coverage is adequate but the scan misses a clause, the next
experiment belongs at the scan seam. If coverage remains inadequate, compare another
retrieval adapter behind the same selection interface rather than changing the review
pipeline at the same time.
