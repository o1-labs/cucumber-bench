# Agent guide

What this repository contains today, and the rules for working in it. Generic how-to pages
are linked at the end; this page is the repo-specific state.

cucumber-bench runs a plain model call (`direct`) and custom harnesses on the same cases,
in the same sandbox, and grades every answer against private gold data. The question:
is a harness better than the plain model, and at what cost?

## The harnesses (`harnesses/<name>/harness.json`)

| harness | suites | model(s) | what it is |
| --- | --- | --- | --- |
| `direct` | all | `qwen/qwen3.6-35b-a3b` | one model call: the baseline |
| `placeholder` | legalbench, redaction | same | dependency-free three-stage example |
| `legal-v1` | legalbench, redaction | same | input safety → agent → output safety (AI SDK, own docker image) |
| `cite-v1` | asqa*, cuad* | same | few-shot answer, then a check of every sentence's citations |
| `review-v1` | cuad* | same | scan every passage → compose from the quotes → check every cited sentence |
| `direct-4b` | cuad-hard* | `Qwen/Qwen3-4B-Instruct-2507:nscale` via the HF router (key: `HF_TOKEN` in `.env`) | the finetune's base model, plain call |
| `direct-4b-ft` | cuad-hard* | `cuad-qwen3-128k` on the local Ollama server | the raw finetune, plain call: fails on whole contracts (memorized answer) |
| `review-ft` | cuad-hard* | scan `cuad-qwen3:latest` (Ollama) + compose/check `qwen/qwen3.6-35b-a3b` | the finetune as a per-excerpt extractor inside the review pipeline |
| `lb2-direct` | longbench-v2* | `qwen/qwen3.6-35b-a3b`, reasoning on, 16,384 output tokens | the long-document baseline: one call, the reference zero-shot prompt; a document beyond the context is skipped (unsupported). Own image; needs `fetch-tokenizer.ts` |
| `lb2-direct-trunc` | longbench-v2* | same | the same call with the paper's middle truncation, so every case is answered |
| `lb2-nav` | longbench-v2* | same | the navigator: `search` and `read` commands, one per turn; the whole text when it fits, navigation from the head when not. Shares the lb2-direct image |
| `lb2-custom` | longbench-v2* | same; scan calls with reasoning off | evidence before the answer: frame, ranked chunk scan for checked verbatim passages, term hits, then the baseline's call with the passages. Shares the lb2-direct image |

Providers: the default upstream (`BENCH_BASE_URL` in `.env`) is OpenRouter; the Ollama
server is `http://100.124.74.45:11434/v1` (Tailscale). A model's upstream is set per model
in the manifest's `providers`. The judge is `deepseek/deepseek-v4-flash-0731`.

The finetune `cuad-qwen3` answers verbatim quotes or `None` for (question, excerpt) pairs;
the question must come **before** the excerpt, and whole contracts collapse it to a
memorized answer. `review-ft` exists because of this; `direct-4b-ft` documents it.

## The benchmarks (`benchmarks/<suite>/`)

| suite | cases | graders |
| --- | --- | --- |
| `legalbench` | 9 label cases | `exact` |
| `redaction` | 5 documents | `removal`, `leakage`, `retention` |
| `asqa` (+ `asqa-dev` 15) | 100 questions, 20 passages each | `str-em`, `citation-recall`, `citation-precision` |
| `cuad` (+ `cuad-dev` 15) | 100 clause questions, contracts ≤ 6k words | `clause-recall`, `clause-precision`, `citation-support` |
| `cuad-hard` (+ `cuad-hard-dev` 15) | 100 contracts of 6k–47k words, subtle clause types | same |
| `longbench-v2` (+ `longbench-v2-dev` 30) | 503 multiple-choice questions over one long document each (8k–2M words); data and cases not in git: `fetch.ts`, `import.ts` | `mc-answer` |

`*-dev` suites are for tuning; the others are locked test sets. Cases are rebuilt by each
suite's `import.ts` from pinned sources (ALCE/ASQA, CUAD, LongBench v2); raw data stays out of Git.
The long-document study (setup, lanes, scoring, differences from the paper) is in
[docs/LONGBENCH-V2.md](docs/LONGBENCH-V2.md); `benchmarks/longbench-v2/summary.ts` gives its numbers.

## Results so far (pinned in `runs/pinned/`, published on the docs site)

- asqa: `cite-v1` 87% citation recall vs `direct` 32% (run `2026-08-29T10-03-01-328Z`).
- cuad-hard: `review-v1` 75% clause recall vs `direct` 54% (run `2026-08-30T06-12-48-622Z`).
- cuad-hard-dev (not pinned, tuning): `review-ft` 80% recall / 80% precision / 93% support
  at $0.004 per contract.
- longbench-v2-dev (not pinned, tuning; run `2026-09-09T14-38-56-934Z`, 30 cases, 1 rep, $0.93 for
  both lanes): `lb2-direct` 44% accuracy (12/27) at 90% coverage; `lb2-direct-trunc` 43% (13/30),
  0/3 on the truncated long documents. Easy 75%, hard 32%; short 75%, medium 32%. The lanes agree on
  24 of 27 shared cases: near-deterministic at temperature 0. Failure classes of the 13 wrong
  answers on complete documents: evidence not aggregated across the text (~5), a missed detail or
  qualifier (~4), near-paraphrase options picked "to be safe" (~3), a self-override (1). Invalid:
  2 degenerate reasoning loops with no answer, 1 refusal ("N/A, question does not match").
  Summary: `npx tsx benchmarks/longbench-v2/summary.ts runs/<id>`.
- longbench-v2-dev, the custom harnesses (2026-09-14, one rep each): on the 27 cases the baseline
  can take, `lb2-direct` scored 12, 12 and 13 over three runs with 4 letter flips between runs;
  `lb2-nav` v2 15, `lb2-custom` 13 to 14. No lane clears the noise band. What measured: coverage
  (`lb2-custom` 2 of the 3 long documents right, the baseline none) and no invalid answers.
  Removed after measuring: pure navigation (6/27), scan tags in the answer prompt, a verify call
  without the document, a deliberation instruction, per-choice check calls, a challenge of the
  draft, notes for and against each choice (13/27 at $1.55), provider reasoning effort (ignored).
  The frozen harness is `lb2-custom` version 10. Details and the table: docs/LONGBENCH-V2.md,
  "Results on the dev set".

## Open work

- The final cuad-hard run: `BENCH_TIMEOUT_MS=300000 npm run bench -- --systems direct,review-ft --suites cuad-hard --reps 3 --concurrency 4`,
  then `npm run store` and a chart merge with the `direct-4b` baseline run.
- Before that run: pin the finetune to a versioned tag (`cuad-qwen3:v1`, not `:latest`) and
  confirm its training data does not contain the benchmark's contracts (contamination).
- Fix `direct`: it sends temperature 1 (`harnesses/direct/src/entry.ts`) while the harnesses
  draft at 0; every lane must use the benchmark default. Until then, B vs C is confounded.
- The two pinned runs are pilots (no `run.json`, process sandbox, the temperature mismatch):
  development evidence, not official claims.
- LongBench v2: the locked run, `lb2-direct` and `lb2-custom` (version 10, frozen) on the 503
  cases in docker, 3 reps: `npm run sandbox:build`, then the command in docs/LONGBENCH-V2.md.
  About $25 per repetition for the two lanes. The dev set is too small and too noisy to show a
  gain of a few cases; paid experiments run on a few chosen cases, not the full set.
- The remaining LongBench failures are the model's final judgment with the decisive passage in
  view (under 1,000 reasoning tokens on 240k-token prompts). Untried levers: a vote over choice
  permutations, and a reasoning budget the provider honors.

## Rules that bind you

- **Never commit.** The user reviews and commits; propose a short lowercase commit message.
- The user runs benchmark and regrade commands; you prepare them.
- Tune on `*-dev` suites only; a test suite is consumed by one run ([docs/PROTOCOL.md](docs/PROTOCOL.md)).
- No task-specific rules in harness code; the manifest's `suites` does the routing.
- Secrets stay in `.env`. Never a key in a manifest, a doc, or a chat message.
- `docs/` is served publicly: charts and descriptions only, never gold data or reports.
- Before paying for a run, replay a changed rule on stored drafts in `runs/<id>/results.jsonl`.
- Run `npm test` after every change (mock model, seconds). End every harness prompt with a
  label line; the mock routes on it.
- Small, atomic changes; report what changed, why, and next steps.

## Pointers

- [README.md](README.md): commands, options, configuration, grader definitions.
- [docs/HOW-TO-BUILD-A-HARNESS.md](docs/HOW-TO-BUILD-A-HARNESS.md): the wire protocol, manifest fields, the tuning loop.
- [docs/EXPERIMENT-PLAN.md](docs/EXPERIMENT-PLAN.md): the current study: decision, model matrix, thresholds.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): comparison lanes, splits, pinning, scoring, reporting.
- `.env.example`: every environment variable, with defaults.
