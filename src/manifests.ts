import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type { Grader } from './types.js';
import { exactGrader } from './graders/exact.js';
import { strEmGrader } from './graders/strEm.js';

export { loadHarnesses, loadBenchmarks, type HarnessManifest, type BenchmarkManifest };

// harnesses/<name>/harness.json
type HarnessManifest = {
  name: string;
  dir: string;
  entry: string; // relative to dir; .ts runs under tsx, .mjs under node
  description?: string;
  suites: string[]; // the benchmarks this harness runs on
  models?: { main?: string; safety?: string }; // the harness's own model choice; env defaults fill the gaps
  image: string; // docker image; the shared base image unless the harness has its own
  imageEntry: string; // the entry path inside the image
  dockerfile?: string; // relative to dir; present when the harness builds its own image
};

// benchmarks/<name>/benchmark.json
type BenchmarkManifest = {
  name: string;
  dir: string;
  graders: Grader[];
  judge?: { model: string }; // the judge model the benchmark's graders need; env default when absent
};

// graders that live in the core and can be named in benchmark.json
const CORE_GRADERS: { [name: string]: () => Grader } = { exact: exactGrader, 'str-em': strEmGrader };

async function loadHarnesses(root: string): Promise<HarnessManifest[]> {
  let out: HarnessManifest[] = [];
  for (let dir of await subdirs(root)) {
    let m = JSON.parse(await readFile(join(dir, 'harness.json'), 'utf8'));
    assert(m.name && m.entry && Array.isArray(m.suites), `${dir}/harness.json needs name, entry, suites`);
    out.push({ dir, image: 'cucumber-harness-base', imageEntry: `/app/${m.name}/${m.entry}`, ...m });
  }
  return out;
}

// graders are named core graders, or module paths ('./graders.ts', '../asqa/graders.ts') exporting { graders: Grader[] }
async function loadBenchmarks(root: string): Promise<BenchmarkManifest[]> {
  let out: BenchmarkManifest[] = [];
  for (let dir of await subdirs(root)) {
    let m = JSON.parse(await readFile(join(dir, 'benchmark.json'), 'utf8'));
    assert(m.name && Array.isArray(m.graders), `${dir}/benchmark.json needs name and graders`);
    let graders: Grader[] = [];
    for (let g of m.graders as string[]) {
      if (g.startsWith('./') || g.startsWith('../')) {
        let mod = await import(pathToFileURL(resolve(dir, g)).href);
        assert(Array.isArray(mod.graders), `${dir}/${g} must export { graders }`);
        graders.push(...mod.graders);
      } else {
        assert(CORE_GRADERS[g], `${dir}/benchmark.json: unknown core grader ${g}`);
        graders.push(CORE_GRADERS[g]());
      }
    }
    out.push({ name: m.name, dir, graders, judge: m.judge });
  }
  return out;
}

// internal helpers

async function subdirs(root: string): Promise<string[]> {
  let entries = await readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name)).sort();
}
