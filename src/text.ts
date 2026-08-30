export { escapeRe, longestRun };

// escapes a string for use inside a RegExp
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// the longest run of consecutive words of `claim` that appears in `text`, word for word;
// letters and digits only, so punctuation and quote marks do not break a match
function longestRun(claim: string, text: string): number {
  let hay = normalizeWords(text);
  let words = normalizeWords(claim).split(' ');
  let best = 0;
  for (let i = 0; i < words.length; i++) {
    let j = i + best;
    while (j < words.length && hay.includes(words.slice(i, j + 1).join(' '))) j++;
    best = Math.max(best, j - i);
  }
  return best;
}

function normalizeWords(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
