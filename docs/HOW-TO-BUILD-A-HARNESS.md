# How to build a harness

A **harness** is the system under test. It gets one case, does its work, and returns one
output. The runner starts it in a sandbox, feeds it the case, and grades the output with
the graders of the benchmark. This guide shows the protocol, the files, and the loop.

## 1. The protocol

The harness is a program. It reads one JSON object from stdin and writes one to stdout.

**stdin**

```json
{
  "publicCase": { "id": "...", "suite": "...", "task": "...", "instructions": "...", "input": "...",
                  "docs": [{ "title": "...", "text": "..." }], "examples": [{ "q": "...", "a": "..." }],
                  "question": "...", "choices": ["..."] },
  "proxyUrl": "http://127.0.0.1:PORT",
  "token": "the bearer token of this run",
  "models": { "main": "model for the guarded route", "safety": "model for the safety route" }
}
```

`docs` are passages the answer may cite as `[1][2]`, numbered from 1. `examples` are
worked examples. `question` and `choices` exist for label tasks only. `models` are the
harness's own, from its manifest.

**stdout**

```json
{ "output": "the released output", "trace": { ... } }
```

or `{ "error": "message" }`. The trace (section 4) is optional and useful.

**Models**, only through the proxy, with `Authorization: Bearer {token}`, in the OpenAI
chat-completions format:

| route | model | note |
| --- | --- | --- |
| `POST {proxyUrl}/v1/chat/completions` | `models.main` | the guarded model; every prompt is recorded and the `leakage` grader reads it |
| `POST {proxyUrl}/safety/v1/chat/completions` | `models.safety` | the trusted safety model; raw data may go here |

The proxy adds the key, injects the default temperature when the request sets none,
refuses a model the manifest does not name, and stops a run after its call limit
(`BENCH_MAX_CALLS`, default 20, or the manifest's `maxCalls`). The harness never sees
private cases, keys, or the upstream URL.

End every prompt with a **label line** that names what the model writes next (`Answer:`,
`Quotes:`, `Label:`). The test mock routes on that last line, so the instructions above
it can change without touching the tests.

## 2. The files

`harnesses/<name>/harness.json`:

```json
{
  "name": "my-harness",
  "description": "One sentence for the chart.",
  "entry": "src/entry.ts",
  "suites": ["legalbench", "redaction"],
  "models": { "main": "qwen/qwen3.6-35b-a3b", "safety": "qwen/qwen3-30b-a3b-instruct-2507" },
  "maxCalls": 120
}
```

| field | meaning |
| --- | --- |
| `suites` | the benchmarks this harness runs on; the runner skips the others |
| `models.main` | required; `models.safety` defaults to `main`. The model is part of the harness; the report shows what each system used |
| `maxCalls` | optional; a higher call limit for this harness, e.g. one call per passage |
| `image`, `imageEntry`, `dockerfile` | for a harness with dependencies: its own image (see below) |

The CLI finds the folder. A `.ts` entry runs under `tsx`.

**A minimal entry** without dependencies uses `harnesses/lib.ts`:

```ts
import { readInput, generateVia, respond } from '../../lib.js';

let { publicCase: c, proxyUrl, token, models } = await readInput();
let generate = generateVia(proxyUrl, token, models.main);
try {
  respond({ output: await generate(`${c.instructions}\n\n${c.input}\n\nAnswer:`) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}
```

`generate(prompt, temperature?)` calls the guarded model; `generateVia(proxyUrl, token,
models.safety, '/safety/v1')` gives the safety model. `harnesses/direct` is the minimum,
`harnesses/placeholder` the three-stage example.

**With dependencies** (for example the Vercel AI SDK): add `package.json`, `tsconfig.json`
and a `Dockerfile` to the folder, and name the image in the manifest:

```json
{ "image": "cucumber-harness-my-harness", "imageEntry": "/app/dist/entry.js", "dockerfile": "Dockerfile" }
```

`harnesses/cite-v1` is the template. `npm run harness:install` installs every harness's
dependencies; `npm run sandbox:build` builds every image.

## 3. A benchmark

`benchmarks/<suite>/benchmark.json` names the graders and, when they need one, the judge:

```json
{ "name": "asqa", "graders": ["str-em", "./graders.ts"], "judge": { "model": "deepseek/deepseek-v4-flash-0731" } }
```

A grader is a core grader by name (`exact`, `str-em`) or a module path. The module
exports `{ graders }`:

```ts
let graders: Grader[] = [{
  name: 'my-grader',
  description: 'One sentence that says what passes; it goes into the report glossary.',
  async grade(pub, priv, result, ctx) {
    return { grader: 'my-grader', pass: true, score: 1, detail: 'why' };
  },
}];
```

`ctx.judge(prompt)` asks the judge model through the proxy; judge usage is counted apart
from the harness. A grader never sees an errored run: the runner fails those itself.
`benchmarks/redaction/graders.ts` is deterministic; `benchmarks/cuad/graders.ts` mixes
code checks with the judge.

Cases go in `cases/`, two files each: `<id>.public.json` (`id`, `suite`, `task`,
`instructions`, `input`, and `docs`, `examples`, `question`, `choices` as needed) and
`<id>.private.json` (`id`, `graders`, and the gold data: `answer`, `qaPairs`, `clauses`,
`protected`). The file name is the id, the folder is the suite, and the loader checks both.

## 4. The trace

A harness with safety stages runs `input safety → agent → output safety` and records it:

```json
{
  "source": "the input", "transformedSource": "after input safety",
  "rawOutput": "the agent output", "releasedOutput": "after output safety",
  "stages": [
    { "name": "input-safety", "module": "regex+safety-model", "version": "1", "policy": "pii-v1",
      "mode": "hybrid", "findings": ["email:a@b.c"], "decision": "modified" },
    { "name": "agent", "module": "document-task", "version": "1", "mode": "llm", "findings": [], "decision": "pass" },
    { "name": "output-safety", "module": "...", "version": "1", "mode": "hybrid", "findings": [], "decision": "pass" }
  ]
}
```

`mode`: `passthrough`, `regex`, `llm`, `hybrid`. `decision`: `pass`, `modified`, `blocked`.
A suite without safety needs runs both safety stages as `passthrough`. The graders do not
read the trace; it is for you. `results.jsonl` keeps it for every run, so you can replay a
rule on stored drafts before you pay for a run.

## 5. The loop

1. **Run** on the development suite: `npm run bench -- --systems my-harness --suites cuad-dev --concurrency 10`.
   One case, many times: `--cases cuad-dev-104 --reps 5`.
2. **Read** `runs/<id>/report.md`: the Failures list names what went wrong per case; the
   paired comparison says whether a difference is beyond the noise. To see one case:
   ```sh
   jq 'select(.run.caseId=="cuad-dev-104") | {stages: .run.trace.stages, out: .run.output}' runs/<id>/results.jsonl
   ```
3. **Test**: `npm test` runs every harness against a mock model (`test/upstream.ts`) in
   seconds. Add a test in `test/harnesses.test.ts` when you add a stage.
4. **The official run**, when the numbers hold on the development suite:
   `BENCH_SANDBOX=docker npm run bench -- --systems direct,my-harness --suites cuad --reps 3 --concurrency 10`.

## 6. Rules

- Tune on `*-dev` suites only; the test suites are locked.
- Do not change graders or cases to make a harness pass.
- Keep the models, temperatures and cases fixed between runs you compare; `run.json` records them.
- No task-specific rules in harness code: the case gives the question, the passages and
  the answer form; the manifest says where the harness runs.
