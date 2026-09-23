// Full-document review adapter. The review pipeline lives in core.ts so a
// retrieval-assisted adapter can reuse the same scan, compose, and citation checks.
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { generateFor, readInput, respond } from './adapter.js';
import { reviewAll } from './core.js';

let { publicCase, proxyUrl, token, models } = await readInput();
let generate = generateFor(proxyUrl, token, models.main);

try {
  respond(await reviewAll(publicCase, generate));
} catch (error: any) {
  respond({ error: String(error?.message ?? error) });
}
