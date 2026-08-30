import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCases, type Case } from './caseStore.js';
import { resolveModelConfig } from './config.js';
import { loadBenchmarks, loadHarnesses, uniqueGraders, type BenchmarkManifest, type HarnessManifest } from './manifests.js';
import { dockerArgv, sandboxedSystem } from './sandbox.js';
import { startProxy } from './proxy.js';
import type { Grader, ModelProxy, SystemUnderTest } from './types.js';

export { loadProject, startProxyFor, gitState, type Project };

// everything a cli needs: the manifests, the cases, the graders, the systems built
// from the harness manifests, the judge per suite, and the descriptions for the chart
type Project = {
  cfg: ReturnType<typeof resolveModelConfig>;
  harnesses: HarnessManifest[];
  benchmarks: BenchmarkManifest[];
  cases: Case[];
  graders: Grader[];
  systems: Map<string, SystemUnderTest>;
  judgeFor: (suite: string) => string;
  help: { systems: { [name: string]: string }; graders: { [name: string]: string } };
};

async function loadProject(opts: { judgeOverride?: string } = {}): Promise<Project> {
  let cfg = resolveModelConfig();
  let harnesses = await loadHarnesses('harnesses');
  let benchmarks = await loadBenchmarks('benchmarks');
  let cases = await loadCases('benchmarks');
  let graders = uniqueGraders(benchmarks);

  // a harness names its models; the safety model defaults to the main one
  let systems = new Map(
    harnesses.map((h) => {
      let models = { main: h.models.main, safety: h.models.safety ?? h.models.main };
      return [h.name, sandboxedSystem(h.name, argvFor(h), models, h.suites, h.maxCalls)];
    }),
  );

  // a benchmark names its judge; --judge overrides for calibration runs; env is the default
  let judgeFor = (suite: string) =>
    opts.judgeOverride ?? benchmarks.find((b) => b.name === suite)?.judge?.model ?? cfg.judgeModel;

  let help = {
    systems: Object.fromEntries(harnesses.map((h) => [h.name, h.description ?? ''])),
    graders: Object.fromEntries(graders.map((g) => [g.name, g.description])),
  };
  return { cfg, harnesses, benchmarks, cases, graders, systems, judgeFor, help };
}

// systems reach models only through the accounting proxy
function startProxyFor(cfg: Project['cfg']): Promise<ModelProxy> {
  return startProxy({
    upstreamUrl: cfg.baseUrl,
    upstreamKey: cfg.apiKey,
    judgeUpstreamUrl: cfg.judgeBaseUrl,
    judgeUpstreamKey: cfg.judgeApiKey,
    defaultTemperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    maxCalls: Number(process.env.BENCH_MAX_CALLS ?? 20),
    maxJudgeCalls: Number(process.env.BENCH_MAX_JUDGE_CALLS ?? 100),
  });
}

// the code state of a run, for run.json: the commit and the files changed since it
function gitState() {
  let git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
  let dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3));
  return { rev: git(['rev-parse', 'HEAD']), dirty };
}

// internal helpers

// every harness is a sandbox entry script: child process by default,
// a docker container with BENCH_SANDBOX=docker
function argvFor(h: HarnessManifest): string[] {
  if (process.env.BENCH_SANDBOX === 'docker') return dockerArgv(h.image, h.imageEntry);
  let entry = join(h.dir, h.entry);
  return entry.endsWith('.ts') ? [process.execPath, 'node_modules/tsx/dist/cli.mjs', entry] : [process.execPath, entry];
}
