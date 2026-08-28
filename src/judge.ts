import assert from 'node:assert/strict';
import type { ModelProxy } from './types.js';

export { judgeVia };

// a judge(prompt) for graders: greedy calls to the judge model through the proxy's
// /judge route, on the run's judge token, so grading cost is counted apart from the harness
function judgeVia(proxy: ModelProxy, token: string, model: string) {
  return async function judge(prompt: string): Promise<string> {
    let res = await fetch(`${proxy.url}/judge/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    });
    let raw = await res.text();
    assert(res.ok, `judge call failed: ${res.status} ${raw}`);
    let text: string = JSON.parse(raw).choices?.[0]?.message?.content ?? '';
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };
}
