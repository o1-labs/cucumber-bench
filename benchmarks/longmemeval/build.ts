import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { PrivateCase, PublicCase } from '../../src/types.js';
import type { LongMemEvalGold } from './graders.js';

// the case builder and the split, pure functions; import.ts is the cli around them
export { buildCase, splitIds, formatHistory, formatSession, PREAMBLE, type Item, type Turn };

type Turn = { role: string; content: string; has_answer?: boolean };
// one LongMemEval instance (data/longmemeval_*.json). answer_session_ids and the turns'
// has_answer flags mark the evidence: they never reach the public case
type Item = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
};

// the official long-context prompt (src/generation/run_generation.py: no retrieval, history_format
// nl, both roles, no chain of thought). direct joins instructions and input with a blank line,
// which reproduces the template's three newlines before "History Chats:"
const PREAMBLE = 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.';

// a session as the official script renders it: every turn on its own paragraph, role first
function formatSession(turns: Turn[]): string {
  return turns.map((t) => `\n\n${t.role}: ${t.content.trim()}`).join('');
}

// the history in file order (the official script keeps it; the sessions are not always chronological)
function formatHistory(item: Item): string {
  return item.haystack_sessions
    .map((s, i) => `\n### Session ${i + 1}:\nSession Date: ${item.haystack_dates[i]}\nSession Content:\n${formatSession(s)}\n`)
    .join('');
}

function buildCase(item: Item, suite: string, source: string): { pub: PublicCase & { _source: string }; priv: PrivateCase & LongMemEvalGold } {
  assert(item.haystack_sessions.length === item.haystack_dates.length, `${item.question_id}: sessions and dates differ in length`);
  // the type in the id gives per-type numbers from results.jsonl; _abs stays in the question id
  let id = `${suite}-${item.question_type}-${item.question_id}`;
  let pub = {
    id,
    suite,
    task: 'longmemeval',
    instructions: PREAMBLE,
    input: `\nHistory Chats:\n\n${formatHistory(item)}\n\nCurrent Date: ${item.question_date}\nQuestion: ${item.question}\nAnswer:`,
    // one passage per session, for a harness that retrieves; the title carries the date
    docs: item.haystack_sessions.map((s, i) => ({ title: `Session ${i + 1} (${item.haystack_dates[i]})`, text: formatSession(s).trim() })),
    question: item.question,
    _source: source,
  };
  let priv: PrivateCase & LongMemEvalGold = {
    id,
    graders: ['longmemeval'],
    answer: String(item.answer),
    questionType: item.question_type,
    // the official scorer: '_abs' in question_id
    abstention: item.question_id.includes('_abs'),
  };
  return { pub, priv };
}

// a deterministic split, stratified by question type: the ids are ordered by sha256(seed:id),
// every type contributes its share of each split (largest remainder), the dev split is drawn
// first and the test split from what is left. count 'all' takes every remaining case
function splitIds(
  items: Pick<Item, 'question_id' | 'question_type'>[],
  opts: { seed: string; dev: number; count: number | 'all' },
): { dev: string[]; test: string[] } {
  let key = (id: string) => createHash('sha256').update(`${opts.seed}:${id}`).digest('hex');
  let ordered = [...items].sort((a, b) => key(a.question_id).localeCompare(key(b.question_id)));
  let byType = new Map<string, string[]>();
  for (let it of ordered) byType.set(it.question_type, [...(byType.get(it.question_type) ?? []), it.question_id]);
  let types = [...byType.keys()].sort();
  let totals = types.map((t) => byType.get(t)!.length);
  let dev = allocate(opts.dev, totals);
  let count = opts.count === 'all' ? items.length - opts.dev : opts.count;
  assert(count >= 0 && opts.dev + count <= items.length, `split: dev ${opts.dev} + count ${count} exceeds ${items.length} items`);
  let test = allocate(count, totals);
  let out = { dev: [] as string[], test: [] as string[] };
  types.forEach((t, i) => {
    let ids = byType.get(t)!;
    // 'all' may leave a type one short after rounding; the shortfall is taken from the largest types
    assert(dev[i] + test[i] <= ids.length, `split: type ${t} has ${ids.length} cases, needs ${dev[i] + test[i]}`);
    out.dev.push(...ids.slice(0, dev[i]));
    out.test.push(...ids.slice(dev[i], dev[i] + test[i]));
  });
  return out;
}

// n shares proportional to the totals, integers, summing to n (largest remainder)
function allocate(n: number, totals: number[]): number[] {
  let sum = totals.reduce((a, b) => a + b, 0);
  let exact = totals.map((t) => (n * t) / sum);
  let shares = exact.map(Math.floor);
  let left = n - shares.reduce((a, b) => a + b, 0);
  let order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < left; k++) shares[order[k][1]]++;
  return shares;
}
