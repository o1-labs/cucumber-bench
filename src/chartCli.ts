import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadCases } from './caseStore.js';
import { buildChartHtml } from './chart.js';
import type { Record } from './runner.js';

// usage: npm run chart -- runs/<runId>
let runDir = process.argv[2];
assert(runDir, 'usage: npm run chart -- runs/<runId>');

let jsonl = await readFile(join(runDir, 'results.jsonl'), 'utf8');
let records: Record[] = jsonl.trim().split('\n').map((line) => JSON.parse(line));
let cases = await loadCases('cases');
let runId = runDir.replace(/\/+$/, '').split('/').pop()!;

// model name from the report if present, otherwise unknown
let model = 'unknown';
try {
  let report = await readFile(join(runDir, 'report.md'), 'utf8');
  model = report.match(/^(?:Default )?[Mm]odel: (.+)$/m)?.[1] ?? model;
} catch {}

let out = join(runDir, 'chart.html');
await writeFile(out, buildChartHtml(runId, model, cases, records));
console.log(`written to ${out}`);
