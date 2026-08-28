// shared plumbing for dependency-free harnesses: protocol io and the proxy client.
// no runtime imports, so the base image is node + tsx + this directory.
// protocol: stdin {publicCase, proxyUrl, token, model} -> stdout {output, trace?} | {error}
import type { PublicCase, Trace } from '../src/types.js';

export { readInput, generateVia, respond, type Input, type Generate };

type Input = { publicCase: PublicCase; proxyUrl: string; token: string; model: string };
type Generate = (prompt: string, temperature?: number) => Promise<string>;

async function readInput(): Promise<Input> {
  let chunks: Buffer[] = [];
  for await (let c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// a generate(prompt, temperature?) bound to this run's proxy route and token.
// temperature left undefined means the benchmark default, injected by the proxy.
// route '/v1' is the guarded model, '/safety/v1' the trusted safety model.
function generateVia(proxyUrl: string, token: string, model: string, route = '/v1'): Generate {
  return async function generate(prompt, temperature) {
    let res = await fetch(`${proxyUrl}${route}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(temperature !== undefined ? { temperature } : {}),
      }),
    });
    if (!res.ok) throw Error(`model call failed: ${res.status} ${await res.text()}`);
    let data: any = await res.json();
    let text: string = data.choices?.[0]?.message?.content ?? '';
    // qwen3 and other reasoning models may emit <think>...</think> before the answer
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };
}

function respond(obj: { output: string; trace?: Trace } | { error: string }) {
  process.stdout.write(JSON.stringify(obj));
}
