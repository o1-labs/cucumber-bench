# LongBench v2: the plain baseline

The long-document benchmark of this repository, and the direct-call baseline every long-document
harness is measured against. The question the study asks: which changes to a harness improve
comprehension and reasoning over long documents? This page says what the data is, how the baseline
works, how to run it, what it records, and where it departs from the paper's procedure.

## The data

[LongBench v2](https://huggingface.co/datasets/zai-org/LongBench-v2) (Bai et al. 2024,
[arXiv 2412.15204](https://arxiv.org/abs/2412.15204)): 503 multiple-choice questions over one long
document each, from 8k to 2M words, in six domains. The hub names its one split `train`; that is the
published evaluation data, not training data for our experiments.

The source is pinned to one commit and one checksum in `benchmarks/longbench-v2/source.ts`. The
file is 465 MB and stays out of git, as do the cases built from it:

```sh
npx tsx benchmarks/longbench-v2/fetch.ts       # data.json at the pinned revision, sha256 checked
npx tsx benchmarks/longbench-v2/import.ts      # 503 cases -> benchmarks/longbench-v2/cases/
npx tsx benchmarks/longbench-v2/import.ts --suite longbench-v2-dev --out benchmarks/longbench-v2-dev/cases --sample 30 --seed 1
```

The dev sample's ids are in `benchmarks/longbench-v2-dev/sample.json`, tracked in git. A case keeps
the fields `_id`, `context`, `question`, `choice_A` to `choice_D`, `answer`, `domain`, `sub_domain`,
`difficulty` and `length`: the context (verbatim), the question and the four choices in their
original order go to the public case; the answer and the metadata go to the private case, which no
harness ever receives. `length` is the paper's category (short, medium, long), not a token count.

To pick cases by metadata, `select.ts` prints ids for `--cases`:

```sh
npm run bench -- --systems lb2-direct --suites longbench-v2 --cases $(npx tsx benchmarks/longbench-v2/select.ts --length short --difficulty hard --sample 10 --seed 1)
```

## The baseline: `lb2-direct` and `lb2-direct-trunc`

One model call per case: the reference implementation's zero-shot prompt
([`prompts/0shot.txt`](https://github.com/THUDM/LongBench/blob/c5ea10bcd06285223c58dfed76bbc92d22273709/prompts/0shot.txt),
verbatim) with the whole document, the question and the choices, asking for
`The correct answer is (A)`. No retrieval, no transformation, no tools, no second call, a fresh
conversation per case.

Before the call the harness counts the request with the model's own tokenizer
(`Qwen/Qwen3.6-35B-A3B`, pinned in `harnesses/lb2-direct/src/tokenizer.ts`, run locally with
tokenizers.js). The document's budget is the context limit minus the output budget, the prompt
frame and a reserve for the chat template. Two lanes, two manifests, one entry:

| harness | `overflow` | what happens to a document beyond the budget |
| --- | --- | --- |
| `lb2-direct` | `skip` | the case is skipped as `context_overflow` and reported as **unsupported**; the accuracy is over complete documents only, with the **coverage** next to it |
| `lb2-direct-trunc` | `truncate_middle` | the middle of the document is removed at token boundaries until it fits, the question, choices and instructions untouched; the trace records the original and retained token counts |

The manifest's `options` fix everything else: the context limit, the output budget, the reasoning
setting, and the versions of the harness code, the prompt and the tokenizer. The entry refuses
options that name versions it does not implement, so `run.json` always says what produced a record.
Temperature is the benchmark default the proxy injects (0). A transient request failure (network,
429, 5xx) is retried up to three times with backoff; every attempt is counted by the proxy and
listed in the trace. A wrong or malformed answer is never retried.

Setup, once:

```sh
npm run harness:install                          # tokenizers.js for lb2-direct
npx tsx harnesses/lb2-direct/fetch-tokenizer.ts  # the pinned tokenizer files (13 MB, gitignored)
```

## Running it

Long documents need long timeouts: the proxy's per-call timeout and the sandbox wall clock, which
must cover the retries.

```sh
export BENCH_TIMEOUT_MS=600000 BENCH_SANDBOX_TIMEOUT_MS=1500000

# smoke test: three short dev cases
npm run bench -- --systems lb2-direct --suites longbench-v2-dev --cases $(npx tsx benchmarks/longbench-v2/select.ts --suite longbench-v2-dev --length short --sample 3 --seed 1) --concurrency 3

# the dev subset, both lanes
npm run bench -- --systems lb2-direct,lb2-direct-trunc --suites longbench-v2-dev --concurrency 5

# the full set, in docker, three repetitions
BENCH_SANDBOX=docker npm run bench -- --systems lb2-direct,lb2-direct-trunc --suites longbench-v2 --reps 3 --concurrency 5

# an interrupted run: the same flags, plus --resume
npm run bench -- --resume runs/<id> --systems lb2-direct,lb2-direct-trunc --suites longbench-v2 --reps 3 --concurrency 5

# the numbers
npx tsx benchmarks/longbench-v2/summary.ts runs/<id>
```

`npm run sandbox:build` builds the docker image after `fetch-tokenizer.ts`.

## Scoring

The grader `mc-answer` (`benchmarks/longbench-v2/graders.ts`) is deterministic and shared by every
harness on this benchmark. It reads the letter in `The correct answer is (X)`, with or without
parentheses, with a colon, in any case, and ignores markdown characters and `<think>` blocks. An
output with no answer form is **invalid**; one that commits to several different letters is
**ambiguous**, also invalid; a bare letter anywhere in the text is not an answer. Invalid answers
fail. No model grades or repairs an answer.

`summary.ts` prints, per system, the counts behind the accuracy:

- **correct, incorrect, invalid, failed, unsupported**: one outcome per run. Failed: the run or
  the grade errored, retries exhausted. Unsupported: skipped as `context_overflow`.
- **eligible** = runs − unsupported. **accuracy** = correct / eligible: failed and invalid stay in the
  denominator. **coverage** = eligible / runs.
- breakdowns by difficulty, length, domain and sub-domain, each with its n and its own coverage;
  for a truncating lane, complete and truncated documents apart, with the mean share retained;
  for the full suite, the numbers without the dev sample.

## What a run records

`run.json`: the model, the options (limits, overflow policy, reasoning, the three versions), the
case ids and a hash of their content, the git state, and every resume. `results.jsonl`, per run:
the raw response as `output`, the parsed letter as the grade's `extracted`, the correctness, the
status, latency, token usage and provider cost (the proxy's accounting; n/a for a provider that
reports none), and the trace: the document's token count and budget, the truncation counts, the
effective generation settings, the provider's token counts, the finish reason, the reasoning text
inside `<think>` in `rawOutput`, and every attempt with its outcome and time.

A later harness that preprocesses documents (a graph, extracted facts, an index) records that work
as its own stage in the trace, with its own model calls, so its cost stands apart from the answer
call. The proxy counts all calls of a run together; a preprocessing cost that must be split from
the answer call goes into the stage's findings.

## Differences from the paper's procedure

- **Generation settings.** The paper samples at temperature 0.1 with 128 output tokens and no
  reasoning. This baseline uses the benchmark default of 0, and gives the model's built-in
  reasoning a 16,384-token output budget, on and recorded explicitly. A one-call baseline does
  not disable the model's native capabilities.
- **Truncation.** The paper cuts the middle of the whole tokenized prompt. `lb2-direct-trunc` cuts
  only the document, and keeps the question, choices and instructions whole. `lb2-direct` does not
  cut at all; the paper has no skip lane.
- **The extractor.** The paper's regex is case-sensitive and takes the first match. Ours ignores
  case, a colon and markdown, and rejects several different letters instead of taking the first.
- **No compensation.** The paper's optional scoring gives a quarter point to a missing answer; here
  a missing answer is invalid and scores zero.
- **The provider.** The model runs on a hosted API through the proxy, not a local vLLM server; the
  provider's serving limit (262,144 tokens) is the context limit.
- **The tokenizer** is the model's own, as in the paper for open models, run in JavaScript; a
  document is counted in 1 MB pieces, which can differ from a whole-text count by one token per
  piece.
