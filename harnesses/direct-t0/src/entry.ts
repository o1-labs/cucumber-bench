// direct, at the benchmark's own temperature: the matched control.
//
// identical to the direct lane in every respect but one - it sets no temperature, so the
// proxy injects BENCH_TEMPERATURE (0 by default) exactly as every harness gets it. that
// makes direct-t0 vs a harness a comparison where the harness is the only thing that
// changed, and direct-t0 vs direct the price of the decoding setting on its own.
import { readInput, generateVia, respond } from '../../lib.js';
import { buildPrompt } from '../../prompt.js';

let { publicCase: c, proxyUrl, token, models } = await readInput();
let generate = generateVia(proxyUrl, token, models.main);

try {
  respond({ output: await generate(buildPrompt(c)) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}
