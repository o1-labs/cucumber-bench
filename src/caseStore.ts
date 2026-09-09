import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { PublicCase, PrivateCase } from './types.js';

export { loadCases, type Case };

type Case = { pub: PublicCase; priv: PrivateCase };

// loads *.public.json + *.private.json pairs from a directory (recursive). suites: only the cases
// in those benchmark folders; a suite's cases can be hundreds of MB, so a run loads what it needs
async function loadCases(dir: string, suites?: string[]): Promise<Case[]> {
  let entries = await readdir(dir, { recursive: true });
  let suiteOf = (file: string) => basename(dirname(dirname(resolve(dir, file))));
  let publicFiles = entries.filter((f) => f.endsWith('.public.json') && (!suites || suites.includes(suiteOf(f)))).sort();
  assert(publicFiles.length > 0, `loadCases: no *.public.json files under ${dir}${suites ? ` for the suites ${suites.join(', ')}` : ''}`);

  let cases: Case[] = [];
  let seen = new Set<string>();
  for (let file of publicFiles) {
    let pub: PublicCase = JSON.parse(await readFile(join(dir, file), 'utf8'));
    let privFile = file.replace(/\.public\.json$/, '.private.json');
    let priv: PrivateCase = JSON.parse(await readFile(join(dir, privFile), 'utf8'));
    assert(pub.id === priv.id, `loadCases: id mismatch in ${file}: ${pub.id} vs ${priv.id}`);
    // the id names the file and the suite names the folder, so a copied case cannot hide
    assert(basename(file) === `${pub.id}.public.json`, `loadCases: ${file} holds the case ${pub.id}`);
    assert(suiteOf(file) === pub.suite, `loadCases: ${file} is in ${suiteOf(file)} but names the suite ${pub.suite}`);
    assert(!seen.has(pub.id), `loadCases: the id ${pub.id} appears twice`);
    seen.add(pub.id);
    assert(Array.isArray(priv.graders) && priv.graders.length > 0, `loadCases: ${privFile} must list graders`);
    cases.push({ pub, priv });
  }
  return cases;
}
