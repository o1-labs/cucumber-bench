import { it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slimResults } from '../src/store.js';

it('should stream results.jsonl into the archive without the prompt copies, keeping every record', async () => {
  let dir = await mkdtemp(join(tmpdir(), 'store-'));
  try {
    // a big prompt copy per record, and a blank line the writer may leave at the end
    let big = 'x'.repeat(200_000);
    let records = Array.from({ length: 50 }, (_, i) => ({
      run: { caseId: `c-${i}`, system: 's', output: 'o', modelRequests: [big], trace: { source: big, transformedSource: big, rawOutput: 'r', releasedOutput: 'r', stages: [] } },
      grades: [{ grader: 'g', pass: true, score: 1 }], judge: {}, status: 'ok',
    }));
    await writeFile(join(dir, 'results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n\n');
    let count = await slimResults(join(dir, 'results.jsonl'), join(dir, 'slim.jsonl'));
    assert.equal(count, 50);
    let lines = (await readFile(join(dir, 'slim.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 50);
    let first = JSON.parse(lines[0]);
    assert.equal(first.run.caseId, 'c-0');
    assert.equal(first.run.modelRequests, undefined);
    assert.deepEqual(first.run.trace, { rawOutput: 'r', releasedOutput: 'r', stages: [] });
    assert.deepEqual(first.grades, records[0].grades);
    assert.ok((await readFile(join(dir, 'slim.jsonl'))).length < 50_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
