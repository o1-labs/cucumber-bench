# LegalBench-RAG direct reference

`direct-qwen38` uses `qwen/qwen3.8-27b`, as specified in the experiment plan.
Each case makes one model call through the existing proxy. The proxy supplies the
configured temperature (default 0). There is no retriever, few-shot example, answer
repair, or model judge. The model returns verbatim quotes with source file names.

**This is a document-scoped extraction adaptation, not the official corpus-search
benchmark.** The importer uses the annotation to select the complete source document
for each question. It keeps the answer spans private. This gives the model the correct
document; scores must not be compared directly with full-corpus retrieval results.
No source text is truncated, and provider context errors count as run failures.

## Run

The data has been imported into this workspace. Run the full unit test suite manually:

```sh
npm test
```

Run the development benchmark:

```sh
BENCH_TEMPERATURE=0 npm run bench -- --systems direct-qwen38 --suites legalbenchrag-dev --reps 1 --concurrency 4
```

Run the locked test benchmark when the configuration is frozen:

```sh
npm run sandbox:build
BENCH_SANDBOX=docker BENCH_TEMPERATURE=0 npm run bench -- --systems direct-qwen38 --suites legalbenchrag --reps 3 --concurrency 4 --no-details
```

For a single development case, add `--cases legalbenchrag-dev-contractnli-0100`.
The existing `.env` supplies the provider and API key. Output uses the normal
`runs/<id>/results.jsonl`, `run.json`, `report.md`, and `chart.html` files.
Provider selection currently follows `BENCH_BASE_URL`; OpenRouter automatic routing
is suitable for development, but does not meet the protocol's final provider-pinning
rule. Freeze the provider and code before making a final comparison claim.

## Data and reconstruction

On a fresh checkout, fetch and import the data with:

```sh
npm ci
npm run data:legalbenchrag
```

This requires curl, Python 3 (standard library only), and Node.js. It downloads about 87 MB,
extracts to a temporary directory, verifies the pinned data through the importer,
and creates both test and development cases. Temporary downloads are removed when
the script exits. It does not call a model or run the benchmark. Existing nonempty
case/document directories are preserved; the command stops before downloading.
Use `npm run data:legalbenchrag -- --out /tmp/legalbenchrag-rebuild` for a separate copy.

For a manual download or an existing copy of the release:

The [upstream repository](https://github.com/ZeroEntropy-AI/legalbenchrag/tree/431bc8f2488a81569ab7259fa633dcc50ab77f9a)
is pinned at `431bc8f2488a81569ab7259fa633dcc50ab77f9a`. Download the release from the
[upstream data link](https://www.dropbox.com/scl/fo/r7xfa5i3hdsbxex1w6amw/AID389Olvtm-ZLTKAPrw6k4?rlkey=5n8zrbk4c08lbit3iiexofmwg&dl=1),
then extract it into a directory containing `corpus/` and `benchmarks/`.

```sh
npx tsx benchmarks/legalbenchrag/import.ts --data /path/to/extracted-release
```

The importer refuses nonempty output directories. To check reconstruction without
replacing current data, add `--out /tmp/legalbenchrag-rebuild`. The data directories
are ignored by Git; the importer and `import.json` provenance records are tracked.
Shared public documents use SHA-256 references. The loader verifies their hashes
and caches their text, so many questions can use one document without repeated copies.

`source.ts` pins all four benchmark file checksums and the complete corpus fingerprint.
The importer verifies all 6,889 queries, all 714 files, and every annotated answer
against its character range. Paths use NFC Unicode normalization because the release
mixes composed and decomposed file names. Text uses Python-compatible universal
newlines, with all other text preserved. Offsets count Unicode code points.

The fixed split orders source documents by SHA-256 of
`legalbenchrag-split-v1:<file_path>` and assigns the first `ceil(20%)` per dataset to
development. Questions from the same document stay together. No model outputs were
used to create the split.

| Dataset | Test | Development |
| --- | ---: | ---: |
| ContractNLI | 758 | 219 |
| CUAD | 3,279 | 763 |
| MAUD | 1,339 | 337 |
| PrivacyQA | 132 | 62 |
| Total | 5,508 | 1,381 |

Upstream code is MIT-licensed. The source datasets retain their own terms; see the
upstream README links and dataset licences before redistributing the corpus.

## Scoring

`rag-recall` is the primary metric: relevant returned characters divided by gold
characters. `rag-precision` is relevant returned characters divided by returned
characters. These implement the interval-overlap equations in upstream
`legalbenchrag/run_benchmark.py`. Empty output scores zero. A pass means a score of 1;
use mean scores to assess partial retrieval quality.

Returned quotes must match exactly. Repeated text requires a zero-based `occurrence`
index. Invalid JSON, unknown files, invented quotes, and ambiguous quotes score zero.
The grader merges overlapping returned ranges before scoring. This prevents duplicate
quotes from inflating recall; upstream's unmerged formula can exceed 1 on duplicates.

The normal runner reports a mean across questions, so large datasets have more weight.
Upstream's combined score gives each of its four datasets equal weight. Our report is
therefore **not** its official aggregate. The document scope, fixed development split,
and duplicate-span handling are also explicit deviations from its reference run.

This baseline measures complete-document evidence extraction. A future treatment must
use the same public documents, model, provider, and temperature. Character recall is
the primary comparison; report precision, errors, cost, and latency alongside it.

## Verification performed

Five focused scoring tests and one sandbox/proxy integration test passed. TypeScript
checks passed. A single live development call is recorded in
`runs/2026-09-18T09-03-17-775Z`: one Qwen3.8 call, no infrastructure errors, an empty
retrieval answer (`[]`), and zero precision/recall. It cost $0.0069 and took about
53 seconds in process mode. This is a connectivity check, not a quality estimate.
The full unit suite and full model benchmark were left for the user to run.
