# Benchmark protocol

This is the shared protocol for benchmark work. The goal is to keep runs comparable and make the claims easy to verify.

Most of the protocol is already enforced by the code:

- The proxy restricts model access and records usage.
- `runs/<runId>/run.json` records the configuration and Git state.
- `runs/<runId>/report.md` calculates paired comparisons.

`npm run bench` writes these records, with `results.jsonl` (every run, trace, and grade) and
`chart.html`, into `runs/<runId>/`. Working runs stay out of Git. Pin a final run with
`npm run store -- runs/<runId>`: it copies the record into `runs/pinned/<runId>`, which is
tracked, with `results.jsonl` slimmed of the prompt copies the repo already holds, and it
rebuilds the site pages in `docs/` from every pinned run. Commit `runs/pinned/` and `docs/`
together: the site shows exactly the pinned set. Build a shared report of a locked test set
with `--no-details`.

This document covers the rules that code cannot enforce. The generated run records remain the source of truth, so we do not maintain separate run-manifest, report, or result-schema templates.

## Comparison lanes

| Lane | System                                                    | Purpose           |
| ---- | --------------------------------------------------------- | ----------------- |
| A    | A stronger reference model using `direct`                 | Reference level   |
| B    | Control model using `direct`                              | Control           |
| C    | Same model as B using the custom harness                  | Harness treatment |
| D    | Optional: specialised model and harness, such as a fine-tuned model | Stack treatment   |
| B2/C2 | Optional: a second control model, `direct` and the same frozen harness | Transfer check |

- B versus C measures the **harness effect**. Both lanes must use the same model, provider, settings, cases, and repetitions.
- D versus B compares two **stacks**. The model and harness can both change, so describe the result as a stack comparison.
- A provides a reference level. A comparison with A cannot show causality because the models differ.
- B2 versus C2 measures the **transfer** of the frozen harness to a second model. B2 and C2
  must match each other like B and C. Declare a transfer check before locked-test outputs are
  inspected; one added after is a separate follow-up experiment.

Before a locked test run, the experiment plan (`docs/EXPERIMENT-PLAN.md`) must state: the
decision the run supports, why each control and reference model was selected, the primary
metric and the metrics that must not regress, the cost and latency limits, and any planned
transfer checks.

## Data and tuning

- Fine-tuning can use training or development data. Prompt changes, harness logic, and thresholds use `*-dev` suites. Never tune on the test suite.
- Use a fixed sample of development cases during iteration. A new random sample for every edit makes runs difficult to compare.
- Split development and test cases by source document. Related cases from the same document must stay in one split.
- Freeze the code and configuration before a test run.
- A test run consumes the test set. Any change made after reviewing the result starts a new experiment and must be disclosed in the report.
- Do not repeat test runs and select the best result.

## Model and provider pinning

- Each harness declares its models and providers in `harness.json`. The proxy rejects model calls that are not declared.
- Final runs must use exact model versions and providers. Do not use `latest` aliases or automatic provider routing.
- Lanes B and C must use the same provider as well as the same model. Paired lanes must
  match on everything the request sets, temperature above all; declare any other difference.
- Final runs use `BENCH_SANDBOX=docker` and a clean Git commit. `run.json` records the commit and any changed files.
- Use several repetitions when model output or harness behaviour can vary.
- Do not truncate inputs without reporting it. Compare `tokensIn` with the expected input size and investigate material differences. A lane with provider-side truncation is invalid unless the protocol explicitly allows and reports it.

## Scoring

- The benchmark graders declared in `benchmark.json` produce the official result.
- Use a judge model only for criteria that code cannot check.
- Run the judge at temperature 0. Its model and provider are in `run.json`, its usage is in
  every result record, and its prompts are part of the grader code, versioned by the commit
  that `run.json` records.
- Sandbox and grader errors count as failed grades. The report also shows the error rate separately.
- Do not change benchmark cases or graders because a harness performs poorly.
- If the benchmark provides an official scorer, reproduce and pin that implementation. A custom judge does not become the official scorer.
- When the official scorer names a judge model (an LLM or a checkpoint), use exactly that
  model, or the closest available one, and record the substitution next to the numbers.
  Example: ALCE scores citations with a pinned NLI checkpoint; our `citation-*` graders
  approximate it with the shared judge, and a report that uses them must say so.
- Check judge sensitivity before a shared claim: regrade the run with a judge from another
  family (`npm run regrade -- runs/<id> --judge z-ai/glm-5.3-flash`) and report both when
  they disagree.

## Reporting

- Share the generated `report.md` and `chart.html`.
- The paired B-versus-C comparison supports the harness claim.
- If the 95% confidence interval contains 0, the run does not show a clear measurable difference between the systems.
- Compare runs only when they use the same suite and cases.
- A merged chart created from different case sets with `--combine` must say this in its section title. Treat it as a combined view, not a direct comparison.
- List every protocol deviation in the shared report or post.

## Adding a benchmark

Before adding a benchmark:

- Name the capability it measures and the decision the result will support.
- Confirm whether it evaluates generated system outputs or validates an evaluator.
- Pin the source repository, commit or release, and licence in the `import.ts` header.
- Make `import.ts` reconstruct cases deterministically from a fixed seed.
- Make the import fail when source checksums, case counts, or gold data are invalid.
- Create the development split before reviewing model outputs.
- Split development and test data by source document.
- Declare each grader in `benchmark.json`.
- Give every grader a short description for the report glossary.
- Test graders against known answers.
- Declare the judge model in `benchmark.json` when a grader needs one.
- Keep raw source data outside Git. Put the complete reconstruction command in the import script header.

## Candidate benchmarks

| Capability            | Candidates                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abstention            | [AbstentionBench](https://github.com/facebookresearch/AbstentionBench), [SelfAware](https://github.com/yinzhangyue/SelfAware)                                                   |
| Long context          | [LongBench v2](https://github.com/THUDM/LongBench), [RULER](https://github.com/NVIDIA/RULER). Use a fixed sample for RULER during development because the full matrix is large. |
| Instruction following | [IFEval](https://github.com/google-research/google-research/tree/master/instruction_following_eval), [FollowBench](https://github.com/YJiangcm/FollowBench)                     |
| Summarisation         | [SummEval](https://github.com/Yale-LILY/SummEval), [FRANK](https://github.com/artidoro/frank). These are output corpora for validating evaluators.                              |
| Factuality            | [TruthfulQA](https://github.com/sylinrl/TruthfulQA), [RAGTruth](https://github.com/ParticleMedia/RAGTruth). RAGTruth is mainly useful for validating a detector or grader.      |
| Evidence reasoning    | [ContractNLI](https://github.com/stanfordnlp/contract-nli)                                                                                                                      |
