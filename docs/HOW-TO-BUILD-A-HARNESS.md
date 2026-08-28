# How to build a harness

A **harness** is a system under test. It receives one case, does its work, and
returns one output. The benchmark runs every harness in the same sandbox and
grades every output with the graders of the benchmark. This guide shows how to
build one, run it, read the results, and tune it.

## 1. The layout

```
src/                     core framework: runner, proxy, sandbox adapter, stats, report, chart, cli
src/graders/             reusable graders (exact)
harnesses/<name>/        one folder per harness: harness.json + src/entry.ts
harnesses/lib.ts         shared protocol plumbing for harnesses without dependencies
benchmarks/<suite>/      one folder per benchmark: benchmark.json + cases/ (+ graders.ts)
```

A harness never imports core code at runtime. A benchmark declares its graders.
A harness declares the benchmarks it runs on. You add a harness or a benchmark
without a change to `src/`.

## 2. The contract

A harness is a program that speaks a small protocol.

**Input** — one JSON object on stdin:

```json
{
  "publicCase": { "id": "...", "suite": "...", "task": "...", "instructions": "...", "input": "...",
                  "docs": [{ "title": "...", "text": "..." }], "examples": [...], "question": "...", "choices": [...] },
  "proxyUrl": "http://127.0.0.1:PORT",
  "token": "per-run bearer token",
  "model": "the guarded model id"
}
```

`docs` are context passages the answer may cite as `[1][2]`, numbered from 1
(asqa). `examples` are worked examples. `question` and `choices` exist only
for label tasks.

**Output** — one JSON object on stdout:

```json
{ "output": "the released output", "trace": { ... } }
```

or `{ "error": "message" }`. The trace is optional but recommended. See section 5.

**Model access** — only through the proxy, with the token:

- `POST {proxyUrl}/v1/chat/completions` — the **guarded model**. The proxy
  records every prompt sent here. The `leakage` grader checks these prompts.
- `POST {proxyUrl}/safety/v1/chat/completions` — the **trusted safety model**.
  A harness may show raw data to it. Its prompts do not count as leakage.

Both routes accept the OpenAI chat-completions format. Send the
`Authorization: Bearer {token}` header. The proxy adds the real API key and
the default temperature. It counts calls and tokens. It stops a run after
`BENCH_MAX_CALLS` calls (default 20).

The harness never sees private cases, API keys, or the upstream URL.

## 3. Create the harness

Make a folder `harnesses/<name>/` with a manifest and an entry.

**The manifest** `harness.json`:

```json
{
  "name": "my-harness",
  "description": "One sentence for the chart. What does this harness do?",
  "entry": "src/entry.ts",
  "suites": ["legalbench", "redaction"]
}
```

`suites` lists the benchmarks the harness runs on. The runner skips the others.

**The entry**, in TypeScript. Without dependencies, use `harnesses/lib.ts`:

```ts
import { readInput, generateVia, respond } from '../../lib.js';

let { publicCase: c, proxyUrl, token, model } = await readInput();
let generate = generateVia(proxyUrl, token, model);
try {
  respond({ output: await generate(`${c.instructions}\n\n${c.input}`) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}
```

`generate(prompt, temperature?)` calls the guarded model. Leave `temperature`
undefined to use the benchmark default. `generateVia(proxyUrl, token, model,
'/safety/v1')` gives a function for the safety model. `harnesses/direct` is the
minimum example. `harnesses/placeholder` is the three-stage example.

The CLI discovers the folder. There is no list to edit. A `.ts` entry runs
under `tsx`. A `.mjs` entry runs under `node`.

**With dependencies** (for example the Vercel AI SDK), add `package.json`,
`tsconfig.json`, and a `Dockerfile` to the folder, and name the image in the
manifest:

```json
{
  "image": "cucumber-harness-my-harness",
  "imageEntry": "/app/dist/entry.js",
  "dockerfile": "Dockerfile"
}
```

`harnesses/legal-v1` is the template. Its Dockerfile builds with `tsc` and
keeps only production dependencies. Install its dependencies once with
`npm --prefix harnesses/<name> ci`.

## 4. Create a benchmark

Make a folder `benchmarks/<suite>/` with a manifest and the cases.

**The manifest** `benchmark.json` names the graders:

```json
{ "name": "legalbench", "graders": ["exact"] }
```

A grader is a core grader by name, or a module path such as `"./graders.ts"`.
The module exports `{ graders }`, an array of grader objects:

```ts
let graders: Grader[] = [{
  name: 'my-grader',
  // required: one sentence that says what passes. it appears in the report and the chart glossary
  description: 'Every claim in the output has a source.',
  async grade(pub, priv, result, ctx) {
    return { grader: 'my-grader', pass: true, score: 1, detail: 'why' };
  },
}];
```

`grade` is async. Its fourth argument is a context with `judge(prompt)`: a
greedy call to the judge model (`BENCH_JUDGE_MODEL`, on `BENCH_JUDGE_BASE_URL`
with `BENCH_JUDGE_API_KEY` when it lives on another provider) through the
proxy. The runner counts judge usage apart from the harness usage.
`npm run regrade -- runs/<runId>` grades the stored outputs of a run again
with the current graders and judge, without running any harness. Use it to
compare judges on identical outputs.
`benchmarks/redaction/graders.ts` is a deterministic example.
`benchmarks/asqa/graders.ts` uses the judge.

**The cases** go in `cases/`, one pair of files per case:

- `<id>.public.json` — `id`, `suite`, `task`, `instructions`, `input`, and as
  needed `docs`, `examples`, `question`, `choices`. Systems see only this.
- `<id>.private.json` — `id`, `graders` (names, the first one is the primary
  grader), and the gold data the graders need. Only graders see this.

## 5. The three stages and the trace

A harness with safety requirements has three stages:

```
input safety -> agent -> output safety
```

Record each stage in the trace:

```json
{
  "source": "the original input",
  "transformedSource": "the input after input safety",
  "rawOutput": "the agent output",
  "releasedOutput": "the output after output safety",
  "stages": [
    { "name": "input-safety", "module": "regex+safety-model", "version": "1", "policy": "pii-hybrid-v1",
      "mode": "hybrid", "findings": ["email:a@b.c", "llm:Heder"], "decision": "modified" },
    { "name": "agent", "module": "document-task", "version": "1", "mode": "llm", "findings": [], "decision": "pass" },
    { "name": "output-safety", "module": "...", "version": "1", "mode": "hybrid", "findings": [], "decision": "pass" }
  ]
}
```

`mode` is one of `passthrough`, `regex`, `llm`, `hybrid`. `decision` is one of
`pass`, `modified`, `blocked`. For a suite without safety requirements, run
both safety stages as `passthrough` and record that mode.

The graders do not trust the trace. They grade the released output and the
prompts the proxy recorded. The trace is for you: it shows what the harness
did on each case.

## 6. The fast loop

Run without Docker. This uses the source files directly:

```sh
npm run bench -- --systems legal-v1 --suites redaction
```

`--suites` limits the run to some benchmarks. Without it, every benchmark runs.

Set a small safety model in `.env` to make the safety calls fast:

```
BENCH_SAFETY_MODEL=qwen3:30b-a3b-instruct-2507-q4_K_M
```

## 7. Read the results

`runs/<runId>/report.md` has the numbers. The Failures list names each span
that survived or that reached the model. That list tells you what to fix.

`runs/<runId>/chart.html` shows the same numbers with definitions.

To see what the harness did on one case:

```sh
jq 'select(.run.caseId=="pii-40813B" and .run.system=="legal-v1")
    | {stages: .run.trace.stages, sent: .run.modelRequests, out: .run.output}' runs/<runId>/results.jsonl
```

`stages[].findings` shows what each stage found. `sent` shows what reached
the guarded model. Compare `sent` with `.run.trace.source` to see what
slipped through.

## 8. Test the harness

`npm test` runs every harness against a mock model in under one second.
The harness tests are in `test/sandbox.test.ts`. Add a test when you add a
rule. The mock answers the PII-detection prompt with a fixed JSON list and
everything else with `Yes`.

## 9. The official run

When the numbers are good, build the images and run in Docker with
repetitions:

```sh
npm run sandbox:build
BENCH_SANDBOX=docker npm run bench -- --reps 3
```

`sandbox:build` builds the shared base image and one image per harness that
has a Dockerfile. Each run then starts in a fresh container: read-only file
system, no capabilities, resource caps.

## 10. Controls

- Tune only on development cases. The cases under `benchmarks/` are the test
  set. A score on cases you tuned on means less.
- Do not change the graders or the cases to make a harness pass.
- Keep the model ids, temperatures, and case files fixed between the runs you
  compare. The report records them.

## 11. Tuning checklist

For a PII policy:

1. Read the Failures list. Group the spans by kind: name, address, date,
   identifier.
2. Add a regular expression for each machine-readable kind.
3. Extend the safety-model prompt for each kind that needs judgment.
4. Add a rule for context: when a street is removed, also remove the city
   and the postcode near it.
5. Check `retention`. If it drops, the policy removes too much.
6. Run again. Compare `removal`, `leakage`, and `retention` with the last run.
