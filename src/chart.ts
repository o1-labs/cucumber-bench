import assert from 'node:assert/strict';
import type { Case } from './caseStore.js';
import type { RunRecord } from './runner.js';
import { summarize, type Row } from './stats.js';

export { buildChartHtml };

// series slots 1-3 of the validated reference palette (dark steps are selected, not flipped)
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70'];

// one-sentence definitions for the page, from the harness and benchmark manifests
type Help = { systems: { [name: string]: string }; graders: { [name: string]: string } };

// self-contained chart page for one run: per-suite pass-rate charts, a latency chart,
// a comparison table per suite with the best value in bold, and a glossary
function buildChartHtml(runId: string, cases: Case[], records: RunRecord[], help: Help = { systems: {}, graders: {} }): string {
  let rows = summarize(cases, records);
  // the models each system actually called, as the proxy recorded them
  let modelsOf = (sys: string) => [...new Set(records.filter((r) => r.run.system === sys).flatMap((r) => r.run.models ?? []))];
  let tasks = [...new Set(rows.filter((r) => r.task !== 'ALL').map((r) => r.task))];
  let systems = [...new Set(rows.map((r) => r.system))];
  assert(systems.length <= SERIES_LIGHT.length, `chart supports up to ${SERIES_LIGHT.length} systems, got ${systems.length}`);
  let reps = Math.max(...records.map((r) => r.run.repetition));
  let row = (task: string, system: string): Row | undefined =>
    rows.find((r) => r.task === task && r.system === system);
  // every grader of the run, for the table columns
  let graders = [...new Set(rows.flatMap((r) => Object.keys(r.graders)))];

  // charts: per suite, the pass rate of every grader; and per task when a suite has several tasks
  let pct = { yMax: 100, ticks: [0, 25, 50, 75, 100], fmt: (v: number) => `${Math.round(v)}%` };
  let suites = [...new Set(rows.map((r) => r.suite))];
  let suiteCharts = '';
  for (let suite of suites) {
    let sRows = rows.filter((r) => r.suite === suite);
    let sTasks = [...new Set(sRows.filter((r) => r.task !== 'ALL').map((r) => r.task))];
    let sGraders = [...new Set(sRows.flatMap((r) => Object.keys(r.graders)))];
    let sRow = (task: string, sys: string) => sRows.find((r) => r.task === task && r.system === sys);
    suiteCharts += columnsChart({
      title: `${suite}: pass rate by grader`,
      subtitle: 'Each group is one grader, each column one system. The height is the share of runs that passed. Higher is better.',
      tasks: sGraders,
      systems,
      value: (g, sys) => (sRow('ALL', sys)?.graders[g]?.pass ?? 0) * 100,
      ...pct,
    });
    if (sTasks.length > 1) {
      let sPrimary = sGraders[0];
      suiteCharts += columnsChart({
        title: `${suite}: ${sPrimary} pass rate by task`,
        subtitle: `Each column is one system. The height is the share of runs that passed the ${sPrimary} grader for that task. Higher is better.`,
        tasks: sTasks,
        systems,
        value: (t, sys) => (sRow(t, sys)?.graders[sPrimary]?.pass ?? 0) * 100,
        ...pct,
      });
    }
  }
  let latS = (t: string, sys: string) => (row(t, sys)?.latencyMs ?? 0) / 1000;
  let latTicks = niceTicks(Math.max(...tasks.flatMap((t) => systems.map((sys) => latS(t, sys)))));
  let latChart = columnsChart({
    title: 'Latency by task',
    subtitle:
      'Each column is one system. The height is the average wall time of one run, in seconds. Lower is better. ' +
      'This includes the container start, all model calls, and the safety stages.',
    tasks,
    systems,
    value: latS,
    yMax: latTicks[latTicks.length - 1],
    ticks: latTicks,
    fmt: (v) => `${round1(v)}s`,
  });

  // comparison tables: one per suite, one column per system, one row per metric;
  // the best value in a row is bold (a second cue beside the number, never color alone)
  let fmtGrade = (g?: Row['graders'][string]) =>
    !g ? '—' : Math.abs(g.pass - g.score) > 0.005 ? `${Math.round(g.pass * 100)}% (${Math.round(g.score * 100)}%)` : `${Math.round(g.pass * 100)}%`;
  let tables = '';
  for (let suite of suites) {
    let sRows = rows.filter((r) => r.suite === suite);
    let sTasks = [...new Set(sRows.filter((r) => r.task !== 'ALL').map((r) => r.task))];
    let sGraders = [...new Set(sRows.flatMap((r) => Object.keys(r.graders)))];
    let at = (task: string, sys: string) => sRows.find((r) => r.task === task && r.system === sys);
    // a metric row: label, the value per system, and the direction that is better
    type Metric = { label: string; values: (number | undefined)[]; cells: string[]; higher: boolean };
    let metrics: Metric[] = [];
    let gradeMetric = (label: string, task: string, g: string) =>
      metrics.push({
        label,
        values: systems.map((sys) => at(task, sys)?.graders[g]?.pass),
        cells: systems.map((sys) => fmtGrade(at(task, sys)?.graders[g])),
        higher: true,
      });
    for (let g of sGraders) {
      gradeMetric(`${g} ↑`, 'ALL', g);
      if (sTasks.length > 1) for (let t of sTasks) gradeMetric(`${g} — ${label(t)} ↑`, t, g);
    }
    let num = (label: string, higher: boolean, value: (r?: Row) => number | undefined, fmt: (v: number) => string) =>
      metrics.push({
        label,
        values: systems.map((sys) => value(at('ALL', sys))),
        cells: systems.map((sys) => {
          let v = value(at('ALL', sys));
          return v === undefined ? '—' : fmt(v);
        }),
        higher,
      });
    num('consistency ↑', true, (r) => r?.consistency, (v) => `${Math.round(v * 100)}%`);
    num('latency s ↓', false, (r) => r?.latencyMs, (v) => `${round1(v / 1000)}`);
    num('tokens in/out ↓', false, (r) => (r ? r.tokensIn + r.tokensOut : undefined), () => '');
    metrics[metrics.length - 1].cells = systems.map((sys) => {
      let r = at('ALL', sys);
      return r ? `${Math.round(r.tokensIn)}/${Math.round(r.tokensOut)}` : '—';
    });
    num('calls ↓', false, (r) => r?.calls, (v) => `${round1(v)}`);
    let n = systems.map((sys) => at('ALL', sys)?.n ?? 0);
    let usd4 = (v: number) => `$${v.toFixed(4)}`;
    let usd2 = (v: number) => `$${v.toFixed(2)}`;
    num('harness cost per run ↓', false, (r) => r?.costUsd, usd4);
    num('judge calls per run ↓', false, (r) => r?.judgeCalls, (v) => `${round1(v)}`);
    num('judge tokens in/out ↓', false, (r) => (r ? r.judgeTokensIn + r.judgeTokensOut : undefined), () => '');
    metrics[metrics.length - 1].cells = systems.map((sys) => {
      let r = at('ALL', sys);
      return r ? `${Math.round(r.judgeTokensIn)}/${Math.round(r.judgeTokensOut)}` : '—';
    });
    num('judge cost per run ↓', false, (r) => r?.judgeCostUsd, usd4);
    // the bill for this system over all its runs: per-run cost times the number of runs
    num(`harness cost, all ${n[0]} runs ↓`, false, (r) => (r?.costUsd === undefined ? undefined : r.n * r.costUsd), usd2);
    num(`judge cost, all ${n[0]} runs ↓`, false, (r) => (r?.judgeCostUsd === undefined ? undefined : r.n * r.judgeCostUsd), usd2);
    num(`total cost, all ${n[0]} runs ↓`, false, (r) => (r && r.costUsd !== undefined ? r.n * (r.costUsd + (r.judgeCostUsd ?? 0)) : undefined), usd2);

    let body = metrics
      .map((m) => {
        let defined = m.values.filter((v): v is number => v !== undefined);
        let best = defined.length > 1 ? (m.higher ? Math.max(...defined) : Math.min(...defined)) : undefined;
        let cells = m.cells.map((cell, i) => {
          let isBest = best !== undefined && m.values[i] !== undefined && Math.abs(m.values[i]! - best) < 1e-9;
          return `<td${isBest ? ' class="best"' : ''}>${cell}</td>`;
        });
        return `<tr><td>${esc(m.label)}</td>${cells.join('')}</tr>`;
      })
      .join('\n');
    tables += `<div class="card">
  <h2>${esc(suite)}: comparison</h2>
  <p class="csub">One column per system, one row per metric. ↑ means higher is better, ↓ lower. Bold marks the best value in a row. Runs per system: ${systems.map((sys, i) => `${esc(sys)} ${n[i]}`).join(', ')}.</p>
  <div class="scroll"><table>
    <thead><tr><th>metric</th>${systems.map((sys, i) => `<th><span class="key s${i + 1}"></span> ${esc(sys)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>
</div>
`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cucumber-bench ${esc(runId)}</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb;
  --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  ${SERIES_LIGHT.map((c, i) => `--s${i + 1}: ${c};`).join(' ')}
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    ${SERIES_DARK.map((c, i) => `--s${i + 1}: ${c};`).join(' ')}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19;
  --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  ${SERIES_DARK.map((c, i) => `--s${i + 1}: ${c};`).join(' ')}
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--page); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 24px; max-width: 760px; margin: 0 auto;
}
h1 { font-size: 18px; font-weight: 600; }
.sub { color: var(--ink-2); margin: 4px 0 20px; font-size: 13px; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 18px; margin-bottom: 12px;
}
.card h2 { font-size: 14px; font-weight: 600; }
.card .csub { color: var(--muted); font-size: 12px; margin: 1px 0 4px; }
.help p, .help li, .defs li { font-size: 13px; color: var(--ink-2); }
.help ul, .defs { margin: 6px 0 0 18px; padding: 0; }
.defs { margin-top: 12px; }
.help b, .defs b { color: var(--ink); font-weight: 600; }
.legend { display: flex; gap: 16px; margin: 6px 0 2px; font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.key { width: 12px; height: 12px; border-radius: 3px; display: inline-block; flex: none; }
${SERIES_LIGHT.map((_, i) => `.s${i + 1} { background: var(--s${i + 1}); }`).join('\n')}
svg { width: 100%; height: auto; display: block; }
.tick { font: 11px system-ui, sans-serif; fill: var(--muted); font-variant-numeric: tabular-nums; }
.cat { font: 12px system-ui, sans-serif; fill: var(--ink-2); }
.gridline { stroke: var(--grid); stroke-width: 1; }
.baseline { stroke: var(--axis); stroke-width: 1; }
.hit { fill: transparent; outline: none; cursor: default; }
.hit:focus-visible + .focusring { stroke: var(--ink); stroke-width: 1.5; fill: none; }
.lift { filter: brightness(1.12); }
#tip {
  display: none; position: fixed; z-index: 10; pointer-events: none;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.12); font-size: 12px;
}
.tip-task { color: var(--ink-2); margin-bottom: 4px; }
.tip-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.tip-row .key { width: 10px; height: 4px; border-radius: 2px; }
.tip-val { font-weight: 600; font-variant-numeric: tabular-nums; }
.tip-name { color: var(--ink-2); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td:nth-child(n+2), th:nth-child(n+2) { text-align: right; font-variant-numeric: tabular-nums; }
th { color: var(--ink-2); font-weight: 500; }
td.best { font-weight: 700; }
th .key { vertical-align: -1px; }
.scroll { overflow-x: auto; }
</style>
</head>
<body>
<h1>cucumber-bench</h1>
<p class="sub">run ${esc(runId)} · ${new Set(records.map((r) => r.run.caseId)).size} cases · ${reps} repetition${reps > 1 ? 's' : ''}</p>
<div class="card help">
  <h2>How to read this page</h2>
  <p>Each system received the same cases. A <b>grader</b> compares each output with private gold data and returns pass or fail.
  The <b>pass rate</b> is the share of runs that passed.
  Each benchmark has a chart with one group per grader. A benchmark with several tasks also has a chart per task for its first grader.
  The comparison table has one column per system and marks the best value in a row in bold. Move the pointer over a chart column to see its numbers.</p>
  <ul>${systems.map((sys, i) => `<li><span class="key s${i + 1}"></span> <b>${esc(sys)}</b> — ${esc(help.systems[sys] || 'A system under test.')} Models used: ${esc(modelsOf(sys).join(', ') || 'none recorded')}.</li>`).join('')}</ul>
</div>
${suiteCharts}
${latChart}
${tables}
<div class="card">
  <h2>Glossary</h2>
  <ul class="defs">
        ${graders.map((g) => `<li><b>${esc(g)}</b> — ${esc(help.graders[g] || 'No description.')} The cell shows the pass rate. A value in parentheses is the mean score, when it differs from the pass rate. Higher is better.</li>`).join('\n    ')}
    <li><b>consistency</b> — the share of repetitions that gave the same answer for a case, averaged over cases. Shown as — with one repetition. Higher is better.</li>
    <li><b>latency s</b> — the average wall time of one run, in seconds. Lower is better.</li>
    <li><b>tokens in/out</b> — the average number of tokens sent to and received from the model per run. The proxy counts them. Lower is better.</li>
    <li><b>calls</b> — the average number of model calls per run. Calls to the safety model are included. Lower is better.</li>
    <li><b>harness cost per run</b> — the average cost of one harness run in dollars, as the provider reported it (OpenRouter), else from the configured prices. Shown as — for a free local model. Lower is better.</li>
    <li><b>judge calls, judge tokens, judge cost per run</b> — what the graders spent on the judge model to grade one run. This is the cost of measuring, not of the harness. Lower is better.</li>
    <li><b>harness cost, judge cost, total cost, all runs</b> — the per-run cost times the number of runs (cases × repetitions). Total is harness plus judge: the bill for this system in this benchmark. Lower is better.</li>
  </ul>
</div>
<div id="tip" role="status"></div>
<script>
(function () {
  var tip = document.getElementById('tip');
  function show(el) {
    var data = JSON.parse(el.getAttribute('data-tip'));
    tip.replaceChildren();
    var t = document.createElement('div');
    t.className = 'tip-task';
    t.textContent = data.task;
    tip.appendChild(t);
    data.rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'tip-row';
      var key = document.createElement('span');
      key.className = 'key ' + r.key;
      var val = document.createElement('span');
      val.className = 'tip-val';
      val.textContent = r.value;
      var name = document.createElement('span');
      name.className = 'tip-name';
      name.textContent = r.name;
      row.appendChild(key); row.appendChild(val); row.appendChild(name);
      tip.appendChild(row);
    });
    tip.style.display = 'block';
    var col = document.getElementById(el.getAttribute('data-col'));
    if (col) col.classList.add('lift');
  }
  function hide(el) {
    tip.style.display = 'none';
    var col = document.getElementById(el.getAttribute('data-col'));
    if (col) col.classList.remove('lift');
  }
  function place(x, y) {
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(y + 14, innerHeight - h - 8)) + 'px';
  }
  document.querySelectorAll('.hit').forEach(function (el) {
    el.addEventListener('pointerenter', function () { show(el); });
    el.addEventListener('pointermove', function (e) { place(e.clientX, e.clientY); });
    el.addEventListener('pointerleave', function () { hide(el); });
    el.addEventListener('focus', function () {
      show(el);
      var r = el.getBoundingClientRect();
      place(r.left + r.width / 2, r.top);
    });
    el.addEventListener('blur', function () { hide(el); });
  });
})();
</script>
</body>
</html>
`;
}

// internal helpers

// one grouped-columns chart card as inline svg
function columnsChart(opts: {
  title: string;
  subtitle: string;
  tasks: string[];
  systems: string[];
  value: (task: string, system: string) => number;
  yMax: number;
  ticks: number[];
  fmt: (v: number) => string;
}): string {
  let { tasks, systems, value, yMax, ticks, fmt } = opts;
  let W = 640, H = 240;
  let ml = 44, mr = 8, mt = 12, mb = 40;
  let plotW = W - ml - mr, plotH = H - mt - mb;
  let chartId = opts.title.toLowerCase().replace(/[^a-z]+/g, '-');

  let colW = 24, gap = 2; // <=24px marks, 2px surface gap between adjacent bars
  let band = plotW / tasks.length;
  let groupW = systems.length * colW + (systems.length - 1) * gap;
  let y = (v: number) => mt + plotH - (v / yMax) * plotH;

  let parts: string[] = [];
  for (let tick of ticks) {
    parts.push(`<line class="${tick === 0 ? 'baseline' : 'gridline'}" x1="${ml}" x2="${W - mr}" y1="${y(tick)}" y2="${y(tick)}"/>`);
    parts.push(`<text class="tick" x="${ml - 6}" y="${y(tick) + 3.5}" text-anchor="end">${fmt(tick)}</text>`);
  }

  for (let ti = 0; ti < tasks.length; ti++) {
    let x0 = ml + ti * band + (band - groupW) / 2;
    // rows for this task's tooltip: every series at this x
    let rows = systems.map((sys, si) => ({ key: `s${si + 1}`, name: sys, value: fmt(value(tasks[ti], sys)) }));
    let tipData = esc(JSON.stringify({ task: label(tasks[ti]), rows }));
    let aria = `${label(tasks[ti])}: ${rows.map((r) => `${r.name} ${r.value}`).join(', ')}`;

    for (let si = 0; si < systems.length; si++) {
      let v = value(tasks[ti], systems[si]);
      let x = x0 + si * (colW + gap);
      let colId = `${chartId}-${ti}-${si}`;
      if (v > 0) parts.push(`<path id="${colId}" fill="var(--s${si + 1})" d="${columnPath(x, y(v), colW, y(0) - y(v))}"/>`);
      // hit target wider than the mark, full plot height, keyboard-focusable
      parts.push(
        `<rect class="hit" x="${x - 2}" y="${mt}" width="${colW + 4}" height="${plotH}" ` +
          `tabindex="0" role="img" aria-label="${esc(aria)}" data-tip="${tipData}" data-col="${colId}"/>`,
      );
      parts.push(`<rect class="focusring" x="${x - 2}" y="${mt}" width="${colW + 4}" height="${plotH}" fill="none"/>`);
    }

    // task label, wrapped onto two lines when long
    let [l1, l2] = wrapLabel(label(tasks[ti]));
    let lx = ml + ti * band + band / 2;
    parts.push(`<text class="cat" x="${lx}" y="${H - mb + 16}" text-anchor="middle">${esc(l1)}</text>`);
    if (l2) parts.push(`<text class="cat" x="${lx}" y="${H - mb + 30}" text-anchor="middle">${esc(l2)}</text>`);
  }

  let legend = opts.systems
    .map((sys, i) => `<span><span class="key s${i + 1}"></span>${esc(sys)}</span>`)
    .join('');

  return `<div class="card">
  <h2>${esc(opts.title)}</h2>
  <p class="csub">${esc(opts.subtitle)}</p>
  <div class="legend">${legend}</div>
  <svg viewBox="0 0 ${W} ${H}" aria-hidden="false">${parts.join('\n')}</svg>
</div>`;
}

// column with 4px rounded data-end, square at the baseline
function columnPath(x: number, top: number, w: number, h: number): string {
  let r = Math.min(4, w / 2, h);
  let bottom = top + h;
  return `M ${x} ${bottom} L ${x} ${top + r} Q ${x} ${top} ${x + r} ${top} L ${x + w - r} ${top} Q ${x + w} ${top} ${x + w} ${top + r} L ${x + w} ${bottom} Z`;
}

function niceTicks(max: number): number[] {
  let steps = [0.5, 1, 2, 4, 5, 10, 20, 25, 50, 100];
  let step = steps.find((s) => max / s <= 4) ?? 10 ** Math.ceil(Math.log10(max / 4));
  let top = Math.ceil(max / step) * step;
  let ticks = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  return ticks;
}

function label(task: string): string {
  return task.replace(/_/g, ' ');
}

function wrapLabel(s: string): [string, string?] {
  if (s.length <= 14) return [s];
  let mid = Math.floor(s.length / 2);
  let split = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ' && (split === -1 || Math.abs(i - mid) < Math.abs(split - mid))) split = i;
  }
  return split === -1 ? [s] : [s.slice(0, split), s.slice(split + 1)];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
