// the model's own tokenizer, run locally: it decides before the call whether a request fits, and
// cuts a document at token boundaries. the files are pinned to a commit of the model repository
// and checked by sha256 (fetch-tokenizer.ts downloads them; they stay out of git)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Tokenizer } from '@huggingface/tokenizers';

export { TOKENIZER_VERSION, TOKENIZER_DIR, FILES, loadTokenizer, encodeChunked, truncateMiddle, type Tok };

const MODEL = 'Qwen/Qwen3.6-35B-A3B';
const COMMIT = '995ad96eacd98c81ed38be0c5b274b04031597b0';
const TOKENIZER_VERSION = `${MODEL}@${COMMIT}`;
const TOKENIZER_DIR = new URL('../tokenizer/', import.meta.url);
const FILES: { [name: string]: { url: string; sha256: string } } = {
  'tokenizer.json': {
    url: `https://huggingface.co/${MODEL}/resolve/${COMMIT}/tokenizer.json`,
    sha256: '5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42',
  },
  'tokenizer_config.json': {
    url: `https://huggingface.co/${MODEL}/resolve/${COMMIT}/tokenizer_config.json`,
    sha256: '5186f0defcd7f232382c7f0aebcd2252d073bb921ab240e407b7ae8745d2b29b',
  },
};
// a document is tokenized in pieces of this many characters, cut at a newline: it bounds the
// memory on a 16 MB document. a piece boundary costs at most one token against a whole-text count
const CHUNK_CHARS = 1_000_000;

// what the harness needs of a tokenizer; a test brings a toy one
type Tok = { encode(text: string): number[]; decode(ids: number[]): string };

function loadTokenizer(): Tok {
  let t = new Tokenizer(readChecked('tokenizer.json'), readChecked('tokenizer_config.json'));
  return {
    encode: (text) => t.encode(text, { add_special_tokens: false }).ids,
    decode: (ids) => t.decode(ids),
  };
}

function encodeChunked(tok: Tok, text: string): number[] {
  let ids: number[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      let nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1;
    }
    for (let id of tok.encode(text.slice(start, end))) ids.push(id);
    start = end;
  }
  return ids;
}

// the reference truncation (THUDM/LongBench pred.py): the first half of the token budget from the
// head, the second half from the tail, the middle removed. returns the text and its token counts
function truncateMiddle(tok: Tok, text: string, keep: number): { text: string; original: number; retained: number } {
  assert(keep > 0, `truncateMiddle: keep must be positive, got ${keep}`);
  let ids = encodeChunked(tok, text);
  if (ids.length <= keep) return { text, original: ids.length, retained: ids.length };
  let head = Math.floor(keep / 2);
  let cut = tok.decode(ids.slice(0, head)) + tok.decode(ids.slice(ids.length - (keep - head)));
  return { text: cut, original: ids.length, retained: encodeChunked(tok, cut).length };
}

// internal helpers

function readChecked(name: string): any {
  let raw: Buffer;
  try {
    raw = readFileSync(new URL(name, TOKENIZER_DIR));
  } catch (err: any) {
    assert(err.code !== 'ENOENT', `tokenizer file ${name} is missing: run npx tsx harnesses/lb2-direct/fetch-tokenizer.ts`);
    throw err;
  }
  let sha = createHash('sha256').update(raw).digest('hex');
  assert(sha === FILES[name].sha256, `tokenizer file ${name}: sha256 ${sha}, expected ${FILES[name].sha256} (${TOKENIZER_VERSION})`);
  return JSON.parse(raw.toString('utf8'));
}
