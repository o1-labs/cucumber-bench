// the baseline prompt, shared by the direct lanes so they differ in exactly one thing.
// no runtime imports, so it lives in the base image alongside lib.ts.
import type { PublicCase } from '../src/types.js';

export { buildPrompt };

// label tasks get the benchmark's own few-shot prompt. document tasks get the
// instructions, the worked examples when the benchmark has them, then the input.
function buildPrompt(c: PublicCase): string {
  if (c.choices) {
    let parts = [c.instructions, ''];
    for (let ex of c.examples ?? []) parts.push(`Q: ${ex.q}`, `A: ${ex.a}`, '');
    parts.push(`Q: ${c.input} ${c.question ?? ''}`.trim(), 'A:');
    return parts.join('\n');
  }
  if (!c.examples?.length) return `${c.instructions}\n\n${c.input}`;
  let demos = c.examples.map((ex) => `${ex.q}\nAnswer: ${ex.a}`);
  return [c.instructions, ...demos, `${c.input}\nAnswer:`].join('\n\n\n');
}
