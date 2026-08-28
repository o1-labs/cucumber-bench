import assert from 'node:assert/strict';
import type { GradeContext, Grader, PublicCase, RunResult } from '../../src/types.js';

// citation quality after ALCE (Gao et al. 2023, eval.py compute_autoais). ALCE asks a
// T5 NLI model whether the cited passages entail each sentence; we ask the judge model
// the same yes/no question. loaded through benchmark.json
export { graders };
// internal API, exported for tests
export { citationRecallGrader, citationPrecisionGrader, sentences, citationsOf, removeCitations };

// citation recall: every sentence is supported by the passages it cites.
// a sentence without citations counts as unsupported.
function citationRecallGrader(): Grader {
  return {
    name: 'citation-recall',
    description: 'Every sentence is supported by the passages it cites. The score is the share of supported sentences.',
    async grade(pub, _priv, result, ctx) {
      let docs = docsOf(pub);
      if (result.error) return { grader: 'citation-recall', pass: false, score: 0, detail: `error: ${result.error}` };
      let sents = sentences(result.output);
      if (sents.length === 0) return { grader: 'citation-recall', pass: false, score: 0, detail: 'no sentences' };
      // all sentences are judged at once; the judge model handles the parallel calls
      let verdicts = await Promise.all(
        sents.map(async (sent) => {
          let refs = citationsOf(sent, docs.length);
          if (refs.length === 0) return 'uncited';
          return (await entails(ctx, result, passages(docs, refs), removeCitations(sent))) ? 'supported' : 'unsupported';
        }),
      );
      let supported = verdicts.filter((v) => v === 'supported').length;
      let uncited = verdicts.filter((v) => v === 'uncited').length;
      let score = supported / sents.length;
      return {
        grader: 'citation-recall',
        pass: score === 1,
        score,
        detail: `${supported}/${sents.length} sentences supported, ${uncited} without citation`,
      };
    },
  };
}

// citation precision: every citation is necessary. a citation is not necessary when
// its passage alone does not support the sentence and the other cited passages do.
function citationPrecisionGrader(): Grader {
  return {
    name: 'citation-precision',
    description: 'Every citation is necessary: its passage supports the sentence and is not redundant. The score is the share of such citations.',
    async grade(pub, _priv, result, ctx) {
      let docs = docsOf(pub);
      if (result.error) return { grader: 'citation-precision', pass: false, score: 0, detail: `error: ${result.error}` };
      let total = 0, precise = 0;
      // sentences, and the citations within a sentence, are judged in parallel
      await Promise.all(
        sentences(result.output).map(async (sent) => {
          let refs = citationsOf(sent, docs.length);
          if (refs.length === 0) return;
          total += refs.length;
          let claim = removeCitations(sent);
          if (!(await entails(ctx, result, passages(docs, refs), claim))) return;
          if (refs.length === 1) {
            precise++;
            return;
          }
          await Promise.all(
            refs.map(async (ref) => {
              if (await entails(ctx, result, passages(docs, [ref]), claim)) precise++;
              else if (!(await entails(ctx, result, passages(docs, refs.filter((r) => r !== ref)), claim))) precise++;
              // else: the others support the claim without this one, so it is over-citation
            }),
          );
        }),
      );
      return {
        grader: 'citation-precision',
        pass: total > 0 && precise === total,
        score: total === 0 ? 0 : precise / total,
        detail: `${precise}/${total} citations necessary`,
      };
    },
  };
}

let graders: Grader[] = [citationRecallGrader(), citationPrecisionGrader()];

// internal helpers

function docsOf(pub: PublicCase) {
  assert(pub.docs && pub.docs.length > 0, `citation graders: case ${pub.id} needs docs`);
  return pub.docs;
}

// the same (passages, claim) question is asked once per run, whichever grader asks first
let memo = new WeakMap<RunResult, Map<string, Promise<boolean>>>();

function entails(ctx: GradeContext, result: RunResult, premise: string, claim: string): Promise<boolean> {
  let cache = memo.get(result) ?? new Map();
  memo.set(result, cache);
  let key = `${premise}\n#####\n${claim}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      ctx
        .judge(
          `Premise:\n${premise}\n\nHypothesis: ${claim}\n\n` +
            `Does the premise support the hypothesis? Every fact in the hypothesis must follow from the premise. ` +
            `Answer with exactly one word: yes or no.`,
        )
        .then((answer) => /^\s*yes\b/i.test(answer)),
    );
  }
  return cache.get(key)!;
}

function passages(docs: { title: string; text: string }[], refs: number[]): string {
  return refs.map((i) => `Title: ${docs[i].title}\n${docs[i].text}`).join('\n');
}

// a simple sentence splitter: a terminal mark followed by whitespace and an uppercase letter or bracket
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// [n] citations of a sentence as 0-based passage indexes, in order, unique; out-of-range ones dropped
function citationsOf(sent: string, nDocs: number): number[] {
  let refs = [...sent.matchAll(/\[(\d+)/g)].map((m) => Number(m[1]) - 1);
  return [...new Set(refs)].filter((i) => i >= 0 && i < nDocs);
}

function removeCitations(sent: string): string {
  return sent.replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
}
