import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// usage: npm run site -- runs/<runId> [runs/<runId> ...]
// copies the chart of every run named into docs/runs/<runId>/ and writes docs/index.html, the
// page GitHub Pages serves. charts hold numbers and descriptions only; report.md and
// results.jsonl name gold data and stay out of the site.
let runDirs = process.argv.slice(2);
assert(runDirs.length > 0, 'usage: npm run site -- runs/<runId> [runs/<runId> ...]');

type Entry = { id: string; title: string; note: string };
let entries: Entry[] = [];
for (let dir of runDirs) {
  let id = dir.replace(/\/+$/, '').split('/').pop()!;
  let records = (await readFile(join(dir, 'results.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  let suites = [...new Set(records.map((r) => r.run.caseId.replace(/-\d+$/, '')))];
  let systems = [...new Set(records.map((r) => r.run.system))];
  let reps = Math.max(...records.map((r) => r.run.repetition));
  let cases = new Set(records.map((r) => r.run.caseId)).size;
  await mkdir(join('docs', 'runs', id), { recursive: true });
  await copyFile(join(dir, 'chart.html'), join('docs', 'runs', id, 'chart.html'));
  entries.push({
    id,
    title: `${suites.join(', ')}: ${systems.join(' vs ')}`,
    note: `${cases} cases × ${reps} repetition${reps > 1 ? 's' : ''}, ${records.length} runs`,
  });
}

let items = entries
  .map((e) => `<li><a href="runs/${e.id}/chart.html">${esc(e.title)}</a><br><small>${esc(e.note)} · run ${esc(e.id)}</small></li>`)
  .join('\n');
let html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cucumber-bench</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; color: #1b1f24; }
  h1 { font-size: 1.6rem; } li { margin: 0.8rem 0; } small { color: #57606a; } a { color: #2a78d6; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #e6e8eb; } small { color: #9aa0aa; } a { color: #3987e5; } }
</style>
<h1>cucumber-bench</h1>
<p>A benchmark runner for AI systems: a plain model call and custom harnesses on the same cases,
in the same sandbox, graded against private gold data. Each page below is one run: the results
per benchmark, a comparison table, and the definitions of every metric and grader.</p>
<ul>
${items}
</ul>
<p><small>The pages hold numbers and descriptions only; the cases and gold data are not published.</small></p>
`;
await writeFile(join('docs', '.nojekyll'), '');
await writeFile(join('docs', 'index.html'), html);
console.log(`docs/index.html with ${entries.length} run(s): ${entries.map((e) => e.id).join(', ')}`);

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
