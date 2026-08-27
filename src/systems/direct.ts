import type { SystemUnderTest, PublicCase } from '../types.js';

export { directSystem };

// baseline: one plain model call with the benchmark's own few-shot prompt
function directSystem(): SystemUnderTest {
  return {
    name: 'direct',
    info: 'one model call with the benchmark few-shot prompt, client default settings',
    async run(c, ctx) {
      let { text, usage } = await ctx.model.generate(buildPrompt(c), {
        temperature: 1,
      });
      return {
        caseId: c.id,
        system: 'direct',
        repetition: ctx.repetition,
        output: text,
        latencyMs: 0,
        ...usage,
      };
    },
  };
}

// internal helpers

// reconstructs the legalbench base prompt: instructions, examples, then the case
function buildPrompt(c: PublicCase): string {
  let parts = [c.instructions, ''];
  for (let ex of c.examples) {
    parts.push(`Q: ${ex.q}`, `A: ${ex.a}`, '');
  }
  parts.push(`Q: ${c.input} ${c.question}`, 'A:');
  return parts.join('\n');
}
