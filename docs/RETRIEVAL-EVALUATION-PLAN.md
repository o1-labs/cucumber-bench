# Retrieval evaluation plan

Status: implemented. The implementation, tests, and methodology belong in one
pull request. Local development results remain under ignored `runs/` paths;
the locked test and any published benchmark claim are explicitly outside this
pull request.

Base: `o1-labs/cucumber-bench` `main` at
`dc1bdfed401008dd92c0e0c3b9b03712421151d7`, verified against `origin/main` on
2026-09-22.

Related work: pull request #5, `florian/long-context`, reviewed at
`9dd3b4ab1c04a00265e8d69a3477249623274cb0`. It remains independent of this
branch. This study reimplements only the small BM25 reference algorithm needed
for a controlled retrieval comparison; it does not copy PR #5's answer
generation pipeline.

## 1. Decision and scope

The product question is:

> At a fixed five-passage review budget, does semantic or hybrid retrieval find
> more annotated contract clauses than BM25 alone, and what latency and memory
> does that improvement cost?

For each long CUAD contract and clause question, the runner returns ten ranked
passage IDs. Quality is evaluated at ranks 1, 3, 5, and 10, while rank 5 is the
primary professional-review budget.

The development comparison contains four frozen lanes:

1. BM25 keyword retrieval;
2. BGE-M3 dense retrieval;
3. reciprocal-rank fusion of BM25 and dense retrieval; and
4. the hybrid candidate pool reordered by BGE reranker v2 M3.

This study measures evidence retrieval only. It does not generate an answer,
verify a citation, determine the legal meaning of a clause, establish that a
clause is absent, compare vector databases, or evaluate document parsing.
Those are later experiments and must not be mixed into this result.

## 2. How this fits cucumber-bench

cucumber-bench normally runs one sandboxed harness per case. A harness receives
public input, may call a guarded chat-model proxy, and returns an answer that is
graded against private gold. Each run records its configuration, case-level
results, aggregate report, latency, and cost.

Large local retrieval models have a different lifecycle. Loading BGE-M3 and the
reranker separately for each case would pay multi-gigabyte model startup at
least 15 times and make the latency result meaningless. Pretending they are
chat models would also make the receipt inaccurate.

The retrieval benchmark therefore uses a suite-scoped Python runner under
`experiments/cuad-retrieval/`:

```text
cuad-hard-dev public docs + query ----> one local model process
             private clause passages ----> deterministic metrics
                                             |
                                             v
                    run.json + results.jsonl + report.md + chart.html
```

The process loads each requested model once, executes every lane over the same
cases, and writes cucumber-style artifacts under `runs/`. It never calls a
hosted model, never uses provider credentials, and never gives private gold to
the retrieval code. The benchmark-specific orchestration is intentionally
isolated from the TypeScript chat-harness core.

## 3. Verified development corpus

The implementation reuses the committed `cuad-hard-dev` cases rather than
duplicating a second suite:

- 15 cases from 15 contracts;
- 11 positive and 4 clause-absence cases;
- 24 annotated clauses;
- 20 distinct annotated passages;
- 26 to 104 passages per case, mean 42.9;
- no development contract overlap with the locked `cuad-hard` split.

The runner validates the first four inventory values before doing model work.
It deterministically extracts the question from the existing public input and
converts the private zero-based passage indices to the public one-based IDs.
It hashes the exact public and private case bytes in the run receipt.

A tokenizer-only preflight resolved both pinned revisions and checked every
development input. BGE-M3 saw 658 query/passage inputs with a maximum of 1,531
tokens; the reranker saw 643 query/passage pairs with a maximum of 1,626
tokens. Neither had an input above the frozen 8,192-token limit. Both resolved
to the expected XLM-RoBERTa architecture with 8,194 configured positions.

The 100-case `cuad-hard` suite is locked. It must not be executed, inspected for
model selection, or added to the development command in this pull request.

## 4. Retrieval contract

The internal request contains only public information:

```python
RetrievalRequest(
    query: str,
    passages: tuple[Passage, ...],
    limit: int,
)
```

Every returned item contains a one-based passage ID, score, and any component
ranks needed for audit. Observable invariants are:

- exactly ten unique passage IDs per case and lane;
- IDs are within the public passage array;
- scores are finite;
- rank order is deterministic for equal scores;
- quality metrics are computed after retrieval from private gold;
- negative cases receive no retrieval-quality score.

Core ranking operations are pure and separately tested. `LocalModels` owns the
Hugging Face loading, batching, device placement, tokenization, and inference
boundary. That seam lets unit tests exercise ranking and metrics without model
downloads.

## 5. Frozen lanes

### BM25 control

- Unicode word tokenizer, lowercased;
- `k1 = 1.2`, `b = 0.75`;
- query terms de-duplicated;
- ties resolved by ascending passage ID;
- top 15 retained for fusion and top 10 recorded for the lane.

### BGE-M3 dense

- model `BAAI/bge-m3`;
- revision `5617a9f61b028005a4858fdac845db406aefb181`;
- MIT license recorded in the receipt;
- CLS pooling from the final hidden state;
- L2-normalized float32 vectors;
- dot product ranking, equivalent to cosine similarity after normalization;
- maximum sequence length 8,192;
- any truncation fails the run rather than silently changing the input;
- ties resolved by ascending passage ID;
- top 15 retained for fusion and top 10 recorded for the lane.

BGE-M3 also supports learned sparse and multi-vector retrieval. They are not
enabled here because they would add variables to the BM25-versus-dense question.

### Hybrid RRF

The union of the top 15 BM25 and top 15 dense results contains at most 30
passages. It is ranked with equal-weight reciprocal-rank fusion:

```text
score(p) = 1 / (60 + bm25_rank(p)) + 1 / (60 + dense_rank(p))
```

A missing component contributes zero. Ties use the best component rank and
then passage ID. The lane records the first ten. Raw BM25 and cosine scores are
not normalized or mixed because their scales have unrelated meanings.

### Hybrid plus reranker

- candidate set: the complete RRF union, at most 30 passages;
- model `BAAI/bge-reranker-v2-m3`;
- revision `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`;
- Apache-2.0 license recorded in the receipt;
- each `(query, passage)` pair scored together once;
- float32 inference and maximum sequence length 8,192;
- any truncation fails the run;
- equal scores retain hybrid order, then passage ID;
- first ten recorded.

The reranker is loaded only when this lane is requested. Dense-only experiments
must not pay its startup or memory cost.

## 6. Metrics and statistics

The primary metric is macro clause hit rate at five over the 11 positive
development cases. A clause is a hit when any one of its annotated passages is
in the first five. Clauses are averaged within a case and cases are then
averaged, preventing contracts with several annotations from dominating.

Secondary metrics are:

- clause hit rate at 1, 3, and 10;
- unique annotated-passage recall at 1, 3, 5, and 10;
- reciprocal rank of the first annotated passage;
- annotated-passage density in the first five.

Density is not called precision: CUAD does not annotate every passage that may
be useful background, a definition, or an exception.

The four absence cases remain in the run as operational diagnostics but are
excluded from retrieval quality. Returning a low-scoring top-k list cannot
prove that a clause is absent from the full contract.

Each non-control lane is compared with BM25 by paired document-level bootstrap
over clause hit@5. The seed is fixed at `20260830` and the report uses 10,000
resamples. With only 11 positive cases, the interval is expected to be wide;
the development result guides selection and is not a confirmatory claim.

## 7. Performance accounting

The runner separates:

- dense and reranker model-load time;
- passage encoding or BM25 indexing time per case;
- warm query, scoring, fusion, and reranking time;
- mean, p95, and maximum warm latency;
- peak process resident memory;
- errors and input truncations.

If a case fails, the runner writes one row for every requested lane for that
case before stopping. Unaffected lanes retain their valid result; affected
lanes carry an empty ranking, the truncation count when applicable, and a
structured error. The incomplete manifest records how many rows were written.

Model load is paid once per suite and is never divided into or hidden inside
per-query latency. The reference machine model and chip, Python version,
operating system, CPU count, total memory, device, dtype, batch size, and
sequence limit are captured in `run.json`.

The initial reference run uses Apple MPS on the declared machine. CPU is also a
supported explicit device, but CPU and MPS numbers must not be mixed in one
comparison.

## 8. Reproducibility and artifacts

`pyproject.toml` and `uv.lock` pin the Python 3.12 dependency graph. Model IDs
are paired with immutable revisions. Model weights stay in the Hugging Face
cache and are not committed.

One development command creates `runs/retrieval-<UTC timestamp>/` containing:

- `run.json`: schema, command, expected and completed record counts, case hash,
  Git revision and dirty files, dependency lock hash, model revisions,
  configuration, hardware, timings, peak RSS, and result hash;
- `results.jsonl`: one record per case and lane with rankings, component ranks,
  quality metrics, timing, truncations, and error field;
- `report.md`: development warning, aggregate table, paired intervals,
  performance table, adjacent-context replay, misses at five, and reproduction
  receipt.
- `chart.html`: a generated aggregate view for reviewing the same run without
  copying a hand-maintained report into public documentation.

The report is generated from case-level records. It is never hand-edited into
a more favorable result. The development run remains local, unpinned, and
non-reportable until review. No hand-maintained report or run data is copied
into the publicly served `docs/` directory.

The adjacent-context replay exposes the immediate previous and next passage
around each top-five seed, removes duplicates, and reports both clause coverage
and the resulting passage and word budget. It is a boundary diagnostic over
stored rankings, not a same-budget lane and not evidence that retrieval itself
improved.

## 9. One-pull-request implementation

All related changes belong in one reviewable pull request, in this order:

1. Add the local retrieval package, exact lockfile, and ignored local caches.
2. Add validated loading of the existing development cases.
3. Add pure BM25, dense ranking, RRF, and reranking operations.
4. Add pinned local model adapters with explicit truncation failure.
5. Add deterministic metrics and paired bootstrap comparison.
6. Add the suite-scoped runner, receipt, JSONL output, and generated report.
7. Add unit and synthetic integration tests.
8. Add root npm commands and operator documentation.
9. Run the full permitted validation suite.
10. Run the development benchmark, then review its receipt and every miss
    locally. Do not publish the result from a non-Docker development run.

The repository agent policy says the user performs benchmark commands and Git
commits. The implementation agent prepares and validates the command but does
not bypass that ownership rule. Remote push and PR creation happen only after
the user reviews the local diff and generated development artifacts.

Suggested atomic commit sequence for the user, still within one PR:

1. `add reproducible cuad retrieval runner`
2. `document retrieval development experiment`

## 10. Validation and runbook

Install and validate:

```sh
npm ci
npm run harness:install
uv sync --project experiments/cuad-retrieval --locked --python 3.12
npm run retrieval:test
npm test
npm run typecheck
```

Then the user runs the complete development comparison:

```sh
npm run retrieval:dev -- --device mps --batch-size 2 --repetitions 3
```

The first invocation downloads the two pinned models. The three repetitions
are an operational ranking-consistency check; quality uncertainty still comes
from the 11 independent positive contracts. A lower batch size can
reduce peak memory without changing ranking semantics. If MPS reports an
unsupported operation, rerun the entire comparison on `--device cpu`; do not
mix partial MPS and CPU records.

Review before sharing:

1. `run.json` says `complete: true` and contains exactly 180 records for the
   three-repetition run.
2. All four lanes and exactly the expected 15 case IDs are present.
3. `truncations` and `error` are zero/null for every record.
4. The case and result hashes are present.
5. The Git dirty list contains only reviewed pull-request files.
6. The report clearly says development evidence only.
7. Every miss at five is inspected against the source before proposing a fix.

## 11. Development decision gates

Choose at most one semantic treatment for future work:

- prefer hybrid to BM25 only if clause hit@5 improves by at least 5 absolute
  percentage points;
- retain the reranker only if it improves reciprocal rank and reduces clause
  hit@5 by no more than 2 points;
- report candidate-pool misses separately because reranking cannot recover a
  passage it never sees;
- if no semantic lane improves retrieval, inspect query construction and
  passage boundaries before changing models or adding a vector database.

Do not over-interpret a bootstrap interval from 11 positive cases. A treatment
can be promising enough to investigate even when this development interval
crosses zero, but it cannot be presented as a proven improvement.

## 12. Failure analysis

For each positive-case miss, assign one primary cause:

- lexical mismatch or paraphrase;
- irrelevant exact-term repetition;
- definition in another passage;
- exception or limitation elsewhere;
- multiple conflicting passages required;
- decisive text split at a passage boundary;
- question definition adds distracting terms;
- gold entered the candidate union but the reranker removed it;
- source annotation is ambiguous or incomplete.

The next experiment follows the dominant failure, one variable at a time:

- definition/exception/conflict misses: deterministic adjacent-section and
  referenced-definition expansion;
- boundary misses: structure-aware parsing and segmentation;
- lexical plus semantic misses: query construction ablation;
- reranker removals: candidate depth and reranker analysis;
- good retrieval but bad answers: a separate citation-support experiment.

## 13. Locked-test boundary

No locked run is part of this pull request. Before one is authorized, freeze
the selected lane, package lock, model revisions, candidate sizes, fusion
constant, sequence limit, dtype, batch size, device, and resource gates in the
experiment protocol.

A later locked claim requires a clean committed revision, reviewed run receipt,
document-disjoint cases, no post-result tuning, paired case-level uncertainty,
zero invalid outputs, and zero hidden truncations. It must state that the result
measures evidence retrieval rather than answer or citation correctness.

## 14. Explicitly rejected shortcuts

- Do not tune on `cuad-hard`.
- Do not score absence cases as successful retrieval.
- Do not use a judge model when passage IDs allow deterministic grading.
- Do not reload multi-gigabyte models for every case.
- Do not merge raw BM25 and cosine scores.
- Do not silently truncate passages.
- Do not add MongoDB before reference algorithms have known rankings.
- Do not add contextual retrieval, follow-up search, generation, or citation
  verification to this comparison.
- Do not present the 15-case development result as a locked benchmark.
- Do not create several PRs for this implementation.

## Sources

- cucumber-bench: https://github.com/o1-labs/cucumber-bench
- Florian's long-context pull request: https://github.com/o1-labs/cucumber-bench/pull/5
- CUAD: https://github.com/TheAtticusProject/cuad
- FlagEmbedding: https://github.com/FlagOpen/FlagEmbedding
- BGE-M3: https://huggingface.co/BAAI/bge-m3
- BGE reranker v2 M3: https://huggingface.co/BAAI/bge-reranker-v2-m3
