// Frozen development BM25 adapter for the shared review pipeline.
// protocol: stdin {publicCase, proxyUrl, token, models} -> stdout {output, trace} | {error}
import { BM25_V1_POLICY, runBm25Review } from './bm25-review.js';

await runBm25Review(BM25_V1_POLICY);
