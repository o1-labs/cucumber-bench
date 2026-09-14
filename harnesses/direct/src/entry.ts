// the baseline: one plain model call, no safety stages. it runs in the same
// sandbox as every other harness, so all systems are measured under identical conditions.
//
// temperature 1 is deliberate and is what makes this lane the STATUS QUO baseline: it is
// what a generic chat interface gives you. the matched control at the benchmark default is
// the separate direct-t0 lane, so the two questions stay separable:
//   harness vs direct     - is the harness better than what people use today?
//   harness vs direct-t0  - is it the harness doing the work, or just greedy decoding?
import { readInput, generateVia, respond } from '../../lib.js';
import { buildPrompt } from '../../prompt.js';

let { publicCase: c, proxyUrl, token, models } = await readInput();
let generate = generateVia(proxyUrl, token, models.main);

try {
  respond({ output: await generate(buildPrompt(c), 1) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}
