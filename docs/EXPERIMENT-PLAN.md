# Experiment plan

The intended design and its rationale. What actually ran is in `runs/<id>/run.json`; the
results are in `runs/<id>/report.md`. When they differ, say so in the shared post.

## The decision

Can we establish a technical edge with a custom harness on top of a plain, generally
available model? Concretely: should we invest in a task-specific harness for an economical
open-weight model, because it gives a meaningful quality improvement over the same model
used directly, within acceptable cost and latency limits?

## The model matrix

| lane | system                                                                                               | purpose                                                 |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A    | `moonshotai/kimi-k2.5`, `direct`                                                                     | reference: a stronger affordable model                  |
| B    | `qwen/qwen3.6-35b-a3b`, `direct`                                                                     | control                                                 |
| C    | `qwen/qwen3.6-35b-a3b`, custom harness                                                               | can we establish a technical edge via a custom harness? |
| D    | optional: a specialised model inside the harness (the existing `cuad-qwen3` finetune in `review-ft`) | what a task-specific model adds; not the study's goal   |
| B2   | optional: `qwen/qwen3.8-27b`, `direct`                                                               | transfer control                                        |
| C2   | optional: `qwen/qwen3.8-27b`, the same frozen harness                                                | transfer treatment                                      |

Permitted claims: B vs C is the harness effect on Qwen3.6. B2 vs C2 is the transfer of the
frozen harness to Qwen3.8. D vs B is a **stack comparison**: a stack is the model and the
harness together, both change at once, so the result cannot isolate either one. A is a
reference, never causal.

Lane D is optional. Do not fine-tune or post-train models: the goal of this study is the
harness alone. Lane D exists only to place the one existing finetune next to the control.

## Why DeepSeek flash as the judge, Kimi k2.5 as lane A

- The judge must come from a family no lane uses: a judge never grades its own answers.
- Judge `deepseek/deepseek-v4-flash-0731`: the cheapest capable judge of the candidate
  families ($0.065/M input; grading makes many small calls), a dated snapshot, and every
  stored grade used it, so runs stay comparable.
- Lane A `moonshotai/kimi-k2.5`: no overlap with the judge family, its 262K context covers
  every case, and the full cuad-hard reference lane costs about $5. `z-ai/glm-5.3` is the
  stronger, pricier alternative (about $15).
- Judge sensitivity: before a shared claim, regrade with `z-ai/glm-5.3-flash` and report
  both results when they disagree (see the protocol).
- When a benchmark's official release names its own judge or scorer model, that model wins
  over this choice (see the protocol's scoring rules).

## Why Qwen3.6-35B-A3B as the control

- Its native 262K context covers the target documents; no extended-context method needed.
- Sparse: 35B total, ~3B active parameters per token, so runs are cheap to repeat.
  Self-hosting stays possible: a nice-to-have, not a requirement.
- Open weights give more control than a closed frontier model, if we later decide to
  customize or fine-tune seriously.
- It is a general-purpose, non-task-specific control model (post-trained, not a pretrained
  base checkpoint), so B vs C measures harness value, not fine-tuning value.
- Existing results show usable performance with headroom (54% clause recall on cuad-hard).

**Limitation:** B vs C holds for this exact Qwen3.6 configuration. It does not show that the
harness improves every model or beats stronger models; lane A shows that gap.

## The transfer rule (Qwen3.8)

Freeze the harness, prompts, graders, metrics, and thresholds first. Then run B2/C2 on the
same cases, provider class, and repetitions. Report it separately. Never tune the harness
from locked-test outputs; a transfer check added after seeing test results is a new experiment.
