import type { SystemUnderTest, Usage } from '../types.js';

export { harnessSystem };

// TODO placeholder for the real custom harness. this two-step chain only proves
// that a multi-call system runs through the same contract and shows up in the report.
function harnessSystem(): SystemUnderTest {
  return {
    name: 'harness',
    async run(c, ctx) {
      // step 1: free-form analysis
      let analysis = await ctx.model.generate(
        `${c.instructions}\n\nCase: ${c.input}\n\nQuestion: ${c.question}\n` +
          `Analyze the case step by step in at most 5 short sentences. Do not state a final answer yet.`,
        { system: 'You are a careful legal analyst.' },
      );

      // step 2: commit to one label
      let decision = await ctx.model.generate(
        `${c.instructions}\n\nCase: ${c.input}\n\nQuestion: ${c.question}\n` +
          `Analysis:\n${analysis.text}\n\n` +
          `Based on this analysis, answer with exactly one of: ${c.choices.join(', ')}. Reply with the label only.`,
      );

      return {
        caseId: c.id,
        system: 'harness',
        repetition: ctx.repetition,
        output: decision.text,
        latencyMs: 0,
        ...addUsage(analysis.usage, decision.usage),
      };
    },
  };
}

// internal helpers

function addUsage(a: Usage, b: Usage): Usage {
  return {
    modelCalls: a.modelCalls + b.modelCalls,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
  };
}
