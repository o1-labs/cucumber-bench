import assert from 'node:assert/strict';
import type { ModelProxy } from './types.js';

export { judgeVia };

// at most this many judge calls in flight across the whole run; hosted judges
// slow down and time out when every parallel case fires ten questions at once.
// 64: a judge call takes 2-11 s and ten parallel cases fire about 40 at once
const MAX_IN_FLIGHT = 64;
let inFlight = 0;
let waiting: (() => void)[] = [];

// a judge(prompt) for graders: greedy calls to the judge model through the proxy's
// /judge route, on the run's judge token, so grading cost is counted apart from the
// harness. retries timeouts, rate limits, and upstream errors with backoff.
function judgeVia(proxy: ModelProxy, token: string, model: string, opts: { retries?: number; backoffMs?: number } = {}) {
  let { retries = 3, backoffMs = 2000 } = opts;
  return async function judge(prompt: string): Promise<string> {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        let res = await fetch(`${proxy.url}/judge/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
        });
        let raw = await res.text();
        if (res.ok) {
          let text: string = JSON.parse(raw).choices?.[0]?.message?.content ?? '';
          return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        }
        // 429 and 5xx (the proxy reports upstream timeouts as 502) are worth a retry
        let retryable = res.status === 429 || res.status >= 500;
        assert(retryable && attempt < retries, `judge call failed: ${res.status} ${raw}`);
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
      }
    } finally {
      release();
    }
  };
}

// internal helpers

function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(() => { inFlight++; resolve(); }));
}

function release() {
  inFlight--;
  waiting.shift()?.();
}
