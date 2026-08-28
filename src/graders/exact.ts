import type { Grader } from '../types.js';

export { exactGrader };
// internal API, exported for tests
export { extractChoice, normalize };

// exact-match grading against the private gold label.
// the model output may be chatty, so we first try full-string match, then look
// for exactly one allowed choice in the output; ambiguous output fails.
function exactGrader(): Grader {
  return {
    name: 'exact',
    grade(pub, priv, result) {
      let base = { caseId: result.caseId, system: result.system, repetition: result.repetition };
      if (result.error) {
        return { ...base, pass: false, score: 0, detail: `error: ${result.error}` };
      }
      // aliases count as extractable labels too, so alias-worded output still grades
      let extracted = extractChoice(result.output, [...pub.choices, ...(priv.aliases ?? [])]);
      let accepted = [priv.answer, ...(priv.aliases ?? [])].map(normalize);
      let pass = extracted !== undefined && accepted.includes(extracted);
      return {
        ...base,
        pass,
        score: pass ? 1 : 0,
        extracted,
        detail: `extracted=${extracted ?? 'none'} gold=${normalize(priv.answer)}`,
      };
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

// internal helpers

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
