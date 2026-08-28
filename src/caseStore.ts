import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { PublicCase, PrivateCase } from './types.js';

export { loadCases, type Case };

type Case = { pub: PublicCase; priv: PrivateCase };

// loads *.public.json + *.private.json pairs from a directory (recursive)
async function loadCases(dir: string): Promise<Case[]> {
  let entries = await readdir(dir, { recursive: true });
  let publicFiles = entries.filter((f) => f.endsWith('.public.json')).sort();
  assert(publicFiles.length > 0, `loadCases: no *.public.json files under ${dir}`);

  let cases: Case[] = [];
  for (let file of publicFiles) {
    let pub: PublicCase = JSON.parse(await readFile(join(dir, file), 'utf8'));
    let privFile = file.replace(/\.public\.json$/, '.private.json');
    let priv: PrivateCase = JSON.parse(await readFile(join(dir, privFile), 'utf8'));
    assert(pub.id === priv.id, `loadCases: id mismatch in ${file}: ${pub.id} vs ${priv.id}`);
    assert(Array.isArray(priv.graders) && priv.graders.length > 0, `loadCases: ${privFile} must list graders`);
    cases.push({ pub, priv });
  }
  return cases;
}
