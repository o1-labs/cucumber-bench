import { spawn, spawnSync } from 'node:child_process';
import type { Models, SystemUnderTest } from './types.js';

export { sandboxedSystem, dockerArgv };
// internal API, exported for tests
export { containerName };

// wall clock per run, then SIGKILL
const TIMEOUT_MS = 300_000;

// every system runs this way: a child process with a bare environment (development
// mode: it shares the file system), or a docker container in docker mode, speaking
// the wire protocol. stdin gets {publicCase, proxyUrl,
// token, models} as json, stdout returns {output, trace?} or {error}. the child
// never receives private cases, api keys, or the upstream url; usage and the
// prompts that reached the model come from the proxy, not from the child.
function sandboxedSystem(name: string, argv: string[], models: Models, suites?: string[], maxCalls?: number): SystemUnderTest {
  // a container reaches the host proxy through the gateway name, not loopback
  let docker = argv[0] === 'docker';
  return {
    name,
    suites,
    models,
    async run(c, ctx) {
      let token = ctx.proxy.register(`${ctx.runId}/${c.id}/rep${ctx.repetition}`, { maxCalls });
      let proxyUrl = docker ? ctx.proxy.url.replace('127.0.0.1', 'host.docker.internal') : ctx.proxy.url;
      let payload = JSON.stringify({ publicCase: c, proxyUrl, token, models });

      // a named container can be killed on timeout; killing the docker cli alone leaves it running.
      // systems run at the same time on the same case, so the name carries the system too
      let container = docker ? containerName(ctx.runId, name, c.id, ctx.repetition) : undefined;
      let cmd = container ? [argv[0], argv[1], '--name', container, ...argv.slice(2)] : argv;
      let { stdout, error } = await runChild(cmd, payload, container);
      let output = '', trace;
      if (!error) {
        try {
          let parsed = JSON.parse(stdout);
          output = parsed.output ?? '';
          trace = parsed.trace;
          error = parsed.error;
        } catch {
          error = `sandbox wrote invalid json: ${stdout.slice(0, 200)}`;
        }
      }
      return {
        caseId: c.id,
        system: name,
        repetition: ctx.repetition,
        output,
        error,
        trace,
        modelRequests: ctx.proxy.requests(token),
        ...ctx.proxy.usage(token),
      };
    },
  };
}

// hardened per-run container running one entry script from the image:
// read-only fs, no capabilities, resource caps. egress lockdown (internal
// network + proxy sidecar) is the server-deployment step.
function dockerArgv(image: string, script: string): string[] {
  // prettier-ignore
  return [
    'docker', 'run', '--rm', '-i',
    '--read-only', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '1g', '--cpus', '2',
    '--add-host', 'host.docker.internal:host-gateway',
    image, script,
  ];
}

// internal helpers

// one docker name per (run, system, case, repetition), in docker's allowed characters
function containerName(runId: string, system: string, caseId: string, rep: number): string {
  return `bench-${runId}-${system}-${caseId}-r${rep}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function runChild(argv: string[], stdin: string, container?: string): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    // detached: the child leads its own process group, so a timeout kills its helpers too.
    // the child gets a bare environment: the parent's holds the provider keys (.env)
    let env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    let child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env });
    let stdout = '', stderr = '';
    let timer = setTimeout(() => {
      if (container) spawnSync('docker', ['kill', container], { stdio: 'ignore' });
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, error: `sandbox spawn failed: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') resolve({ stdout, error: `sandbox timed out after ${TIMEOUT_MS}ms` });
      else if (code !== 0) resolve({ stdout, error: `sandbox exited ${code}: ${stderr.slice(0, 300)}` });
      else resolve({ stdout });
    });
    child.stdin.end(stdin);
  });
}
