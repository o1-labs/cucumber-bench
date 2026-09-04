import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export { publishSite };

// copies the chart of every run named into docs/runs/<runId>/, renders every docs/*.md page
// to html, and writes docs/index.html, the page GitHub Pages serves. charts and docs hold
// numbers and descriptions only; report.md and results.jsonl name gold data and stay out.
async function publishSite(runDirs: string[]) {
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

  // the markdown pages in docs/, rendered so they read well in the browser
  let docs: { file: string; title: string }[] = [];
  for (let f of (await readdir('docs')).filter((f) => f.endsWith('.md')).sort()) {
    let md = await readFile(join('docs', f), 'utf8');
    let title = md.match(/^# (.+)$/m)?.[1] ?? f;
    let out = f.replace(/\.md$/, '.html');
    await writeFile(join('docs', out), docPage(title, mdToHtml(md), f));
    docs.push({ file: out, title });
  }
  let docItems = docs.map((d) => `<li><a href="${d.file}">${esc(d.title)}</a></li>`).join('\n');

  let items = entries
    .map((e) => `<li><a href="runs/${e.id}/chart.html">${esc(e.title)}</a><br><small>${esc(e.note)} · run ${esc(e.id)}</small></li>`)
    .join('\n');
  let html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cucumber-bench</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; color: #1b1f24; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
  li { margin: 0.8rem 0; } small { color: #57606a; } a { color: #2a78d6; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #e6e8eb; } small { color: #9aa0aa; } a { color: #3987e5; } }
</style>
<h1>cucumber-bench</h1>
<p>A benchmark runner for AI systems: a plain model call and custom harnesses on the same cases,
in the same sandbox, graded against private gold data. Each run page shows the results per
benchmark, a comparison table, and the definitions of every metric and grader.</p>
<h2>Documentation</h2>
<ul>
${docItems}
</ul>
<h2>Runs</h2>
<ul>
${items}
</ul>
<p><small>The pages hold numbers and descriptions only; the cases and gold data are not published.</small></p>
`;
  await writeFile(join('docs', '.nojekyll'), '');
  await writeFile(join('docs', 'index.html'), html);
  console.log(`docs/index.html with ${entries.length} run(s): ${entries.map((e) => e.id).join(', ')}`);
}

// internal helpers

// a small renderer for the markdown subset the docs use: headings, paragraphs, lists,
// tables, fenced code, inline code, bold, links. not a general markdown parser
function mdToHtml(md: string): string {
  let out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let table: string[][] | null = null;
  let fence: string[] | null = null;

  let flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  let flushList = () => {
    if (list) out.push(`<${list.tag}>` + list.items.map((i) => `<li>${inline(i)}</li>`).join('') + `</${list.tag}>`);
    list = null;
  };
  let flushTable = () => {
    if (table) {
      let [head, ...rows] = table;
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      );
      table = null;
    }
  };
  let flush = () => { flushPara(); flushList(); flushTable(); };

  for (let line of md.split('\n')) {
    if (fence) {
      if (line.startsWith('```')) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; }
      else fence.push(line);
      continue;
    }
    if (line.startsWith('```')) { flush(); fence = []; continue; }
    let h = line.match(/^(#{1,3}) (.+)$/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (line.startsWith('|')) {
      flushPara(); flushList();
      // the |---|---| separator row carries no content
      if (/^[|\s:-]+$/.test(line) && line.includes('-')) continue;
      (table ??= []).push(line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }
    let li = line.match(/^- (.*)$/) ?? line.match(/^\d+\. (.*)$/);
    if (li) {
      flushPara(); flushTable();
      let tag: 'ul' | 'ol' = line.startsWith('-') ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(li[1]);
      continue;
    }
    // an indented line continues the last list item
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    if (line.trim() === '') { flush(); continue; }
    flushList(); flushTable();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

// inline markdown: code spans, bold, links; relative .md links point at the rendered page
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      let h = /^https?:/.test(href) ? href : href.replace(/\.md$/, '.html');
      return `<a href="${h}">${text}</a>`;
    });
}

function docPage(title: string, body: string, source: string): string {
  return `<!doctype html>
<!-- generated from ${source} by npm run site; edit the markdown, not this file -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · cucumber-bench</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1rem; color: #1b1f24; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; } h3 { font-size: 1.05rem; }
  a { color: #2a78d6; }
  code { background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 4px; font-size: 0.9em; }
  pre { background: rgba(0,0,0,0.05); padding: 12px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e1e0d9; vertical-align: top; }
  .top { color: #57606a; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8eb; } a { color: #3987e5; }
    code, pre { background: rgba(255,255,255,0.08); } th, td { border-color: #2c2c2a; }
    .top { color: #9aa0aa; }
  }
</style>
<p class="top"><a href="index.html">cucumber-bench</a></p>
${body}
`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
