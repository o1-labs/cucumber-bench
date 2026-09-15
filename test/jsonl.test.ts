import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl, writeJsonl } from '../src/jsonl.js';

describe('jsonl', () => {
  it('should write one record per line and read them back, blank lines aside', async () => {
    let dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
    let path = join(dir, 'results.jsonl');
    let records = [{ a: 1, text: 'x'.repeat(100_000) }, { b: [1, 2] }];
    await writeJsonl(path, records);
    assert.deepEqual(await readJsonl(path), records);
    await assert.rejects(readJsonl(join(dir, 'missing.jsonl')), { code: 'ENOENT' });
  });
});
