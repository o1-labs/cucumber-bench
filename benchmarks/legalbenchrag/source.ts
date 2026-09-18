// LegalBench-RAG release linked by upstream commit
// 431bc8f2488a81569ab7259fa633dcc50ab77f9a (MIT code; source dataset licences also apply).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SOURCE_COMMIT = '431bc8f2488a81569ab7259fa633dcc50ab77f9a';
export const RELEASE = {
  contractnli: { count: 977, sha256: 'bc60963c4880e3db3141e96f3a7b75e1dbe195cba8f10f0658872f43430fc77a' },
  cuad: { count: 4042, sha256: '8e0405b15fb8869c631da424372b488e274f253a81634b78803b21c72c0601f9' },
  maud: { count: 1676, sha256: '82ef159b87f73a9c68e7143fac88bf47ac212713b56617d7e87d6f1f0a781daf' },
  privacy_qa: { count: 194, sha256: '12c7afcb0e6e84cdff59914495c3bce005d10bb4665cae12b64a9b57af8fb7b6' },
};
export const CORPUS_SHA256 = 'a8eda9cb938cb825b1dfa1d771ec4f1500aa2573e732a26f9e74b2e30e55468b';
export type SourceTest = { query: string; snippets: { file_path: string; span: [number, number]; answer: string }[] };
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export async function loadSource(root: string) {
  const corpus = new Map<string, string>();
  const fingerprint = createHash('sha256');
  const paths = (await readdir(join(root, 'corpus'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const diskPath = join(entry.parentPath, entry.name);
      return { diskPath, path: diskPath.slice(join(root, 'corpus').length + 1).replaceAll('\\', '/').normalize('NFC') };
    })
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(paths.length, 714, 'LegalBench-RAG: corpus file count differs from pinned release');
  for (const { path, diskPath } of paths) {
    assert(!corpus.has(path), `LegalBench-RAG: duplicate normalized path ${path}`);
    const bytes = await readFile(diskPath);
    fingerprint.update(`${path}\0${sha256(bytes)}\n`);
    // Python text-mode reads use universal newlines. Keep all other characters intact.
    corpus.set(path, bytes.toString('utf8').replace(/\r\n?/g, '\n'));
  }
  assert.equal(fingerprint.digest('hex'), CORPUS_SHA256, 'LegalBench-RAG: corpus checksum mismatch');
  const datasets: { name: keyof typeof RELEASE; tests: SourceTest[] }[] = [];
  for (const name of Object.keys(RELEASE) as (keyof typeof RELEASE)[]) {
    const bytes = await readFile(join(root, 'benchmarks', `${name}.json`));
    assert.equal(sha256(bytes), RELEASE[name].sha256, `LegalBench-RAG: ${name} checksum mismatch`);
    const raw = JSON.parse(bytes.toString('utf8'));
    assert(Array.isArray(raw.tests) && raw.tests.length === RELEASE[name].count, `${name}: invalid test count`);
    for (const [index, test] of raw.tests.entries()) {
      assert(typeof test.query === 'string' && test.query.trim(), `${name}/${index}: missing query`);
      assert(Array.isArray(test.snippets) && test.snippets.length, `${name}/${index}: missing snippets`);
      for (const snippet of test.snippets) {
        // The release mixes composed and decomposed Unicode spellings in paths.
        snippet.file_path = snippet.file_path.normalize('NFC');
        const text = corpus.get(snippet.file_path);
        assert(text !== undefined, `${name}/${index}: unknown corpus file`);
        assert(Array.isArray(snippet.span) && snippet.span.length === 2, `${name}/${index}: invalid span`);
        const [start, end] = snippet.span;
        const chars = Array.from(text);
        assert(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= chars.length,
          `${name}/${index}: span outside document`);
        assert.equal(chars.slice(start, end).join(''), snippet.answer, `${name}/${index}: answer does not match source span`);
      }
    }
    datasets.push({ name, tests: raw.tests });
  }
  return { corpus, datasets };
}
