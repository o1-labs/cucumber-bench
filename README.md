# cucumber-bench

<img src="pickle.png" alt="cucumber-bench" width="240" align="right">

A benchmark runner for AI systems. It runs a plain model call (`direct`) and custom
harnesses on the same cases, in the same sandbox, and grades every answer against
private gold data. The question it answers: is a harness better than the plain
model, and at what cost?

## Quick start

```sh
npm install && npm run harness:install
npm run bench -- --systems direct,cite-v1 --suites asqa-dev --reps 2 --concurrency 10
npm test
```

`npm run bench` options:

| option | meaning |
| --- | --- |
| `--systems a,b` | the harnesses to run (default: all) |
| `--suites s1,s2` | the benchmarks to run (default: all); a harness runs only on the suites it lists |
| `--cases id,id` | single cases, for tuning one case many times |
| `--reps n` | repetitions per case (default 1) |
| `--concurrency n` | runs in flight at once (default 1; use 10 with a hosted model) |
| `--no-details` | no gold-derived details in the report, for a shared report of a test set |

Other commands: `npm run regrade -- runs/<id> [--judge model]` grades stored outputs
again without running a harness; `npm run chart -- runs/<id>` regenerates a chart;
`npm run sandbox:build` builds the docker images.

## How it works

1. A **case** is two files: `<id>.public.json` (what the system sees: instructions,
   input, passages, examples) and `<id>.private.json` (the graders and the gold data).
2. A **harness** runs in a sandbox with one public case. It reaches models only through
   the runner's **proxy**, with a per-run token. The proxy adds the real key, enforces the
   call limit and the models the harness declared, and counts calls, tokens and cost.
3. The **graders** of the benchmark grade the released output. Some use a **judge**
   model (a yes/no question through the proxy's judge route).
4. Every run writes `runs/<id>/`: `results.jsonl` (every run, its trace and grades),
   `run.json` (what was run: command, cases, models, git revision, completeness),
   `report.md`, `chart.html`.

Layout: `src/` is the core. `harnesses/<name>/` holds one harness with a `harness.json`.
`benchmarks/<suite>/` holds one benchmark with a `benchmark.json` and `cases/`. The CLI
finds both; nothing in `src/` changes when you add one. See
[docs/HOW-TO-BUILD-A-HARNESS.md](docs/HOW-TO-BUILD-A-HARNESS.md).

Who names what: a harness names its **models** and its call limit in `harness.json`;
a benchmark names its **judge** in `benchmark.json`; the environment names the
**providers** (URLs, keys) and the defaults.

## Configuration

Copy `.env.example` to `.env` (gitignored, loaded automatically).

| variable | default | meaning |
| --- | --- | --- |
| `BENCH_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible API: Ollama, OpenRouter, ... |
| `BENCH_API_KEY` | `none` | its key |
| `BENCH_JUDGE_MODEL` | `qwen3:8b` | judge for a benchmark that names none |
| `BENCH_JUDGE_BASE_URL`, `BENCH_JUDGE_API_KEY` | the main URL and key | a judge on another provider |
| `BENCH_TEMPERATURE` | `0` | injected when a harness sets none |
| `BENCH_TIMEOUT_MS` | `120000` | per model call |
| `BENCH_MAX_CALLS` | `20` | model calls per run; a harness raises it with `maxCalls` in its manifest |
| `BENCH_MAX_JUDGE_CALLS` | `100` | judge calls per run |
| `BENCH_COST_IN`, `BENCH_COST_OUT` | unset | $ per 1M tokens, for a provider that reports no cost |
| `BENCH_SANDBOX` | unset | `docker`: each run in a fresh container |

Sandbox modes: by default a harness is a child process with a bare environment (no keys),
the **development mode**; it still shares the file system. `BENCH_SANDBOX=docker` runs
each case in a fresh hardened container (read-only, no capabilities, resource caps): the
**isolated mode**, for results that are reported.

## Harnesses

| harness | suites | what it does |
| --- | --- | --- |
| `direct` | all | one model call with the benchmark's prompt: the baseline |
| `placeholder` | legalbench, redaction | regex PII scrub, a two-call agent, regex again; no dependencies |
| `legal-v1` | legalbench, redaction | input safety → agent → output safety; safety is regex plus a trusted safety model (Vercel AI SDK) |
| `cite-v1` | asqa, cuad | the few-shot answer, then a check of every sentence's citations; an unsupported sentence is dropped |
| `review-v1` | cuad | scan every passage and quote what answers the question; compose the answer from the quotes; check every cited sentence against its passages |

Every harness names its model in its manifest; all use `qwen/qwen3.6-35b-a3b` today.

## Benchmarks

| suite | cases | source | graders |
| --- | --- | --- | --- |
| `legalbench` | 9 label cases | [nguha/legalbench](https://huggingface.co/datasets/nguha/legalbench) | `exact` |
| `redaction` | 5 documents | [ai4privacy/pii-masking-300k](https://huggingface.co/datasets/ai4privacy/pii-masking-300k) | `removal`, `leakage`, `retention` |
| `asqa` (+ `asqa-dev`, 15) | 100 questions with 20 passages each | [ALCE](https://github.com/princeton-nlp/ALCE), ASQA | `str-em`, `citation-recall`, `citation-precision` |
| `cuad` (+ `cuad-dev`, 15) | 100 clause questions over contracts ≤ 6,000 words, 12 clause types, 30% absent | [CUAD](https://github.com/TheAtticusProject/cuad) (CC BY 4.0) | `clause-recall`, `clause-precision`, `citation-support` |
| `cuad-hard` (+ `cuad-hard-dev`, 15) | 100 contracts of 6,000–47,000 words, 7 subtle clause types, multi-instance questions | same | same |

The graders, one line each:

- `exact` — the extracted label equals the gold label.
- `str-em` — every gold short answer of the question appears in the output.
- `citation-recall` — every sentence is supported by the passages it cites (judge).
- `citation-precision` — every citation is needed: its passage supports the sentence, and is not redundant (judge).
- `clause-recall` — for every clause the contract has, the answer quotes it (8 consecutive words) and cites a passage that contains it; for an absent clause, the answer says so.
- `clause-precision` — every cited passage contains the clause; for an absent clause, nothing is cited.
- `citation-support` — every sentence is supported by its cited passages; an uncited sentence passes only as a statement about the documents (judge).
- `removal` — no protected span survives; `leakage` — no protected span reached the model (measured at the proxy); `retention` — 90% of the other content survives.

Import scripts: `benchmarks/asqa/import.ts` and `benchmarks/cuad/import.ts` (see their
headers). The raw data is not in the repository.

## Reading the results

- **pass rate**: the share of runs the grader passed. **mean score**: the average score
  (0–1). Tune by the mean, claim by the pass rate.
- **errors**: the share of runs that failed in the sandbox or a grader. They count as
  failed grades; the column tells you how much of a failure rate is infrastructure.
- **paired comparison**: per suite and grader, wins/ties/losses of one system over another
  on the same cases, the mean difference, and a 95% bootstrap interval. An interval that
  contains 0 is consistent with no difference. 15 cases give about ±10 points; 100 give ±3.
- **consistency**: with repetitions, the share of repetitions that gave the same answer.
- An incomplete run is marked at the top of the report and in `run.json`.

## Rules

- Tune a harness on a `*-dev` suite only. The test suites are locked.
- A harness gets the identical public case; extra sources only as proxy routes open to all.
- Report numbers from docker mode with several repetitions.
