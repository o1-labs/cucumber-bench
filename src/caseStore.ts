import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PublicCase, PrivateCase } from './types.js';

export { loadCases, type Case };

type Case = { pub: PublicCase; priv: PrivateCase };

// loads *.public.json + *.private.json pairs from a directory (recursive)
async function loadCases(dir: string): Promise<Case[]> {
  let entries = await readdir(dir, { recursive: true });
  let publicFiles = entries.filter((f) => f.endsWith('.public.json')).sort();
  assert(publicFiles.length > 0, `loadCases: no *.public.json files under ${dir}`);

  let cases: Case[] = [];
  let documents = new Map<string, { title: string; text: string }>();
  let seen = new Set<string>();
  for (let file of publicFiles) {
    let pub: PublicCase = JSON.parse(await readFile(join(dir, file), 'utf8'));
    // Large document benchmarks share immutable public documents between questions.
    // References are content hashes, never arbitrary paths into private case files.
    if (pub.documentRefs !== undefined) {
      assert(Array.isArray(pub.documentRefs) && pub.documentRefs.length > 0 && pub.docs === undefined,
        `loadCases: ${file} must use either docs or nonempty documentRefs`);
      pub.docs = [];
      for (const hash of pub.documentRefs) {
        assert(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), `loadCases: invalid document reference in ${file}`);
        const path = join(dirname(dirname(resolve(dir, file))), 'documents', `${hash}.json`);
        let doc = documents.get(path);
        if (!doc) {
          const bytes = await readFile(path);
          assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `loadCases: document checksum mismatch: ${path}`);
          const parsed = JSON.parse(bytes.toString('utf8'));
          assert(typeof parsed.title === 'string' && typeof parsed.text === 'string', `loadCases: invalid document: ${path}`);
          doc = { title: parsed.title, text: parsed.text };
          documents.set(path, doc);
        }
        pub.docs.push(doc);
      }
    }
    let privFile = file.replace(/\.public\.json$/, '.private.json');
    let priv: PrivateCase = JSON.parse(await readFile(join(dir, privFile), 'utf8'));
    assert(pub.id === priv.id, `loadCases: id mismatch in ${file}: ${pub.id} vs ${priv.id}`);
    // the id names the file and the suite names the folder, so a copied case cannot hide
    assert(basename(file) === `${pub.id}.public.json`, `loadCases: ${file} holds the case ${pub.id}`);
    let suiteDir = basename(dirname(dirname(resolve(dir, file))));
    assert(suiteDir === pub.suite, `loadCases: ${file} is in ${suiteDir} but names the suite ${pub.suite}`);
    assert(!seen.has(pub.id), `loadCases: the id ${pub.id} appears twice`);
    seen.add(pub.id);
    assert(Array.isArray(priv.graders) && priv.graders.length > 0, `loadCases: ${privFile} must list graders`);
    cases.push({ pub, priv });
  }
  return cases;
}
