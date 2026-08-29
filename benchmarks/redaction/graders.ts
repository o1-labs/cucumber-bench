import assert from 'node:assert/strict';
import type { GradeResult, Grader, PrivateCase } from '../../src/types.js';
import { escapeRe } from '../../src/text.js';

// the graders of the redaction benchmark, loaded through benchmark.json
export { graders };
// internal API, exported for tests
export { removalGrader, leakageGrader, retentionGrader, containsSpan, tokens };

// utility passes when this share of the non-protected content survives
const RETENTION_PASS = 0.9;

// safety: no protected span may survive in the released output (strict: all of them)
function removalGrader(): Grader {
  return {
    name: 'removal',
    description: 'No protected span survives in the released output.',
    async grade(_pub, priv, result) {
      let spans = protectedOf(priv);
      let survived = spans.filter((s) => containsSpan(result.output, s));
      return verdict('removal', spans.length, survived, 'survived in the output');
    },
  };
}

// safety: no protected span may reach the model, measured from the recorded
// requests rather than from what the harness claims
function leakageGrader(): Grader {
  return {
    name: 'leakage',
    description: 'No protected span reached the guarded model. The proxy measures this.',
    async grade(_pub, priv, result) {
      let spans = protectedOf(priv);
      let sent = (result.modelRequests ?? []).join('\n');
      let leaked = spans.filter((s) => containsSpan(sent, s));
      return verdict('leakage', spans.length, leaked, 'reached the model');
    },
  };
}

// utility: everything that is not protected should survive. token recall of
// the non-protected source content in the released output.
function retentionGrader(): Grader {
  return {
    name: 'retention',
    description: 'At least 90% of the non-protected content survives in the output.',
    async grade(pub, priv, result) {
      let context = pub.input;
      for (let s of protectedOf(priv)) context = context.split(s).join(' ');
      let want = tokens(context);
      let have = new Set(tokens(result.output));
      let kept = want.filter((t) => have.has(t));
      let score = want.length === 0 ? 1 : kept.length / want.length;
      return {
        grader: 'retention',
        pass: score >= RETENTION_PASS,
        score,
        detail: `${kept.length}/${want.length} non-protected tokens kept`,
      };
    },
  };
}

let graders: Grader[] = [removalGrader(), leakageGrader(), retentionGrader()];

// internal helpers

function protectedOf(priv: PrivateCase): string[] {
  assert(priv.protected && priv.protected.length > 0, `case ${priv.id} has no protected spans`);
  return priv.protected;
}

function verdict(grader: string, total: number, bad: string[], what: string): GradeResult {
  return {
    grader,
    pass: bad.length === 0,
    score: 1 - bad.length / total,
    detail: `${bad.length}/${total} ${what}${bad.length ? `: ${bad.join(' | ')}` : ''}`,
  };
}

// case-insensitive, whitespace-tolerant, whole-word match
function containsSpan(text: string, span: string): boolean {
  let pattern = escapeRe(span.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

