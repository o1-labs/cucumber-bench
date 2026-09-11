import assert from 'node:assert/strict';
import type { Grader } from '../types.js';
import { escapeRe } from '../text.js';
import { fieldsOf } from '../gold.js';

export { exactGrader, type ExactGold };
// internal API, exported for tests
export { extractChoice, normalize };

// the gold of a label case: the label
type ExactGold = { answer: string };

// exact-match grading of a label task against the private gold label.
// the model output may be chatty, so we first try full-string match, then look
// for exactly one allowed choice in the output; ambiguous output fails.
function exactGrader(): Grader<ExactGold> {
  return {
    name: 'exact',
    description: 'The label in the output equals the gold label.',
    gold(raw, id) {
      let { answer } = fieldsOf(raw, id, 'exact');
      assert(typeof answer === 'string', `exact: case ${id} needs a gold answer`);
      return { answer };
    },
    async grade(pub, gold, result) {
      assert(pub.choices, `exact: case ${pub.id} needs choices`);
      let extracted = extractChoice(result.output, pub.choices) ?? '(none)';
      let label = normalize(gold.answer);
      let pass = extracted === label;
      return { grader: 'exact', pass, score: pass ? 1 : 0, extracted, detail: `extracted=${extracted} gold=${label}` };
    },
  };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[.!?"'`*]+$/, '').replace(/^["'`*]+/, '');
}

function extractChoice(output: string, choices: string[]): string | undefined {
  let text = normalize(output);
  let labels = choices.map(normalize);
  if (labels.includes(text)) return text;
  // chatty answers often lead with the label, then discuss the other labels
  let firstLine = normalize(output.split('\n')[0] ?? '');
  if (labels.includes(firstLine)) return firstLine;
  // fall back: accept the output only if exactly one choice appears in it
  let found = labels.filter((l) => new RegExp(`\\b${escapeRe(l)}\\b`, 'i').test(output));
  return found.length === 1 ? found[0] : undefined;
}
