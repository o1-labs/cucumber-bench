// vote-v1: sample the same question several times and abstain when the samples disagree.
//
// the premise, measured on stored baseline runs before this harness existed: when the model
// knows an answer it repeats itself across samples, and when it fabricates it contradicts
// itself. on the 60-case dev suite, answerable cases whose samples agreed were answered
// correctly 69% of the time against 36% when they disagreed - a signal worth exploiting.
//
// the first attempt at exploiting it, offline, compared whole free-text responses and failed
// badly: prose varies in wording, length and caveats for reasons unrelated to the answer, so
// every threshold cost more in answering than it bought in abstention. hence the prompt here
// asks for ONE SHORT LINE. that makes agreement an exact comparison over normalized text
// rather than a similarity score, and needs no extra model call to judge it.
import { readInput, generateVia, respond } from '../../lib.js';
import type { Trace } from '../../../src/types.js';

// samples per case, and how many must agree. 2 of 3 rather than unanimity: the offline
// simulation showed that aggressive abstention destroys the answered rate faster than it
// raises abstention, so the harness starts forgiving and is tuned from there - on the dev
// suite only.
const SAMPLES = 3;
const NEEDED = 2;

// the model writes this instead of an answer when it judges the question unanswerable.
// it is the harness's own protocol for reading abstention off a one-line reply, not
// knowledge about any particular case.
const DECLINE = 'CANNOT ANSWER';

// what the harness releases when the samples do not agree, or agree on declining. it must
// read as a decline to a human and to the benchmark's judge.
const ABSTENTION = 'I cannot give a definite answer to this question.';

let { publicCase: c, proxyUrl, token, models } = await readInput();
// temperature 1, deliberately: the signal IS the variation between samples, so a greedy
// harness would draw three identical answers and learn nothing from comparing them.
let generate = generateVia(proxyUrl, token, models.main);
let prompt = [
  c.instructions,
  c.input,
  `Reply with a single short line: the answer alone, no explanation. ` +
    `If the question has no definite answer, or you lack the information to answer it, ` +
    `reply with exactly ${DECLINE}.`,
  // a label line of its own: the runner's model mock routes on the last line, so a harness
  // that reuses another's label ('Answer:', 'Quotes:') silently gets that harness's reply
  'Short answer:',
].join('\n\n');

try {
  let samples: string[] = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await generate(prompt, 1));
  let { output, decision, findings } = vote(samples);
  respond({ output, trace: trace(samples, output, decision, findings) });
} catch (err: any) {
  respond({ error: String(err?.message ?? err) });
}

// internal

// the released answer is the one a quorum of samples agree on, comparing them normalized.
// a quorum for DECLINE abstains, and so does no quorum at all: disagreement is the signal.
function vote(samples: string[]) {
  let keys = samples.map(firstLine);
  let counts = new Map<string, { n: number; raw: string }>();
  for (let [i, k] of keys.entries()) {
    let seen = counts.get(k) ?? { n: 0, raw: samples[i].trim() };
    counts.set(k, { n: seen.n + 1, raw: seen.raw });
  }
  let findings = [...counts].map(([k, v]) => `${v.n}x ${k || '(empty)'}`);
  let [top] = [...counts].sort((a, b) => b[1].n - a[1].n);
  if (!top || top[1].n < NEEDED) return { output: ABSTENTION, decision: 'no quorum', findings };
  if (top[0] === normalize(DECLINE)) return { output: ABSTENTION, decision: 'quorum declined', findings };
  return { output: top[1].raw, decision: `quorum of ${top[1].n}`, findings };
}

// a sample is one line by instruction, but a model may still add a preamble or a second
// sentence; the first non-empty line is what gets compared
function firstLine(s: string): string {
  let line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return normalize(line);
}

// lowercase, drop punctuation and articles, collapse whitespace: the same shape of
// normalization the str-em grader uses, so "Paris." and "paris" count as one answer
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '')
    .replace(/\b(a|an|the)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function trace(samples: string[], output: string, decision: string, findings: string[]): Trace {
  return {
    source: prompt,
    transformedSource: prompt,
    rawOutput: samples.join('\n---\n'),
    releasedOutput: output,
    stages: [
      {
        name: 'sample',
        module: 'vote-v1',
        version: '1',
        policy: `${SAMPLES} samples at temperature 1`,
        mode: 'llm',
        findings: samples.map((s, i) => `${i + 1}: ${firstLine(s)}`),
        decision: 'pass',
      },
      {
        name: 'vote',
        module: 'vote-v1',
        version: '1',
        policy: `${NEEDED} of ${SAMPLES} must agree`,
        mode: 'regex',
        findings,
        decision: output === ABSTENTION ? 'blocked' : 'pass',
      },
    ],
  };
}
