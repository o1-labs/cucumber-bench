import assert from 'node:assert/strict';
import type { Case } from './caseStore.js';
import type { Record } from './runner.js';
import { consistencyOf, costOf } from './stats.js';

export { buildChartHtml };

// series slots 1-3 of the validated reference palette (dark steps are selected, not flipped)
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70'];

type Agg = { n: number; pass: number; latencyMs: number; tokensIn: number; tokensOut: number; calls: number };

// self-contained chart page for one run: KPI tiles, accuracy + latency grouped
// columns with hover/focus tooltips, and a table view of every number
function buildChartHtml(runId: string, model: string, cases: Case[], records: Record[]): string {
  let taskOf = new Map(cases.map((c) => [c.pub.id, c.pub.task]));
  let tasks = unique(cases.map((c) => c.pub.task));
  let systems = unique(records.map((r) => r.run.system));
  assert(systems.length <= SERIES_LIGHT.length, `chart supports up to ${SERIES_LIGHT.length} systems, got ${systems.length}`);
  let reps = Math.max(...records.map((r) => r.run.repetition));

  // aggregate per task x system, plus ALL per system
  let stats = new Map<string, Agg>();
  for (let { run, grade } of records) {
    for (let task of [taskOf.get(run.caseId)!, 'ALL']) {
      let key = `${task}|${run.system}`;
      let s = stats.get(key) ?? { n: 0, pass: 0, latencyMs: 0, tokensIn: 0, tokensOut: 0, calls: 0 };
      s.n++;
      s.pass += grade.pass ? 1 : 0;
      s.latencyMs += run.latencyMs;
      s.tokensIn += run.tokensIn;
      s.tokensOut += run.tokensOut;
      s.calls += run.modelCalls;
      stats.set(key, s);
    }
  }
  let get = (task: string, system: string) => stats.get(`${task}|${system}`)!;
  let acc = (s: Agg) => (s.n === 0 ? 0 : s.pass / s.n);
  let latS = (s: Agg) => (s.n === 0 ? 0 : s.latencyMs / s.n / 1000);

  // charts
  let accChart = columnsChart({
    title: 'Accuracy by task',
    subtitle: `share of passing runs, ${reps} repetition${reps > 1 ? 's' : ''} per case`,
    tasks,
    systems,
    value: (t, sys) => acc(get(t, sys)) * 100,
    yMax: 100,
    ticks: [0, 25, 50, 75, 100],
    fmt: (v) => `${Math.round(v)}%`,
  });
  let maxLat = Math.max(...tasks.flatMap((t) => systems.map((sys) => latS(get(t, sys)))));
  let latTicks = niceTicks(maxLat);
  let latChart = columnsChart({
    title: 'Latency by task',
    subtitle: 'average wall time per run, seconds',
    tasks,
    systems,
    value: (t, sys) => latS(get(t, sys)),
    yMax: latTicks[latTicks.length - 1],
    ticks: latTicks,
    fmt: (v) => `${round1(v)}s`,
  });

  // kpi tiles: overall accuracy per system, plus consistency when reps > 1
  let sysRecords = (sys: string) => records.filter((r) => r.run.system === sys);
  let tiles = systems
    .map(
      (sys, i) => `
      <div class="tile">
        <div class="tile-label"><span class="key s${i + 1}"></span>${esc(sys)} — overall accuracy</div>
        <div class="tile-value">${Math.round(acc(get('ALL', sys)) * 100)}%</div>
      </div>`,
    )
    .join('');
  tiles += systems
    .map((sys, i) => {
      let cons = consistencyOf(sysRecords(sys));
      if (cons === undefined) return '';
      return `
      <div class="tile">
        <div class="tile-label"><span class="key s${i + 1}"></span>${esc(sys)} — consistency</div>
        <div class="tile-value">${Math.round(cons * 100)}%</div>
      </div>`;
    })
    .join('');

  // table view: the WCAG-clean twin of the charts
  let tableRows = [...tasks, 'ALL']
    .flatMap((task) =>
      systems.map((sys) => {
        let s = get(task, sys);
        let rows = records.filter(
          (r) => r.run.system === sys && (task === 'ALL' || taskOf.get(r.run.caseId) === task),
        );
        let cons = consistencyOf(rows);
        let cost = costOf(rows);
        return `<tr>
          <td>${esc(task)}</td><td>${esc(sys)}</td><td>${s.n}</td>
          <td>${Math.round(acc(s) * 100)}%</td>
          <td>${cons === undefined ? '—' : Math.round(cons * 100) + '%'}</td>
          <td>${round1(latS(s))}</td>
          <td>${Math.round(s.tokensIn / s.n)}/${Math.round(s.tokensOut / s.n)}</td>
          <td>${round1(s.calls / s.n)}</td>
          <td>${cost === undefined ? '—' : '$' + cost.toFixed(4)}</td>
        </tr>`;
      }),
    )
    .join('\n');

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
.tiles { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.tile {
  flex: 1 1 160px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 14px 16px;
}
.tile-label { color: var(--ink-2); font-size: 13px; display: flex; align-items: center; gap: 7px; }
.tile-value { font-size: 28px; font-weight: 600; margin-top: 2px; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 18px; margin-bottom: 12px;
}
.card h2 { font-size: 14px; font-weight: 600; }
.card .csub { color: var(--muted); font-size: 12px; margin: 1px 0 4px; }
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
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); }
td:nth-child(n+3), th:nth-child(n+3) { text-align: right; font-variant-numeric: tabular-nums; }
th { color: var(--ink-2); font-weight: 500; }
tr:last-child td, tr:nth-last-child(2) td { font-weight: 600; }
</style>
</head>
<body>
<h1>cucumber-bench</h1>
<p class="sub">run ${esc(runId)} · model ${esc(model)} · ${cases.length} cases · ${reps} repetition${reps > 1 ? 's' : ''}</p>
<div class="tiles">${tiles}</div>
${accChart}
${latChart}
<div class="card">
  <h2>All numbers</h2>
  <p class="csub">per task and system, averaged over runs</p>
  <table>
    <thead><tr><th>task</th><th>system</th><th>n</th><th>accuracy</th><th>consistency</th><th>latency s</th><th>tokens in/out</th><th>calls</th><th>cost</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
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

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
