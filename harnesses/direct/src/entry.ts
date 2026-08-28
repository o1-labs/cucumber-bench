// the baseline: one plain model call, no safety stages. it runs in the same
// sandbox as every other harness, so all systems are measured under identical conditions.
import { readInput, generateVia, respond } from '../../lib.js';
import type { PublicCase } from '../../../src/types.js';

let { publicCase: c, proxyUrl, token, model } = await readInput();
let generate = generateVia(proxyUrl, token, model);

try {
  respond({ output: await generate(buildPrompt(c), 1) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// label tasks get the benchmark's own few-shot prompt; document tasks get instructions + document
function buildPrompt(c: PublicCase): string {
  if (!c.choices) return `${c.instructions}\n\n${c.input}`;
  let parts = [c.instructions, ''];
  for (let ex of c.examples ?? []) parts.push(`Q: ${ex.q}`, `A: ${ex.a}`, '');
  parts.push(`Q: ${c.input} ${c.question ?? ''}`.trim(), 'A:');
  return parts.join('\n');
}
