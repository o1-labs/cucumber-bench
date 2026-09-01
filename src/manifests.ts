import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type { Grader } from './types.js';
import { exactGrader } from './graders/exact.js';
import { strEmGrader } from './graders/strEm.js';

export { loadHarnesses, loadBenchmarks, uniqueGraders, type HarnessManifest, type BenchmarkManifest };

// harnesses/<name>/harness.json
type HarnessManifest = {
  name: string;
  dir: string;
  entry: string; // relative to dir; .ts runs under tsx, .mjs under node
  description?: string;
  suites: string[]; // the benchmarks this harness runs on
  // the harness's models: main on the guarded route, safety on the safety route (default: main);
  // further roles (e.g. compose) are the harness's own and also allowed on the guarded route
  models: { main: string; safety?: string; [role: string]: string | undefined };
  // per-model upstreams; a model not named goes to BENCH_BASE_URL. the url is infrastructure,
  // not a secret; keyEnv names the env variable that holds the key (default: none)
  providers?: { [model: string]: { baseUrl: string; keyEnv?: string } };
  maxCalls?: number; // model calls per run this harness needs; default BENCH_MAX_CALLS (20)
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

// graders that live in the core and can be named in benchmark.json; one instance each, so
// two benchmarks that name the same core grader share it
const CORE_GRADERS: { [name: string]: Grader } = { exact: exactGrader(), 'str-em': strEmGrader() };

async function loadHarnesses(root: string): Promise<HarnessManifest[]> {
  let out: HarnessManifest[] = [];
  for (let dir of await subdirs(root)) {
    let m = JSON.parse(await readFile(join(dir, 'harness.json'), 'utf8'));
    assert(m.name && m.entry && Array.isArray(m.suites), `${dir}/harness.json needs name, entry, suites`);
    assert(typeof m.models?.main === 'string', `${dir}/harness.json needs models.main: the harness names its own model`);
    // a providers key that names no model would silently route that model to the default upstream
    for (let model of Object.keys(m.providers ?? {})) {
      assert(typeof m.providers[model].baseUrl === 'string', `${dir}/harness.json: providers[${model}] needs a baseUrl`);
      assert(Object.values(m.models).includes(model), `${dir}/harness.json: providers names ${model}, which is not one of the harness's models`);
    }
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
        graders.push(CORE_GRADERS[g]);
      }
    }
    out.push({ name: m.name, dir, graders, judge: m.judge });
  }
  return out;
}

// every grader of the project once. a grader module imported by two benchmarks is the same
// module instance, so the same name from two different implementations is a conflict
function uniqueGraders(benchmarks: BenchmarkManifest[]): Grader[] {
  let out: Grader[] = [];
  for (let b of benchmarks) {
    for (let g of b.graders) {
      let other = out.find((o) => o.name === g.name);
      assert(!other || other === g, `benchmark ${b.name}: the grader name ${g.name} is already taken by a different implementation`);
      if (!other) out.push(g);
    }
  }
  return out;
}

// internal helpers

async function subdirs(root: string): Promise<string[]> {
  let entries = await readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name)).sort();
}
