import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadProject } from './project.js';
import { buildChartHtml } from './chart.js';
import type { RunRecord } from './runner.js';

// usage: npm run chart -- runs/<runId> [runs/<runId> ...] [--combine]
// several runs merge into one page, e.g. a new harness's run next to a stored baseline run of
// the same suite. the merged page is chart-merged.html in the first run's folder, so the
// single-run chart.html stays as it is. compare only runs of the same suite and cases.
// --combine draws every suite as one section, systems side by side; the section label names
// every suite, so a reader sees when the systems ran on different case sets
let args = process.argv.slice(2);
let combine = args.includes('--combine');
let runDirs = args.filter((a) => a !== '--combine');
assert(runDirs.length > 0, 'usage: npm run chart -- runs/<runId> [runs/<runId> ...] [--combine]');

let records: RunRecord[] = [];
for (let dir of runDirs) {
  let jsonl = await readFile(join(dir, 'results.jsonl'), 'utf8');
  records.push(...jsonl.trim().split('\n').map((line): RunRecord => JSON.parse(line)));
}
let { cases, help } = await loadProject();
if (combine) {
  let used = new Set(records.map((r) => r.run.caseId));
  let suites = [...new Set(cases.filter((c) => used.has(c.pub.id)).map((c) => c.pub.suite))];
  let label = suites.join(' + ') + (suites.length > 1 ? ' (different case sets)' : '');
  cases = cases.map((c) => ({ ...c, pub: { ...c.pub, suite: label } }));
}
let ids = runDirs.map((d) => d.replace(/\/+$/, '').split('/').pop()!);

let out = join(runDirs[0], runDirs.length > 1 ? 'chart-merged.html' : 'chart.html');
await writeFile(out, buildChartHtml(ids.join(' + '), cases, records, help));
console.log(`written to ${out}`);
