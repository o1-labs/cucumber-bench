// Dependency-free BM25 retrieval plus deterministic neighboring context. This mirrors
// the local CUAD retrieval experiment while remaining small enough for the isolated
// harness image. Passage indexes are zero-based internally and returned in document order.

const DEFAULT_SEED_LIMIT = 5;
const DEFAULT_RADIUS = 1;
const DEFAULT_WORD_BUDGET = 3000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TOKEN_RE = /[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*/gu;

type RetrievalDoc = { text: string };
type RetrievalConfig = { seedLimit?: number; radius?: number; wordBudget?: number };
type RetrievalSelection = {
  seedPassageIndexes: number[];
  passageIndexes: number[];
  seedWordCount: number;
  wordCount: number;
};

export { selectBm25Context };
export type { RetrievalConfig, RetrievalDoc, RetrievalSelection };

function selectBm25Context(
  query: string,
  docs: RetrievalDoc[],
  config: RetrievalConfig = {},
): RetrievalSelection {
  let seedLimit = config.seedLimit ?? DEFAULT_SEED_LIMIT;
  let radius = config.radius ?? DEFAULT_RADIUS;
  let wordBudget = config.wordBudget ?? DEFAULT_WORD_BUDGET;
  if (!query.trim()) throw Error('BM25 retrieval needs a non-empty query');
  if (docs.length === 0) throw Error('BM25 retrieval needs at least one passage');
  if (!Number.isInteger(seedLimit) || seedLimit <= 0 || !Number.isInteger(radius) || radius < 0) {
    throw Error('retrieval seed limit must be positive and radius must be non-negative integers');
  }
  if (!Number.isInteger(wordBudget) || wordBudget <= 0) throw Error('retrieval word budget must be a positive integer');

  let documentTokens = docs.map((doc) => tokenize(doc.text));
  let termCounts = documentTokens.map(countTerms);
  let averageLength = documentTokens.reduce((total, tokens) => total + tokens.length, 0) / docs.length;
  let documentFrequency = new Map<string, number>();
  for (let tokens of documentTokens) {
    for (let term of new Set(tokens)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  let queryTerms = new Set(tokenize(query));
  let ranked = docs
    .map((_, passageIndex) => ({
      passageIndex,
      score: bm25Score(
        queryTerms,
        termCounts[passageIndex],
        documentTokens[passageIndex].length,
        averageLength,
        documentFrequency,
        docs.length,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.passageIndex - right.passageIndex);

  let seedPassageIndexes = ranked.slice(0, Math.min(seedLimit, docs.length)).map((item) => item.passageIndex);
  let words = docs.map((doc) => wordCount(doc.text));
  let selected = new Set(seedPassageIndexes);
  let seedWordCount = seedPassageIndexes.reduce((total, index) => total + words[index], 0);
  let selectedWordCount = seedWordCount;
  if (seedWordCount > wordBudget) {
    throw Error(`retrieval seeds need ${seedWordCount} words, above the ${wordBudget}-word context budget`);
  }

  for (let distance = 1; distance <= radius; distance++) {
    for (let seed of seedPassageIndexes) {
      for (let passageIndex of [seed - distance, seed + distance]) {
        if (passageIndex < 0 || passageIndex >= docs.length || selected.has(passageIndex)) continue;
        if (selectedWordCount + words[passageIndex] > wordBudget) continue;
        selected.add(passageIndex);
        selectedWordCount += words[passageIndex];
      }
    }
  }

  return {
    seedPassageIndexes,
    passageIndexes: [...selected].sort((left, right) => left - right),
    seedWordCount,
    wordCount: selectedWordCount,
  };
}

function bm25Score(
  queryTerms: Set<string>,
  frequencies: Map<string, number>,
  documentLength: number,
  averageLength: number,
  documentFrequency: Map<string, number>,
  documentCount: number,
): number {
  let score = 0;
  for (let term of queryTerms) {
    let frequency = frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    let frequencyInDocuments = documentFrequency.get(term) ?? 0;
    let inverseFrequency = Math.log(1 + (documentCount - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5));
    let lengthNormalization = 1 - BM25_B + BM25_B * documentLength / averageLength;
    score += inverseFrequency * (frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * lengthNormalization));
  }
  return score;
}

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(TOKEN_RE)].map((match) => match[0]);
}

function countTerms(tokens: string[]): Map<string, number> {
  let counts = new Map<string, number>();
  for (let token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
