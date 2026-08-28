// self-contained sandbox entry: the placeholder two-step harness.
// deliberately dependency-free plain js so the docker image is just node + this file.
// protocol: stdin {publicCase, proxyUrl, token, model} -> stdout {output} | {error}

let chunks = [];
for await (let c of process.stdin) chunks.push(c);
let { publicCase: c, proxyUrl, token, model } = JSON.parse(Buffer.concat(chunks).toString());

async function generate(prompt, temperature) {
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
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

try {
  // step 1: free-form analysis at benchmark-default settings (proxy injects them)
  let analysis = await generate(
    `${c.instructions}\n\nCase: ${c.input}\n\nQuestion: ${c.question}\n` +
      `Analyze the case step by step in at most 5 short sentences. Do not state a final answer yet.`,
  );
  // step 2: commit to one label, always greedy
  let decision = await generate(
    `${c.instructions}\n\nCase: ${c.input}\n\nQuestion: ${c.question}\n` +
      `Analysis:\n${analysis}\n\n` +
      `Based on this analysis, answer with exactly one of: ${c.choices.join(', ')}. Reply with the label only.`,
    0,
  );
  process.stdout.write(JSON.stringify({ output: decision }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }));
}
