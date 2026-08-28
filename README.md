# cucumber-bench

Legal AI benchmark runner. It compares systems on the same fixed cases,
every system running in the same sandbox under identical conditions:

- `direct` — one plain model call, no safety stages (the baseline). The raw
  input goes to the model. `src/sandbox/direct-entry.mjs`.
- `placeholder` — a cheap reference harness: regex PII scrubber around a
  two-call agent, no dependencies (`src/sandbox/placeholder-entry.mjs`).
- `harness` — the real legal AI harness, on the Vercel AI SDK
  (`harness/src/entry.ts`, its own package and image). Pipeline of
  input safety → agent → output safety, where safety is hybrid: regex for
  machine-readable identifiers, then a trusted **safety model** for names,
  addresses and ids. A system only has to speak the stdin/stdout protocol
  described under "Sandboxed systems".

Systems only see the public case. Graders compare the released output (and,
for safety, what reached the model) with the private gold data. See
`legal-ai-benchmark-system-one-pager.pdf` for the design.

## Run

```sh
npm install && npm run harness:install
npm run bench                      # all cases, all systems, 1 repetition, child-process sandbox
npm run bench -- --systems direct --reps 3
BENCH_SANDBOX=docker npm run bench # same, each run in a fresh docker container
npm test                           # unit + pipeline tests (no model needed)
```

The model client speaks the OpenAI chat completions protocol. Configure it
with environment variables, or put them in a `.env` file in the repo root
(gitignored, loaded automatically):

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_BASE_URL` | `http://localhost:11434/v1` | Ollama local, or any hosted API |
| `BENCH_MODEL` | `qwen3:8b` | the guarded model id |
| `BENCH_SAFETY_MODEL` | same as `BENCH_MODEL` | trusted model served on the proxy's `/safety/v1` route; a harness may show it raw data, and its prompts do not count as leakage |
| `BENCH_API_KEY` | `none` | required by hosted APIs, ignored by Ollama |
| `BENCH_TEMPERATURE` | `0` | sampling temperature |
| `BENCH_TIMEOUT_MS` | `120000` | per model call |
| `BENCH_COST_IN` | unset | $ per 1M input tokens; enables the cost column |
| `BENCH_COST_OUT` | unset | $ per 1M output tokens |

These are the benchmark defaults. A sandboxed harness controls its own LLM
settings by what it sends in each request; the proxy fills in the defaults
for anything it leaves out.

Local default: install [Ollama](https://ollama.com), then `ollama pull qwen3:8b`.
Hosted example: `BENCH_BASE_URL=https://openrouter.ai/api/v1 BENCH_MODEL=qwen/qwen3-32b BENCH_API_KEY=... npm run bench`.

Each run writes to `runs/<runId>/`:

- `results.jsonl` — every run + grade, raw
- `report.md` — per-task accuracy, latency, tokens, model calls
- `chart.html` — the same numbers as a self-contained graphic (open in a browser); regenerate for an old run with `npm run chart -- runs/<runId>`

## Sandboxed systems

Every system — the baseline included — is an entry script under
`src/sandbox/` that runs in an isolated child process; with
`BENCH_SANDBOX=docker`, in a fresh hardened container per run (read-only fs,
no capabilities, cpu/memory/pids caps) from one image holding only node and
the entry scripts (plus a second image for `harness`, which needs the AI SDK).
Build both with `npm run sandbox:build`.

The sandbox receives exactly one public case, a proxy URL, and a per-run
token on stdin, and returns its output plus a **trace** on stdout: the four
artifacts (source, transformed source, raw output, released output) and one
record per stage — module, version, policy, mode (`passthrough`, `regex`,
`llm`, `hybrid`), findings, decision (`pass`, `modified`, `blocked`).
Suites without safety requirements run both safety stages as passthrough. It never sees private
cases, the API key, or the upstream URL: all model calls go through the
runner's proxy (`src/proxy.ts`), which injects the real key, enforces the
per-run call limit (`BENCH_MAX_CALLS`, default 20) and benchmark default
settings, and records tokens/calls server-side — usage is measured, not
self-reported. To add a harness, write an entry script (see
`src/sandbox/direct-entry.mjs` for the minimum, `lib.mjs` for the shared
protocol/proxy plumbing) and register it in `src/cli.ts`. Hard egress lockdown (internal docker network + proxy
sidecar) is planned for the Linux-server deployment.

## Cases and graders

Each case is a pair of files:

- `<id>.public.json` — instructions and input, plus few-shot examples,
  question and choices for label tasks. Systems see only this.
- `<id>.private.json` — the list of graders and their gold data. Only
  graders see this. The first grader is the primary one (it drives the
  headline chart and the consistency metric).

Suites:

- `cases/legalbench/` — 9 label cases from three LegalBench tasks (hearsay,
  abercrombie, personal_jurisdiction), test split of
  [nguha/legalbench](https://huggingface.co/datasets/nguha/legalbench).
  Grader `exact`: the extracted label must equal the gold label.
- `cases/redaction/` — 5 PII-redaction documents from
  [ai4privacy/pii-masking-300k](https://huggingface.co/datasets/ai4privacy/pii-masking-300k)
  (validation split; protected spans = the dataset's identifier labels, quasi-identifiers
  such as sex, country, time dropped). Three graders measure safety and utility together:
  `removal` — no protected span survives in the released output (strict);
  `leakage` — no protected span reached the model, measured from the proxy's
  request log, not from the harness's claims (strict);
  `retention` — at least 90% of the non-protected content survives.

Test cases are locked: do not tune the harness on them.

Add more cases for an existing task with
`npm run import -- --task hearsay --count 5` — pulls unused test-split rows
from HuggingFace, balanced across gold answers, reusing the task's
instructions from an existing case.

With repetitions (`--reps 3`), the report and chart also show **consistency**:
the average share of repetitions that give the same extracted answer per case.

## Roadmap

1. ~~Skeleton: types, case store, exact grader, model client, two systems, runner, report.~~
2. ~~Repetitions and consistency metric, cost, LegalBench import script for more cases.~~
3. CUAD suite with a span precision/recall grader.
4. Rubric grader and custom legal workflow cases; plug in the real harness.
