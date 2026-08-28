import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ModelProxy, Usage } from './types.js';

export { startProxy };

// model gateway for sandboxed systems. the sandbox only ever sees the proxy
// url and a per-run bearer token: never the upstream url, the real api key, or
// anything else. the proxy does server-side accounting (tokens/calls are truth
// recorded here, not self-reported) and enforces per-run call limits.
// TODO when harnesses need other services (statute dbs, rag), add per-harness
// allowlisted routes here instead of opening the sandbox network.
async function startProxy(opts: {
  upstreamUrl: string; // e.g. http://host:11434/v1
  upstreamKey: string;
  defaultTemperature: number; // injected when a request does not set one
  timeoutMs: number;
  maxCalls: number; // per registered run
}): Promise<ModelProxy> {
  let runs = new Map<string, { runId: string; usage: Usage }>();

  let server = createServer((req, res) => {
    handle(req, res).catch((err) => reply(res, 502, `proxy: ${String(err?.message ?? err)}`));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    let state = runs.get(token);
    if (!state) return reply(res, 401, 'unknown run token');
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      return reply(res, 404, 'only POST /v1/chat/completions is allowed');
    }
    if (state.usage.modelCalls >= opts.maxCalls) {
      return reply(res, 429, `run ${state.runId} exceeded the limit of ${opts.maxCalls} model calls`);
    }
    state.usage.modelCalls++;

    // benchmark defaults are enforced here, not trusted to the sandbox
    let body = JSON.parse(await readBody(req));
    body.temperature ??= opts.defaultTemperature;

    let upstream = await fetch(`${opts.upstreamUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.upstreamKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    let text = await upstream.text();
    try {
      let usage = JSON.parse(text).usage;
      state.usage.tokensIn += usage?.prompt_tokens ?? 0;
      state.usage.tokensOut += usage?.completion_tokens ?? 0;
    } catch {}
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text);
  }

  // 0.0.0.0 so docker containers can reach it via host.docker.internal;
  // every request still needs a registered run token
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  let { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    register(runId) {
      let token = randomBytes(16).toString('hex');
      runs.set(token, { runId, usage: { modelCalls: 0, tokensIn: 0, tokensOut: 0 } });
      return token;
    },
    usage(token) {
      let state = runs.get(token);
      return state ? { ...state.usage } : { modelCalls: 0, tokensIn: 0, tokensOut: 0 };
    },
    close() {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

// internal helpers

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
