import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import type { SystemUnderTest } from '../types.js';

export { sandboxedSystem, dockerArgv };

// runs a system as an isolated child process (optionally a docker container).
// wire protocol: stdin gets {publicCase, proxyUrl, token, model} as json, stdout
// returns {output} or {error}. the child never receives private cases, api keys,
// or the upstream url; usage comes from the proxy's server-side accounting.
type SandboxOpts = {
  name: string;
  info?: string;
  argv: string[];
  // docker mode: the proxy's loopback address must become the host gateway name
  rewriteHost?: boolean;
  timeoutMs?: number;
};

function sandboxedSystem(opts: SandboxOpts): SystemUnderTest {
  return {
    name: opts.name,
    info: opts.info,
    async run(c, ctx) {
      assert(ctx.proxy, `${opts.name}: runner must start a model proxy for sandboxed systems`);
      let token = ctx.proxy.register(`${ctx.runId}/${c.id}/rep${ctx.repetition}`);
      let proxyUrl = opts.rewriteHost
        ? ctx.proxy.url.replace('127.0.0.1', 'host.docker.internal')
        : ctx.proxy.url;
      let payload = JSON.stringify({ publicCase: c, proxyUrl, token, model: ctx.model.model });

      let { stdout, error } = await runChild(opts.argv, payload, opts.timeoutMs ?? 300_000);
      let output = '';
      if (!error) {
        try {
          let parsed = JSON.parse(stdout);
          output = parsed.output ?? '';
          error = parsed.error;
        } catch {
          error = `sandbox wrote invalid json: ${stdout.slice(0, 200)}`;
        }
      }
      return {
        caseId: c.id,
        system: opts.name,
        repetition: ctx.repetition,
        output,
        error,
        latencyMs: 0,
        ...ctx.proxy.usage(token),
      };
    },
  };
}

// hardened per-run container: read-only fs, no capabilities, resource caps.
// egress lockdown (internal network + proxy sidecar) is the server-deployment step.
function dockerArgv(image: string): string[] {
  // prettier-ignore
  return [
    'docker', 'run', '--rm', '-i',
    '--read-only', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '1g', '--cpus', '2',
    '--add-host', 'host.docker.internal:host-gateway',
    image,
  ];
}

// internal helpers

function runChild(
  argv: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, error: `sandbox spawn failed: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') resolve({ stdout, error: `sandbox timed out after ${timeoutMs}ms` });
      else if (code !== 0) resolve({ stdout, error: `sandbox exited ${code}: ${stderr.slice(0, 300)}` });
      else resolve({ stdout });
    });
    child.stdin.end(stdin);
  });
}
