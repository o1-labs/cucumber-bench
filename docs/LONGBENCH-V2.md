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

A third lane, `lb2-direct-kimi`, is the same entry and options with `moonshotai/kimi-k2.5` as the
model: the frontier-model baseline. Its document counts still come from the pinned Qwen tokenizer,
a proxy for Kimi's own; Kimi's context limit on the provider is the same 262,144 tokens.

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

## The custom harnesses: `lb2-nav` and `lb2-custom`

Two harnesses built on the baseline, both with every document length in scope: neither skips nor
truncates, so their coverage is 100%. Both keep the baseline's answer form, so `mc-answer` grades
them unchanged. Both record every model reply in the trace.

**`lb2-nav`, the navigator.** The model reads the text with two commands, one per turn in one
conversation: `search: <words>` (every line containing the words, up to 20 hits with line numbers
and a snippet) and `read: <from>-<to>` (a range of lines, at most 4,096 tokens). A reply without a
command is the answer; at 24 steps the answer is forced. A document that fits the context is given
whole, in the baseline's prompt, with the commands offered for checking passages; one that does not
is navigated from its head. An empty reply (the model's reasoning looped until the output budget
was spent) is repeated once with reasoning off.

**`lb2-custom`, evidence before the answer.** Single-turn calls only:

1. **Frame**, no document: the constraints of the question (who, when, which source) and the terms
   to look for.
2. **Locate**, no model: the document is cut into chunks of 4,096 tokens at line boundaries and
   ranked against the question, the choices and the terms (BM25); the best 64 are selected, or
   every chunk when there are at most 64, which the trace calls a complete scan.
3. **Extract**: one call per selected chunk, eight in flight, reasoning off, with the constraints
   in view, quoting the passages that bear on the question or on a choice. A quote is kept only
   when it is found in the chunk, with its offsets; a wrapped quote is joined, an ellipsis is
   looked up as its pieces. The lines containing a framed term join the quotes, found by the
   harness alone, with one line of context.
4. **Answer**: the baseline's call, with the passages laid out in document order after the whole
   document when it fits the context, or as the text when it does not. The scan's tags (which
   choice a quote supports) stay in the record and never reach the answer call.

## Results on the dev set (30 cases, one repetition each)

The 27 cases the baseline can take are the paired comparison; the 3 long documents (two code
repositories of 3.3M and 3.6M tokens, one grammar book of 296k) are coverage.

| lane | run | right of 27 | long, of 3 | invalid | cost |
| --- | --- | --- | --- | --- | --- |
| `lb2-direct` | three runs, 09-09 to 09-14 | 12, 12, 13 | unsupported | 1 | ~$0.45 |
| `lb2-nav` v1, navigation only | 05-31 | 6 | 1 | 5 | $0.98 |
| `lb2-nav` v2, whole text when it fits | 06-01 | 15 | 0 | 1 | $0.57 |
| `lb2-custom` v3, document + passages | 12-28 | 13 | 2 | 0 | $0.92 |
| `lb2-custom` v3, passages alone | 12-28 | 11 | 2 | 0 | $0.65 |
| `lb2-custom` v4, + term hits | 12-59 | 14 | 2 | 0 | $0.89 |
| `lb2-custom` v9, + notes for and against each choice | 15-03 | 13 | 3 | 1 | $1.55 |

**The noise band.** Three runs of the baseline, same prompt, temperature 0, flipped 4 of 27
letters between any two of them while scoring 12, 12 and 13. A one-repetition difference of one or
two cases on this set means nothing. No lane above clears that band on the 27 shared cases.

**What did measure.** Coverage: the custom harness answers every document and had 2 of the 3 long
ones right in three runs, where the baseline has none; the navigator had 1. Invalid answers: the
custom harness had none in three runs; the baseline refuses about one case in 30 with "none of the
above" or "N/A". In `lb2-nav` v2 the model never used a command when it had the whole text (0 of
26 cases), so that lane is the baseline plus navigation for overflow.

**What did not.** Each of these was tried on the dev set or on a chosen subset and removed:

- Pure navigation (`lb2-nav` v1): the model read a median 1% of the text before answering and
  looped on one command turn in three; 6 of 27.
- The scan's tags in the answer prompt: the answer followed the tags; two right baseline answers
  flipped.
- A verification call without the document (v2): 4 revisions, 0 corrections, 2 right answers
  overturned.
- A per-choice deliberation instruction in the answer call (v4): 13 against 14 without it, and
  one answer turned into a refusal.
- One focused check call per choice with the document in view (v5, eight chosen cases): one
  gain, one loss, and in three cases all four statements were confirmed or all contradicted; at
  four times the cost.
- High reasoning effort asked of the provider: ignored, 1k to 4k reasoning tokens as before.
- A challenge call against the drafted answer, then a decision call with both in view (v7, v8,
  eight chosen cases): the challenge quoted the counter-evidence and closed with "stands"; the
  decision, shown the draft, kept it in all eight cases.
- Notes for and against each choice before any draft (v9): 4 of 8 on the chosen cases, then 13
  of 27 on the dev set at $1.55: the two cases it had fixed came back wrong. The eight-case gain
  was run-to-run variance.

The frozen harness is version 10, the version 4 pipeline without any second reading.

**The failures that remain** are the model's final judgment with the text in view, not
retrieval: in the calendar-day, floors and dialogue cases the decisive lines were in the passages
and the model reasoned past them in under 1,000 reasoning tokens. Shown its own draft next to
evidence against it, it keeps the draft. Near-paraphrase options and inferences the text does not
state stay wrong in every lane.

## Running it

Long documents need long timeouts: the proxy's per-call timeout and the sandbox wall clock, which
must cover the retries.

```sh
export BENCH_TIMEOUT_MS=600000 BENCH_SANDBOX_TIMEOUT_MS=1500000

# smoke test: three short dev cases
npm run bench -- --systems lb2-direct --suites longbench-v2-dev --cases $(npx tsx benchmarks/longbench-v2/select.ts --suite longbench-v2-dev --length short --sample 3 --seed 1) --concurrency 3

# the dev subset, both lanes
npm run bench -- --systems lb2-direct,lb2-direct-trunc --suites longbench-v2-dev --concurrency 5

# the full set, in docker, three repetitions (npm run sandbox:build first: the image holds lb2-custom too)
BENCH_SANDBOX=docker npm run bench -- --systems lb2-direct,lb2-custom --suites longbench-v2 --reps 3 --concurrency 3

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
