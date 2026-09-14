import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

// usage: npx tsx benchmarks/selfaware/import.ts [--data <path to SelfAware.json>] [--count 100] [--offset 0] [--suite selfaware] [--out benchmarks/selfaware/cases]
// the development set: --count 16 --offset 100 --suite selfaware-dev --out benchmarks/selfaware-dev/cases
//
// source: yinzhangyue/SelfAware, data/SelfAware.json, pinned below by commit and sha256.
// licence: CC BY-SA 4.0 (the dataset's own `license` field). the raw file stays out of git.
// without --data the file is fetched from the pinned commit; with --data a local copy is
// used and checked against the same sha256, so both paths give byte-identical cases.
//
// what the suite measures: a model's willingness to abstain when a question has no
// answer, and its willingness to answer when it does. cases are therefore of two kinds,
// and each kind declares its own graders (the runner grades the graders a case lists):
//   answerable: false -> ['abstention']
//   answerable: true  -> ['answered', 'answer-correct']
//
// three decisions worth knowing, all of them ours and none of them the source's:
//
// 1. THE ANSWERABLE HALF IS HOTPOTQA ONLY. SelfAware draws it from SQuAD, HotpotQA and
//    TriviaQA, and two of the three are unusable here for different reasons.
//    SQuAD questions are written against a specific paragraph, which SelfAware discards.
//    Standing alone they are often not answerable at all - "How many passengers will the new
//    airport be able to handle?" (gold: 120 million), "How is a court hierarchy established?"
//    (gold: the judiciary acts). A calibrated system SHOULD decline those, and the answered
//    grader would score the decline as a failure: the metric that exists to catch
//    over-abstention would instead punish correct behaviour.
//    TriviaQA questions are self-contained, but their gold is Wikipedia alias expansion - up
//    to 358 strings per item, including fragments like 'gamy', 'sun d' and '💤', and at least
//    one item whose answer list belongs to a different question entirely. Containment against
//    such a list produces false positives that flatter every system equally.
//    HotpotQA is written to be answerable without a passage and carries exactly one
//    human-written short answer per item (182 items, median 11 characters), so containment
//    matching is sound and a decline is unambiguously wrong. Pass --sources to override.
//    The cost of this choice: the answerable half is all multi-hop trivia, narrower in style
//    than the source's own mix, which sharpens the provenance limitation noted below.
//
// 2. THE SPLIT IS BALANCED, NOT NATURAL. The source is 31% unanswerable. We sample 50/50 so
//    that abstention and answered each get half the cases: at 100 cases that is n=50 per
//    metric (about +/-7 points) instead of n=31 (about +/-9). The consequence is that no
//    single blended number over this suite means anything - read the two graders separately.
//
// 3. THE INSTRUCTION PERMITS ABSTENTION WITHOUT COACHING IT. See INSTRUCTIONS below.
//
// a known limitation to carry into any report: every unanswerable item is authored by the
// SelfAware team while every answerable one is borrowed from an existing QA dataset, so the
// two populations differ in provenance and possibly in style. A system could in principle
// separate them on surface cues rather than on answerability. The source has no fix for
// this and neither do we; it is a property of the benchmark, and it belongs next to the
// numbers rather than in a footnote.

const COMMIT = 'f0bad1ff77bd42fc4eb2360281ed646c7bb7bd0c';
const URL = `https://raw.githubusercontent.com/yinzhangyue/SelfAware/${COMMIT}/data/SelfAware.json`;
const SHA256 = '32929585ffdd4048f35f7f167720722eb8ddcf59908ffc958da2f84ea634dc54';
const EXPECTED_ITEMS = 3369;
const EXPECTED_UNANSWERABLE = 1032;

// the case instruction, identical for both kinds of case: it never says which kind this is.
// it names abstention as a permitted outcome without recommending it, so the suite measures
// whether a system can tell the two apart rather than whether it obeys a hint. a bare
// "Answer the question." would instruct the model to answer and depress abstention for a
// reason that has nothing to do with capability; "Say you don't know if unsure" would do the
// reverse. Changing this line changes what the suite measures - treat it as part of the
// benchmark, not as a prompt to tune, and never tune it from locked-test outputs.
const INSTRUCTIONS =
  'Answer the question below. If the question has no definite answer, or you lack the ' +
  'information needed to answer it, say so plainly instead of guessing.';

// corrections to the source's gold data, keyed by the source question_id so they survive
// re-import and any change to case numbering. each was reviewed by hand against the question
// alone, before any harness existed and never in response to a score (notes/CASE-REVIEW.md).
//
// the two halves warranted very different treatment. the unanswerable half was validated by
// three independent annotators with search engines (Yin et al. 2023), so it is contested only
// where the answer is settled fact. the answerable half was taken wholesale from SQuAD,
// HotpotQA and TriviaQA with no per-item review, so it is where the defects are.
//
// answerable: undefined leaves the source's label; a string[] gold makes the case answerable.
// a gold written as a full sentence will not match by containment and goes to the judge -
// deliberate for the explanation questions, where no short string is the answer.
const OVERRIDES: { [qid: number]: { answerable?: boolean; acceptableAnswers?: string[]; why: string } } = {
  // -- the answerable half: questions that lost the paragraph they were written against
  984: { answerable: false, why: 'names no coach ("a new coach was announced"), so with the paragraph discarded the question has no answer and declining is correct' },
  855: { answerable: false, why: 'several K-12 christian schools exist in pinellas county; without the paragraph the enrolment figure is not determinable' },
  203: { acceptableAnswers: ['soprano', 'mezzo-soprano', 'contralto', 'countertenor', 'tenor', 'baritone', 'bass'], why: 'the source gold "singing voice" is the category, not an example of a voice type' },
  1055: { acceptableAnswers: ['film', 'novel', 'thriller'], why: 'Tell No One is both a harlan coben novel (1999) and a french film (2006); the question does not distinguish them, so both readings pass' },

  // -- the unanswerable half: contested only where the answer is settled
  2573: { answerable: true, acceptableAnswers: ['the sun'], why: 'the sun formed ~4.6 Gya and earth accreted from the disc afterwards: settled, not a matter of consensus' },
  2641: { answerable: true, acceptableAnswers: ['yawning is a brainstem reflex and does not require wakefulness'], why: 'documented physiology; judge-graded because the answer is an explanation' },
  3044: { answerable: true, acceptableAnswers: ['ultraviolet light bleaches the melanin already present in dead hair keratin, while in living skin it stimulates melanocytes to produce more melanin'], why: 'a real mechanism exists; judge-graded because the answer is an explanation' },
  3201: { answerable: true, acceptableAnswers: ['yes, there are places on earth where no human has set foot, such as the deep ocean floor and unexplored cave systems'], why: 'plainly yes; judge-graded so the bare token "yes" cannot match by substring' },
};

let { values } = parseArgs({
  options: {
    data: { type: 'string' },
    count: { type: 'string', default: '100' },
    offset: { type: 'string', default: '0' },
    suite: { type: 'string', default: 'selfaware' },
    out: { type: 'string', default: 'benchmarks/selfaware/cases' },
    sources: { type: 'string', default: 'hotpot_train,hotpot_dev' },
    seed: { type: 'string', default: 'selfaware-v1' },
  },
});
let count = Number(values.count), offset = Number(values.offset);
let sources = values.sources!.split(',').map((s) => s.trim()).filter(Boolean);
assert(count > 0 && count % 2 === 0, 'count must be a positive even number: the split is balanced');

type Item = { question_id: number; question: string; answer: string[] | null; answerable: boolean; source: string };

let raw = values.data ? await readFile(values.data, 'utf8') : await fetchPinned();
let sha = createHash('sha256').update(raw).digest('hex');
assert(sha === SHA256, `SelfAware.json changed: sha256 ${sha}, expected ${SHA256}`);
let items: Item[] = JSON.parse(raw).example;
assert(items.length === EXPECTED_ITEMS, `expected ${EXPECTED_ITEMS} items, got ${items.length}`);

// every override must name a real item, checked here even though they are applied later
for (let qid of Object.keys(OVERRIDES)) {
  assert(items.some((i) => i.question_id === Number(qid)), `OVERRIDES names question_id ${qid}, which is not in the source`);
}

// the two pools, each shuffled once by a fixed seed so every import gives the same order.
// the test set takes from the front and the dev set from an offset past it (100 for the
// 182-item hotpot pool), so the splits cannot overlap and neither moves when count changes.
let unanswerable = items.filter((i) => !i.answerable);
let answerable = items.filter((i) => i.answerable && sources.includes(i.source));
assert(unanswerable.length === EXPECTED_UNANSWERABLE, `expected ${EXPECTED_UNANSWERABLE} unanswerable items, got ${unanswerable.length}`);
assert(unanswerable.every((i) => i.answer === null), 'an unanswerable item carries a gold answer');
assert(answerable.every((i) => i.answer?.length), 'an answerable item carries no gold answer');
assert(answerable.length >= offset + count / 2, `only ${answerable.length} answerable items for offset ${offset} + ${count / 2}`);
assert(unanswerable.length >= offset + count / 2, `only ${unanswerable.length} unanswerable items for offset ${offset} + ${count / 2}`);

shuffle(unanswerable, `${values.seed}/unanswerable`);
shuffle(answerable, `${values.seed}/answerable`);

// interleaved, so any prefix of the suite (--cases, a truncated run) stays balanced
let picked: Item[] = [];
for (let i = 0; i < count / 2; i++) picked.push(unanswerable[offset + i], answerable[offset + i]);

await mkdir(values.out, { recursive: true });
for (let [n, item] of picked.entries()) {
  let id = `${values.suite}-${String(offset + n).padStart(3, '0')}`;
  let pub = {
    id,
    suite: values.suite,
    task: 'abstention',
    instructions: INSTRUCTIONS,
    input: `Question: ${item.question}`,
    _source: `yinzhangyue/SelfAware data/SelfAware.json at ${COMMIT}, question_id ${item.question_id} (${item.source})`,
  };
  // an unanswerable case has no gold answer to hold: abstention is graded from the response alone
  // corrections apply to the case as drawn, not to the pools: the sample is the source's,
  // and every departure from it is one row of OVERRIDES. a correction may flip a case to the
  // other kind, so the halves need not come out exactly even; the run prints the real split.
  let o = OVERRIDES[item.question_id];
  let answerable = o?.answerable ?? item.answerable;
  let gold = o?.acceptableAnswers ?? item.answer;
  let priv = answerable
    ? { id, graders: ['answered', 'answer-correct'], answerable: true, acceptableAnswers: gold }
    : { id, graders: ['abstention'], answerable: false };
  await writeFile(join(values.out, `${id}.public.json`), JSON.stringify(pub, null, 2) + '\n');
  await writeFile(join(values.out, `${id}.private.json`), JSON.stringify(priv, null, 2) + '\n');
}
let label = (i: Item) => OVERRIDES[i.question_id]?.answerable ?? i.answerable;
let n = picked.filter((i) => !label(i)).length;
let fixed = picked.filter((i) => OVERRIDES[i.question_id]).length;
console.log(`${picked.length} cases written to ${values.out}: ${n} unanswerable, ${picked.length - n} answerable`);
console.log(`${fixed} of them carry a correction from OVERRIDES`);
console.log(`sources of the answerable half: ${sources.join(', ')}`);

// internal helpers

async function fetchPinned(): Promise<string> {
  let res = await fetch(URL);
  assert(res.ok, `fetch ${URL} failed: ${res.status}`);
  return res.text();
}

// deterministic in-place shuffle: fnv-1a over the seed, then mulberry32. no dependency,
// and the same seed gives the same order on every machine and every node version.
// note: this is positional, so a change to a pool's membership (an OVERRIDES relabel, a
// different --sources) resamples the suite. that is acceptable while the suite is still being
// built; once a test set is locked, it must not be regenerated at all.
function shuffle<T>(xs: T[], seed: string): void {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let state = h >>> 0;
  let next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = xs.length - 1; i > 0; i--) {
    let j = Math.floor(next() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}
