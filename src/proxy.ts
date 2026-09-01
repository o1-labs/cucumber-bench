import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ModelProxy, Usage } from './types.js';

export { startProxy };

// model gateway for sandboxed systems. the sandbox only ever sees the proxy
// url and a per-run bearer token: never the upstream url, the real api key, or
// anything else. the proxy does server-side accounting (tokens/calls are truth
// recorded here, not self-reported) and enforces per-run call limits.
// three routes: /v1 is the guarded model, whose prompts are the leakage ground
// truth; /safety/v1 is the trusted safety model a harness may show raw data to;
// /judge/v1 is the judge model that graders use, never a harness. the caller
// names the model on every route; the proxy only records it and routes to a provider.
// TODO when harnesses need other services (statute dbs, rag), add per-harness
// allowlisted routes here instead of opening the sandbox network.
async function startProxy(opts: {
  upstreamUrl: string; // e.g. http://host:11434/v1
  upstreamKey: string;
  judgeUpstreamUrl?: string; // the judge may live on another provider; default: upstreamUrl
  judgeUpstreamKey?: string;
  defaultTemperature: number; // injected when a request does not set one
  timeoutMs: number;
  maxCalls: number; // per registered run, on the guarded and safety routes; a run may register its own
  maxJudgeCalls: number; // per registered run on the judge route; citation graders ask many questions
}): Promise<ModelProxy> {
  let runs = new Map<
    string,
    { runId: string; usage: Usage; requests: string[]; judge: boolean; models?: string[]; maxCalls?: number; upstream?: { url: string; key: string } }
  >();
  let empty = (): Usage => ({ modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] });

  let server = createServer((req, res) => {
    handle(req, res).catch((err) => reply(res, 502, `proxy: ${String(err?.message ?? err)}`));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    let state = runs.get(token);
    if (!state) return reply(res, 401, 'unknown run token');
    let route = req.method === 'POST' ? ROUTES[req.url ?? ''] : undefined;
    if (!route) return reply(res, 404, 'only POST {,/safety,/judge}/v1/chat/completions is allowed');
    // a token reaches its own routes only: the judge route is for graders, the others for harnesses
    if ((route === 'judge') !== state.judge) return reply(res, 403, `run ${state.runId}: this token cannot use the ${route} route`);
    let limit = route === 'judge' ? opts.maxJudgeCalls : state.maxCalls ?? opts.maxCalls;
    if (state.usage.modelCalls >= limit) {
      return reply(res, 429, `run ${state.runId} exceeded the limit of ${limit} model calls`);
    }

    // benchmark defaults are enforced here, not trusted to the sandbox
    let body = JSON.parse(await readBody(req));
    if (state.models && !state.models.includes(body.model)) {
      return reply(res, 403, `run ${state.runId}: model ${JSON.stringify(body.model)} is not one this run declared (${state.models.join(', ')})`);
    }
    state.usage.modelCalls++;
    body.temperature ??= opts.defaultTemperature;
    if (typeof body.model === 'string' && !state.usage.models.includes(body.model)) state.usage.models.push(body.model);
    // ground truth for leakage grading: what actually reached the guarded model
    if (route === 'guarded') {
      state.requests.push(
        (body.messages ?? [])
          .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n'),
      );
    }

    // a run may bring its own upstream (a harness with a named provider); the judge route never does
    let url = route === 'judge' ? (opts.judgeUpstreamUrl ?? opts.upstreamUrl) : (state.upstream?.url ?? opts.upstreamUrl);
    let key = route === 'judge' ? (opts.judgeUpstreamKey ?? opts.upstreamKey) : (state.upstream?.key ?? opts.upstreamKey);
    let upstream = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    let text = await upstream.text();
    try {
      let usage = JSON.parse(text).usage;
      state.usage.tokensIn += usage?.prompt_tokens ?? 0;
      state.usage.tokensOut += usage?.completion_tokens ?? 0;
      // openrouter reports the charge in usd credits; other providers report nothing
      state.usage.costUsd += Number(usage?.cost ?? 0);
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
    register(runId, o) {
      let token = randomBytes(16).toString('hex');
      runs.set(token, { runId, usage: empty(), requests: [], judge: o?.judge ?? false, models: o?.models, maxCalls: o?.maxCalls, upstream: o?.upstream });
      return token;
    },
    usage(token) {
      let state = runs.get(token);
      return state ? { ...state.usage, models: [...state.usage.models] } : empty();
    },
    requests(token) {
      return [...(runs.get(token)?.requests ?? [])];
    },
    close() {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

// internal helpers

const ROUTES: { [path: string]: 'guarded' | 'safety' | 'judge' } = {
  '/v1/chat/completions': 'guarded',
  '/safety/v1/chat/completions': 'safety',
  '/judge/v1/chat/completions': 'judge',
};

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
