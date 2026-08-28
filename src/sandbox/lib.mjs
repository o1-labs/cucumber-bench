// shared plumbing for sandbox entries: protocol io and the proxy client.
// plain js with no dependencies, so the image is node + this directory.
// protocol: stdin {publicCase, proxyUrl, token, model} -> stdout {output, trace?} | {error}
export { readInput, generateVia, respond };

async function readInput() {
  let chunks = [];
  for await (let c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// a generate(prompt, temperature?) bound to this run's proxy and token.
// temperature left undefined means the benchmark default, injected by the proxy.
function generateVia(proxyUrl, token, model) {
  return async function generate(prompt, temperature) {
    let res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(temperature !== undefined ? { temperature } : {}),
      }),
    });
    if (!res.ok) throw Error(`model call failed: ${res.status} ${await res.text()}`);
    let data = await res.json();
    let text = data.choices?.[0]?.message?.content ?? '';
    // qwen3 and other reasoning models may emit <think>...</think> before the answer
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
}
