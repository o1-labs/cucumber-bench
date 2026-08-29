import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadProject } from './project.js';
import { buildChartHtml } from './chart.js';
import type { RunRecord } from './runner.js';

// usage: npm run chart -- runs/<runId>
let runDir = process.argv[2];
assert(runDir, 'usage: npm run chart -- runs/<runId>');

let jsonl = await readFile(join(runDir, 'results.jsonl'), 'utf8');
let records: RunRecord[] = jsonl.trim().split('\n').map((line) => JSON.parse(line));
let { cases, help } = await loadProject();
let runId = runDir.replace(/\/+$/, '').split('/').pop()!;

let out = join(runDir, 'chart.html');
await writeFile(out, buildChartHtml(runId, cases, records, help));
console.log(`written to ${out}`);
