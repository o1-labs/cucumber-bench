// Development-only expanded BM25 adapter.
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { BM25_EXPANDED_V1_POLICY, runBm25Review } from './bm25-review.js';

await runBm25Review(BM25_EXPANDED_V1_POLICY);
