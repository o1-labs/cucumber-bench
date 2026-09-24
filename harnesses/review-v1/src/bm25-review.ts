// Named BM25 policies adapt the retrieval module to the shared review pipeline. A policy
// changes candidate selection only; model access, scanning, composition, and citation
// checking remain behind the same review interface.
import { generateFor, readInput, respond } from './adapter.js';
import { questionOf, reviewSelected, type ReviewCase, type ReviewSelection } from './core.js';
import { selectBm25Context } from './retrieval.js';

type Bm25ReviewPolicy = Readonly<{
  name: string;
  seedLimit: number;
  radius: number;
  wordBudget: number;
}>;

const BM25_V1_POLICY: Bm25ReviewPolicy = Object.freeze({
  name: 'bm25-v1',
  seedLimit: 5,
  radius: 1,
  wordBudget: 3000,
});

const BM25_EXPANDED_V1_POLICY: Bm25ReviewPolicy = Object.freeze({
  name: 'bm25-expanded-v1',
  seedLimit: 10,
  radius: 1,
  wordBudget: 6000,
});

export { BM25_V1_POLICY, BM25_EXPANDED_V1_POLICY, reviewSelection, runBm25Review };
export type { Bm25ReviewPolicy };

function reviewSelection(c: ReviewCase, policy: Bm25ReviewPolicy): ReviewSelection {
  let docs = c.docs ?? [];
  // Review keeps the case's `Question:` label in its prompt. Retrieval indexes the
  // query text itself, matching the standalone Python experiment.
  let query = questionOf(c).replace(/^Question:\s*/, '');
  let selection = selectBm25Context(query, docs, policy);
  let passageIds = (indexes: number[]) => indexes.map((index) => index + 1);
  let seedPassageIds = passageIds(selection.seedPassageIndexes);
  let selectedPassageIds = passageIds(selection.passageIndexes);
  return {
    passageIndexes: selection.passageIndexes,
    finding:
      `BM25 seeds [${seedPassageIds.join(',')}]; selected ${selection.passageIndexes.length}/${docs.length} passages ` +
      `in document order, ${selection.wordCount}/${policy.wordBudget} words`,
    metadata: {
      retrieval: {
        policy: policy.name,
        seedLimit: policy.seedLimit,
        radius: policy.radius,
        wordBudget: policy.wordBudget,
        seedPassageIds,
        selectedPassageIds,
        seedWordCount: selection.seedWordCount,
        selectedWordCount: selection.wordCount,
        totalPassages: docs.length,
      },
    },
  };
}

async function runBm25Review(policy: Bm25ReviewPolicy) {
  let { publicCase, proxyUrl, token, models } = await readInput();
  let generate = generateFor(proxyUrl, token, models.main);
  try {
    respond(await reviewSelected(publicCase, generate, reviewSelection(publicCase, policy)));
  } catch (error: any) {
    respond({ error: String(error?.message ?? error) });
  }
}
