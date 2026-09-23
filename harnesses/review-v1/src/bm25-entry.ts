// Development-only BM25 retrieval adapter for the shared review pipeline. It uses the
// same model client and compiled image as full-document review so passage selection is
// the only treatment difference.
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { generateFor, readInput, respond } from './adapter.js';
import { questionOf, reviewSelected } from './core.js';
import { selectBm25Context } from './retrieval.js';

let { publicCase, proxyUrl, token, models } = await readInput();
let generate = generateFor(proxyUrl, token, models.main);

try {
  let docs = publicCase.docs ?? [];
  // Review keeps the case's `Question:` label in its prompt. Retrieval indexes the
  // query text itself, matching the standalone Python experiment.
  let query = questionOf(publicCase).replace(/^Question:\s*/, '');
  let selection = selectBm25Context(query, docs);
  let seedIds = selection.seedPassageIndexes.map((index) => index + 1).join(',');
  respond(
    await reviewSelected(
      publicCase,
      generate,
      {
        passageIndexes: selection.passageIndexes,
        finding:
          `BM25 seeds [${seedIds}]; selected ${selection.passageIndexes.length}/${docs.length} passages ` +
          `in document order, ${selection.wordCount}/3000 words`,
      },
    ),
  );
} catch (error: any) {
  respond({ error: String(error?.message ?? error) });
}
