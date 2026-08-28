# How to build a harness

A **harness** is a system under test. It receives one case, does its work, and
returns one output. The benchmark runs every harness in the same sandbox and
grades every output with the same graders. This guide shows how to build one,
run it, read the results, and tune it.

## 1. The contract

A harness is a program that speaks a small protocol.

**Input** — one JSON object on stdin:

```json
{
  "publicCase": { "id": "...", "suite": "...", "task": "...", "instructions": "...", "input": "...",
                  "examples": [...], "question": "...", "choices": [...] },
  "proxyUrl": "http://127.0.0.1:PORT",
  "token": "per-run bearer token",
  "model": "the guarded model id"
}
```

`examples`, `question`, and `choices` exist only for label tasks.

**Output** — one JSON object on stdout:

```json
{ "output": "the released output", "trace": { ... } }
```

or `{ "error": "message" }`. The trace is optional but recommended. See section 4.

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

## 2. Create the harness

Two ways exist.

**Dependency-free (plain JavaScript).** Add one file under `src/sandbox/`.
Use `lib.mjs` for the protocol plumbing:

```js
import { readInput, generateVia, respond } from './lib.mjs';

let { publicCase: c, proxyUrl, token, model } = await readInput();
let generate = generateVia(proxyUrl, token, model);
try {
  respond({ output: await generate(`${c.instructions}\n\n${c.input}`) });
} catch (err) {
  respond({ error: String(err?.message ?? err) });
}
```

`generate(prompt, temperature?)` calls the guarded model. Leave `temperature`
undefined to use the benchmark default. `src/sandbox/direct-entry.mjs` is the
minimum example. `src/sandbox/placeholder-entry.mjs` is the three-stage example.

**With dependencies (TypeScript, Vercel AI SDK).** Use `harness/` as the
template: `package.json`, `tsconfig.json`, `src/entry.ts`, and
`docker/harness.Dockerfile`. The entry uses `createOpenAICompatible` with
`baseURL: proxyUrl + '/v1'` (guarded) or `proxyUrl + '/safety/v1'` (safety) and
`apiKey: token`.

## 3. Register the harness

Add the harness to `available` in `src/cli.ts`:

```ts
myHarness: sandboxedSystem('my-harness', entry('my-entry.mjs')),
```

For a harness with its own image, give both argv forms, as `harnessArgv` does.

## 4. The three stages and the trace

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
    {
      "name": "input-safety",
      "module": "regex+safety-model",
      "version": "1",
      "policy": "pii-hybrid-v1",
      "mode": "hybrid",
      "findings": ["email:a@b.c", "llm:Heder"],
      "decision": "modified"
    },
    {
      "name": "agent",
      "module": "document-task",
      "version": "1",
      "mode": "llm",
      "findings": [],
      "decision": "pass"
    },
    {
      "name": "output-safety",
      "module": "...",
      "version": "1",
      "mode": "hybrid",
      "findings": [],
      "decision": "pass"
    }
  ]
}
```

`mode` is one of `passthrough`, `regex`, `llm`, `hybrid`. `decision` is one of
`pass`, `modified`, `blocked`. For a suite without safety requirements, run
both safety stages as `passthrough` and record that mode.

The graders do not trust the trace. They grade the released output and the
prompts the proxy recorded. The trace is for you: it shows what the harness
did on each case.

## 5. The fast loop

Run without Docker. This uses the source files directly:

```sh
npm run bench -- --systems harness
```

Set a small safety model in `.env` to make the safety calls fast:

```
BENCH_SAFETY_MODEL=qwen3:30b-a3b-instruct-2507-q4_K_M
```

## 6. Read the results

`runs/<runId>/report.md` has the numbers. The Failures list names each span
that survived or that reached the model. That list tells you what to fix.

`runs/<runId>/chart.html` shows the same numbers with definitions.

To see what the harness did on one case:

```sh
jq 'select(.run.caseId=="pii-40813B" and .run.system=="harness")
    | {stages: .run.trace.stages, sent: .run.modelRequests, out: .run.output}' runs/<runId>/results.jsonl
```

`stages[].findings` shows what each stage found. `sent` shows what reached
the guarded model. Compare `sent` with `.run.trace.source` to see what
slipped through.

## 7. Test the harness

`npm test` runs every harness against a mock model in under one second.
The harness tests are in `test/sandbox.test.ts`. Add a test when you add a
rule. The mock answers the PII-detection prompt with a fixed JSON list and
everything else with `Yes`.

## 8. The official run

When the numbers are good, build the images and run in Docker with
repetitions:

```sh
npm run sandbox:build
BENCH_SANDBOX=docker npm run bench -- --reps 3
```

Each run then starts in a fresh container: read-only file system, no
capabilities, resource caps.

## 9. Controls

- Tune only on development cases. The cases under `cases/` are the test set.
  A score on cases you tuned on means less.
- Do not change the graders or the cases to make a harness pass.
- Keep the model ids, temperatures, and case files fixed between the runs you
  compare. The report records them.

## 10. Tuning checklist

For a PII policy:

1. Read the Failures list. Group the spans by kind: name, address, date,
   identifier.
2. Add a regular expression for each machine-readable kind.
3. Extend the safety-model prompt for each kind that needs judgment.
4. Add a rule for context: when a street is removed, also remove the city
   and the postcode near it.
5. Check `retention`. If it drops, the policy removes too much.
6. Run again. Compare `removal`, `leakage`, and `retention` with the last run.
