# cucumber-bench

Legal AI benchmark runner. It compares two systems on the same fixed cases:

- `direct` — one plain model call with the benchmark's own few-shot prompt (the baseline).
- `sandboxed` — the custom legal AI harness slot. Currently a two-call
  placeholder (`src/sandbox/placeholder-entry.mjs`) that runs isolated from
  the runner; replace it with the real harness. It only has to speak the
  stdin/stdout protocol described under "Sandboxed systems".

Systems only see the public case. Graders compare the output with the private
gold answer. See `legal-ai-benchmark-system-one-pager.pdf` for the design.

## Run

```sh
npm install
npm run bench                      # all cases, both systems, 1 repetition
npm run bench -- --systems direct --reps 3
npm test                           # unit + pipeline tests (no model needed)
```

The model client speaks the OpenAI chat completions protocol. Configure it
with environment variables, or put them in a `.env` file in the repo root
(gitignored, loaded automatically):

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_BASE_URL` | `http://localhost:11434/v1` | Ollama local, or any hosted API |
| `BENCH_MODEL` | `qwen3:8b` | model id |
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

The `sandboxed` system runs a harness in an isolated child process — with
`BENCH_SANDBOX=docker`, a fresh hardened container per run (read-only fs,
no capabilities, cpu/memory/pids caps). Build the image once with
`npm run sandbox:build`.

The sandbox receives exactly one public case, a proxy URL, and a per-run
token on stdin, and returns its output on stdout. It never sees private
cases, the API key, or the upstream URL: all model calls go through the
runner's proxy (`src/proxy.ts`), which injects the real key, enforces the
per-run call limit (`BENCH_MAX_CALLS`, default 20) and benchmark default
settings, and records tokens/calls server-side — usage is measured, not
self-reported. To sandbox a new harness, implement the stdin/stdout
protocol (see `src/sandbox/placeholder-entry.mjs`) and register it in
`src/cli.ts`. Hard egress lockdown (internal docker network + proxy
sidecar) is planned for the Linux-server deployment.

## Cases

`cases/legalbench/` holds 9 cases from three LegalBench tasks (hearsay,
abercrombie, personal_jurisdiction), 3 each, taken from the test split of
[nguha/legalbench](https://huggingface.co/datasets/nguha/legalbench). Each case
is a pair of files:

- `<id>.public.json` — instructions, few-shot examples, input, question, choices. Systems see only this.
- `<id>.private.json` — grader name and gold answer. Only graders see this.

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
