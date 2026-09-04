# How to build a harness

A **harness** is the system under test: one case in, one output out. The runner starts it
in a sandbox, feeds it the public case, and grades the output with the benchmark's graders.

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
  "models": { "main": "...", "safety": "...", "compose": "..." }
}
```

`docs` are passages the answer may cite as `[1][2]`, numbered from 1. `examples` are worked
examples. `question` and `choices` exist for label tasks only. `models` are the manifest's,
extra roles included.

**stdout**: `{ "output": "...", "trace": { ... } }` or `{ "error": "message" }`.

**Models**, only through the proxy, with `Authorization: Bearer {token}`, in the OpenAI
chat-completions format:

| route | note |
| --- | --- |
| `POST {proxyUrl}/v1/chat/completions` | the guarded route; every prompt is recorded, the `leakage` grader reads them |
| `POST {proxyUrl}/safety/v1/chat/completions` | the trusted safety route; raw data may go here |

The proxy adds the key, injects the default temperature when the request sets none, refuses
a model the manifest does not name, and stops the run at its call limit (`BENCH_MAX_CALLS`,
default 20, or the manifest's `maxCalls`). The harness never sees private cases, keys, or
upstream URLs.

End every prompt with a **label line** that names what the model writes next (`Answer:`,
`Quotes:`). The test mock routes on that last line, so the instructions above it can change
without touching the tests.

## 2. The manifest

`harnesses/<name>/harness.json`:

```json
{
  "name": "my-harness",
  "description": "One sentence for the chart.",
  "entry": "src/entry.ts",
  "suites": ["cuad-hard", "cuad-hard-dev"],
  "models": { "main": "qwen/qwen3.6-35b-a3b" }
}
```

| field | meaning |
| --- | --- |
| `suites` | the benchmarks this harness runs on; the runner skips the others |
| `models` | `main` required, `safety` defaults to `main`, further roles (e.g. `compose`) as needed; all usable on the guarded route |
| `providers` | per-model upstreams: `{ "<model-id>": { "baseUrl": "...", "keyEnv": "HF_TOKEN" } }`. `keyEnv` names the env variable with the key. A model not named uses `BENCH_BASE_URL` |
| `maxCalls` | a higher call limit, e.g. one call per passage |
| `image`, `imageEntry`, `dockerfile` | for a harness with dependencies: its own docker image |

**The same harness with another model** (e.g. a finetune): a second folder whose manifest
points at the first one's entry:

```json
{ "name": "direct-ft", "entry": "../direct/src/entry.ts", "suites": ["cuad-hard"],
  "models": { "main": "my-finetune" },
  "providers": { "my-finetune": { "baseUrl": "http://my-server:11434/v1" } } }
```

For docker mode, also name the first harness's `image` and `imageEntry`.

## 3. The entry

Without dependencies, use `harnesses/lib.ts`:

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

`generateVia(proxyUrl, token, model, route?)` binds one model; `'/safety/v1'` gives the
safety route. Examples: `harnesses/direct` is the minimum, `harnesses/placeholder` a
three-stage pipeline, `harnesses/review-ft` a full multi-model pipeline, all without
dependencies.

With dependencies (e.g. the Vercel AI SDK): add `package.json`, `tsconfig.json` and a
`Dockerfile`, and name the image in the manifest. `harnesses/cite-v1` is the template.
`npm run harness:install` installs all dependencies; `npm run sandbox:build` builds the
images.

## 4. A benchmark

`benchmarks/<suite>/benchmark.json` names the graders and, when they need one, the judge:

```json
{ "name": "asqa", "graders": ["str-em", "./graders.ts"], "judge": { "model": "deepseek/deepseek-v4-flash-0731" } }
```

A grader is a core grader by name (`exact`, `str-em`) or a module exporting `{ graders }`:

```ts
let graders: Grader[] = [{
  name: 'my-grader',
  description: 'One sentence that says what passes; it goes into the glossary.',
  async grade(pub, priv, result, ctx) {
    return { grader: 'my-grader', pass: true, score: 1, detail: 'why' };
  },
}];
```

`ctx.judge(prompt)` asks the judge model; its usage is counted apart from the harness. A
grader never sees an errored run: the runner fails those itself.

Cases are two files in `cases/`: `<id>.public.json` (what the system sees) and
`<id>.private.json` (`graders` and the gold data). The file name is the id, the folder is
the suite, and the loader checks both. An `import.ts` rebuilds the cases deterministically
from a pinned source; raw data stays out of Git.

## 5. The trace

A harness records its stages, `input safety → agent → output safety`:

```json
{
  "source": "the input", "transformedSource": "after input safety",
  "rawOutput": "the agent output", "releasedOutput": "after output safety",
  "stages": [
    { "name": "input-safety", "module": "regex+safety-model", "version": "1", "policy": "pii-v1",
      "mode": "hybrid", "findings": ["email:a@b.c"], "decision": "modified" }
  ]
}
```

`mode`: `passthrough`, `regex`, `llm`, `hybrid`. `decision`: `pass`, `modified`, `blocked`.
A stage without work is `passthrough`. Graders do not read the trace; it is for you:
`results.jsonl` keeps it, so you can replay a changed rule on stored drafts before you pay
for a run.

## 6. The loop

1. **Run** on the dev suite: `npm run bench -- --systems my-harness --suites cuad-hard-dev --concurrency 10`.
   One case, many times: `--cases cuad-hard-dev-104 --reps 5`.
2. **Read** `runs/<id>/report.md`: the Failures list per case, the paired comparison for
   the noise. One case in detail:
   `jq 'select(.run.caseId=="cuad-hard-dev-104")' runs/<id>/results.jsonl`
3. **Test**: `npm test` runs every harness against the mock model in seconds. Add a test in
   `test/harnesses.test.ts` when you add a stage.
4. **The final run**, when the dev numbers hold:
   `BENCH_SANDBOX=docker npm run bench -- --systems direct,my-harness --suites cuad-hard --reps 3 --concurrency 10`,
   then `npm run store -- runs/<id>` to pin it and publish its chart.

## 7. Rules

- Use the control model and settings from [EXPERIMENT-PLAN.md](EXPERIMENT-PLAN.md)
  (`qwen/qwen3.6-35b-a3b` today), or document the exception there.
- Tune on `*-dev` suites only; the test suites are locked.
- Do not change graders or cases to make a harness pass.
- Keep models, temperatures and cases fixed between runs you compare; `run.json` records them.
- No task-specific rules in harness code: the case gives the question, the passages and the
  answer form; the manifest says where the harness runs.

The full experiment rules (lanes, splits, pinning, reporting): [PROTOCOL.md](PROTOCOL.md).
