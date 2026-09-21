import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';
import { publishSite } from './site.js';
import { slimResults } from './store.js';

// usage: npm run store -- runs/<runId> [runs/<runId> ...]
// pins a final run into runs/pinned/<runId>, the tracked archive: run.json, report.md and
// chart.html as they are, and results.jsonl without modelRequests and the trace's input
// copies. those duplicate the public cases the repo already holds, and they blow a
// 100-case run past git's file limit. the full folder stays in runs/.
// then rebuilds docs/ from every pinned run: the site shows exactly the pinned set.
let dirs = process.argv.slice(2);
assert(dirs.length > 0, 'usage: npm run store -- runs/<runId> [runs/<runId> ...]');

for (let dir of dirs) {
  let id = basename(dir.replace(/\/+$/, ''));
  // a run from before run.json exists has no manifest; pin it with a warning
  let manifest = await readFile(join(dir, 'run.json'), 'utf8').then(JSON.parse, () => undefined);
  if (manifest) {
    assert(manifest.complete, `${id}: run.json says the run is incomplete; pin only finished runs`);
    if (manifest.git?.dirty?.length) {
      console.warn(`${id}: note: the run had uncommitted changes: ${manifest.git.dirty.join(', ')}`);
    }
  } else {
    console.warn(`${id}: no run.json (a run from before it existed); completeness not checked`);
  }
  await mkdir(join('runs', 'pinned'), { recursive: true });
  let dest = join('runs', 'pinned', id);
  await mkdir(dest); // fails when the run is already pinned
  for (let f of manifest ? ['run.json', 'report.md', 'chart.html'] : ['report.md', 'chart.html']) {
    await copyFile(join(dir, f), join(dest, f));
  }
  let records = await slimResults(join(dir, 'results.jsonl'), join(dest, 'results.jsonl'));
  if (manifest?.records !== undefined) assert.equal(records, manifest.records, `${id}: results.jsonl holds ${records} records, run.json says ${manifest.records}`);
  console.log(`pinned to ${dest} (${records} records)`);
}

let pinned = (await readdir(join('runs', 'pinned'), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => join('runs', 'pinned', e.name))
  .sort();
await publishSite(pinned);
console.log('commit runs/pinned/ and docs/');
