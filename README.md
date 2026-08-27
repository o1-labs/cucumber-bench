# cucumber-bench

Legal AI benchmark runner. It compares two systems on the same fixed cases:

- `direct` — one plain model call with the benchmark's own few-shot prompt (the baseline).
- `harness` — the custom legal AI harness. Currently a two-call placeholder in
  `src/systems/harness.ts`; replace it with the real harness. It only has to
  implement the `SystemUnderTest` contract from `src/types.ts`.

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

These are defaults. A system can create its own clients with
`createModelClient({ model, baseUrl, temperature, ... })` and override
temperature per call, so each harness controls its own LLM settings; the
report lists each system's `info` line for comparability.

Local default: install [Ollama](https://ollama.com), then `ollama pull qwen3:8b`.
Hosted example: `BENCH_BASE_URL=https://openrouter.ai/api/v1 BENCH_MODEL=qwen/qwen3-32b BENCH_API_KEY=... npm run bench`.

Each run writes to `runs/<runId>/`:

- `results.jsonl` — every run + grade, raw
- `report.md` — per-task accuracy, latency, tokens, model calls
- `chart.html` — the same numbers as a self-contained graphic (open in a browser); regenerate for an old run with `npm run chart -- runs/<runId>`

## Cases

`cases/legalbench/` holds 9 cases from three LegalBench tasks (hearsay,
abercrombie, personal_jurisdiction), 3 each, taken from the test split of
[nguha/legalbench](https://huggingface.co/datasets/nguha/legalbench). Each case
is a pair of files:

- `<id>.public.json` — instructions, few-shot examples, input, question, choices. Systems see only this.
- `<id>.private.json` — grader name and gold answer. Only graders see this.

Test cases are locked: do not tune the harness on them.

## Roadmap

1. ~~Skeleton: types, case store, exact grader, model client, two systems, runner, report.~~
2. Repetitions and consistency metric, cost, LegalBench import script for more cases.
3. CUAD suite with a span precision/recall grader.
4. Rubric grader and custom legal workflow cases; plug in the real harness.
