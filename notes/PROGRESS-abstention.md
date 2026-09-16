# Abstention workstream — progress

**Anaïs · 16 September 2026 · `abstention` branch of `cucumber-bench`**

---

## Summary

The repository had no abstention benchmark. It now has one: 160 cases with
hand-reviewed gold, three graders designed so that a system which declines
everything cannot score well, and a judge validated at 96% against 48 responses
I read myself. Baselines are measured for two models across three lanes.

The headline result is that **abstention is much weaker than it first appeared,
and there is a great deal of room to improve it.** No system tested — frontier
model included — declines more than two thirds of the questions that have no
answer.

---

## The baseline

60 development cases, 3 repetitions, 180 runs per lane.

| lane | model | abstention | answered | answer-correct | cost/run | latency |
| --- | --- | --- | --- | --- | --- | --- |
| `direct` | Qwen3.6-35B-A3B, t=1 | 63% | 83% | 48% | $0.0013 | 18.8s |
| `direct-t0` | Qwen3.6-35B-A3B, t=0 | 66% | 76% | 51% | $0.0014 | 22.5s |
| `direct-kimi` | Kimi K2.5, t=0 | 61% | 70% | **67%** | $0.0024 | 31.5s |

- **abstention** — on a question with no definite answer, the model declines
- **answered** — on a question that has an answer, it commits rather than dodging
- **answer-correct** — that answer is right

The second grader is what stops the benchmark being gameable: without it, a model
replying *"I don't know"* to everything scores 100% on abstention.

---

## 1. There is far more headroom than expected

**A third of unanswerable questions get a confident answer from every model
tested.** Nothing clears 66%.

This matters for the investment decision. An earlier, smaller sample put
abstention at 86–95%, which would have meant a harness fighting over 5–10 points
against a near-ceiling baseline. The real figure leaves **thirty-plus points** on
the table. Whatever a harness can recover, there is room for it to show.

---

## 2. The frontier model is better calibrated, not better overall

The one comparison that clears the noise floor:

**`answer-correct`, Qwen vs Kimi: −18 points, 95% interval −34 … −3.**

The profile is more interesting than the number. Kimi **answers less often** (70%
vs 83%) but is **far more accurate when it does** (67% vs 48%). It declines more
readily on what it does not know, and is right more often when it commits.

That is precisely the capability this workstream exists to measure, and it is
worth more than a uniform quality difference would be. It costs 1.8× and runs
1.7× slower — a trade that looks different in a legal or medical setting, where
being right when you commit is the whole point.

No other pairwise comparison clears the noise floor: all three systems abstain at
statistically indistinguishable rates.

---

## 3. A small dev suite moves the point estimate, not just the error bars

This is the methodological finding I would most want the other workstreams to
take away.

The repo's `*-dev` convention is 15 cases, sized for suites where one case is a
26,000-word contract. Mine are one-line questions at $0.0013 a run. At 16 cases:

| | 16 cases | 60 cases |
| --- | --- | --- |
| abstention (`direct`) | 95% | **63%** |
| answer-correct (`direct`) | 67% | **48%** |

A thirty-point shift. That is not variance around a stable value — the small
sample happened to hold unusually easy questions, and every number built on it
was optimistic. Three consecutive runs of the same system on those 16 cases had
already scored 90, 81 and 95 on abstention, a ±14 point spread from sampling
alone.

**Small suites are not merely imprecise. They can be biased, and you cannot tell
from inside the suite.** At 60 cases the intervals roughly halved and one real
effect became visible.

A direct consequence: an earlier apparent finding of mine, that decoding
temperature traded abstention against answering, **did not survive the larger
sample.** The effect was −2 points (−9 … +5) on abstention and −2 (−11 … +6) on
answer-correct — indistinguishable from zero, and with the sign reversed from the
small-sample result. The matched-control lane is what made that visible, and is
the reason to keep it.

---

## 4. Published benchmarks carry defects that quietly distort results

SelfAware's two halves are not built to the same standard, and the
[paper](https://aclanthology.org/2023.findings-acl.551.pdf) says so if you read
closely.

The **unanswerable** half is careful work: 2,858 candidates from Quora and
HowStuffWorks, three annotators checking each independently with search engines,
only unanimous agreement kept — 1,032 survived.

The **answerable** half was taken wholesale from SQuAD, HotpotQA and TriviaQA
with no per-item review described anywhere. Three failure modes follow:

- **SQuAD questions lose the paragraph they were written against.** *"How many
  passengers will the new airport be able to handle?"* (gold: 120 million).
  Which airport? A well-calibrated model *should* decline — and the grader that
  exists to catch over-abstention scores that decline as a failure. Measured, not
  theorised: the model declined *"What is the Triangle?"* three times out of three.
- **TriviaQA gold is Wikipedia alias expansion**, up to 358 strings per item
  including fragments like `gamy`, `sun d` and an emoji, plus one item whose
  answer list belongs to a different question entirely.
- **HotpotQA counts are frozen at a 2017 snapshot.** *"The sitcom Nancy Travis
  starred in as Vanessa Baxter had how many episodes total?"* → gold `130`. That
  was the total when ABC cancelled *Last Man Standing*; it ran to 194 on Fox.

Eight cases needed hand correction; each is recorded with its reasoning in an
`OVERRIDES` table keyed by source question id, reviewed before any system was
built and never in response to a score.

**Takeaway: do not import a benchmark and trust its gold.** A screening pass
costs an hour and is the difference between measuring a system and measuring the
dataset's defects.

---

## What the numbers do not yet support

- **Abstention differences between the three systems.** All within the noise
  floor. Only the `answer-correct` gap to Kimi is established.
- **Any claim about a harness.** None exists yet; these are baselines.
- **Contamination is unquantified.** SelfAware has been public since 2023 and
  both models were almost certainly trained on it, labels included. Some of what
  is measured may be recall rather than calibration. Not fixable by cleaning
  anything, and it strengthens the case for a passage-grounded second suite where
  memorisation helps far less.
- **`answered` conflates two different failures.** Over-abstention on an
  ambiguous question is a calibration defect; honest ignorance of an obscure fact
  is a knowledge limit, and the *right* behaviour when knowledge is absent. A
  worked example: on one obscure question the model fabricated two different wrong
  answers across three repetitions and correctly declined on the third —
  `answered` passed both fabrications and failed the honest decline. The graders
  must be read together.

---

## Open items

**Shared code — needs a decision from the repo owner.** Three one-line fixes,
none specific to this workstream:

1. `loadProject` demands `HF_TOKEN` even when the harness needing it is not
   selected, blocking every run for anyone without a HuggingFace account.
2. `project.ts:67–68` read `process.env` directly rather than via the helper that
   treats blank as unset, so a blank `BENCH_MAX_CALLS` becomes a limit of **0** —
   and `.env.example` ships it blank while promising blanks are safe. It surfaces
   as a 429 that looks exactly like provider rate-limiting.
3. Nothing pins the OpenRouter provider, which `PROTOCOL.md` prohibits.

**Operational.** 1% of runs hit the 300-second sandbox timeout at concurrency 10,
consistent with provider throttling. Drop to 5 for the locked run so avoidable
errors do not count as failed grades.

**Budget and key.** $1.20 spent of $100; a complete locked test run across every
lane costs about $2. Budget is not a constraint. **The key expires 4 October**,
which is — it has to cover harness development and the locked run.

---

## Next

1. The experiment-plan section: decision, primary metric, must-not-regress
   metrics, cost and latency limits. Half a day, and it forces the `answered`
   ambiguity above to be settled before it can distort a result.
2. **The harness.** The data already suggests a candidate: when the model knows
   an answer it repeats itself across repetitions; when it fabricates, it
   contradicts itself. One question produced "General Fiddle", "The Grouch" and a
   decline on three attempts; another gave 167, 164 and 152. Sampling three times
   and abstaining on disagreement is cheap, needs no extra knowledge, and can be
   prototyped against stored outputs before spending anything.
3. Freeze, then the locked 100-case run — all lanes in one run, once.

Beyond that: TruthfulQA for the factuality half of the workstream, and a
passage-grounded abstention suite (SQuAD 2.0 or ContractNLI), where the question
is not "do you know this" but "does this record support an answer" — much closer
to what the legal and medical interviews actually described.
