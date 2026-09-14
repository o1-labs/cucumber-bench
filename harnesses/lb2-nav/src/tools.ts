// the pure part of the navigator: the two commands the model reads the text with, over the
// document's lines (1-based), and the parser of a reply. no model, no io: a test brings the text
// and a toy token counter
import assert from 'node:assert/strict';

export { parseCommand, search, read, type Command };

type Command = { kind: 'search'; words: string } | { kind: 'read'; from: number; to: number };

// characters shown around a match
const SNIPPET = 200;

// the command is the last non-empty line of a reply; a reply with no command is the answer
function parseCommand(reply: string): Command | undefined {
  let line = reply.trim().split('\n').pop()!.trim().replace(/^[`*_]+|[`*_]+$/g, '');
  let m = line.match(/^search:\s*(.+)$/i);
  // the model tends to quote the words; the quote marks are not part of the text
  if (m) return { kind: 'search', words: m[1].trim().replace(/^["'“]+|["'”]+$/g, '').trim() };
  m = line.match(/^read:\s*(\d+)\s*(?:-\s*(\d+))?$/i);
  if (m) return { kind: 'read', from: Number(m[1]), to: Number(m[2] ?? m[1]) };
  return undefined;
}

// every line containing the words (case-insensitive, whitespace collapsed), the first cap of
// them as [line n] plus a snippet around the match; the total is always reported
function search(lines: string[], words: string, cap: number): { total: number; text: string } {
  let needle = normalize(words);
  if (!needle) return { total: 0, text: 'search: give one or more words' };
  let hits: string[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = normalize(lines[i]);
    let at = line.indexOf(needle);
    if (at < 0) continue;
    total++;
    if (hits.length >= cap) continue;
    let start = Math.max(0, at - SNIPPET / 2);
    let end = Math.min(line.length, at + needle.length + SNIPPET / 2);
    hits.push(`[line ${i + 1}] ${start > 0 ? '...' : ''}${line.slice(start, end)}${end < line.length ? '...' : ''}`);
  }
  if (total === 0) return { total, text: `no line contains "${words}"` };
  let head = total > cap ? `${total} lines match; the first ${cap}:` : `${total} line(s) match:`;
  return { total, text: `${head}\n${hits.join('\n')}` };
}

// the lines from..to, each as [line n] text, at most cap tokens; a longer range is cut and says so
function read(lines: string[], from: number, to: number, count: (s: string) => number, cap: number): { lines: number; text: string } {
  assert(cap > 0, `read: cap must be positive, got ${cap}`);
  if (from < 1 || to > lines.length || from > to) {
    return { lines: 0, text: `read: the text has lines 1-${lines.length}; ${from}-${to} is not a range in it` };
  }
  let out: string[] = [];
  let tokens = 0;
  let n = from;
  for (; n <= to; n++) {
    let line = `[line ${n}] ${lines[n - 1]}`;
    tokens += count(line);
    if (tokens > cap && out.length > 0) break;
    out.push(line);
  }
  if (n <= to) out.push(`(cut at line ${n - 1}: the read limit is ${cap} tokens; read from line ${n} to continue)`);
  return { lines: out.length - (n <= to ? 1 : 0), text: out.join('\n') };
}

// internal helpers

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
