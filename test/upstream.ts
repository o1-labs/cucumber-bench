import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startProxy } from '../src/proxy.js';
import type { ModelProxy } from '../src/types.js';

export { mockUpstream, tsx, models, type Mock };

type Mock = { proxy: ModelProxy; seen: any[]; close: () => Promise<void> };

let models = { main: 'test-model', safety: 'safety-model' };

// typescript entries run under tsx in process mode, as the cli does
function tsx(entry: string) {
  return [process.execPath, 'node_modules/tsx/dist/cli.mjs', entry];
}

// a mock upstream behind a real proxy: records request bodies; answers the
// pii-detection prompt with a json list of names, the citation check with a
// passage set, an answer prompt with a two-sentence answer, everything else with "Yes"
async function mockUpstream(): Promise<Mock> {
  let seen: any[] = [];
  let upstream: Server = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      let prompt = (body.messages ?? []).map((m: any) => m.content).join('\n');
      // every harness prompt ends with a label line (what the model writes next); the answer
      // depends on the label, and on the data part of the prompt, never on its instructions
      let label = prompt.trimEnd().split('\n').pop() ?? '';
      let quote = prompt.match(/Document \[2\]\(Title: .*?\): ((?:\S+ ){7}\S+)/)?.[1];
      let finding = prompt.match(/^\[2\] (".*")$/m)?.[1];
      let content =
        label === 'JSON array:' ? '["Heder", "Sanavi"]'
        // review-v1 scan: the first eight words of passage 2, when the batch has it
        : label === 'Quotes:' ? (quote ? `[2] "${quote}"` : 'none')
        // review-v1 compose: quote the first finding, or the negative form
        : label === 'Answer from the findings:' ? (finding ? `Yes. The contract contains the clause: ${finding} [2].` : 'The contract contains no such clause.')
        : label === 'Supported (yes or no):' ? (prompt.includes('Claim: The contract contains the clause') ? '**Yes**' : 'no')
        : label === 'About the documents (keep or no):' ? (prompt.includes('Sentence: The contract contains no') ? 'keep' : 'no')
        // cite-v1 check
        : label === 'Passages:' ? (prompt.includes('Claim: Alpha') ? '[2][7]' : prompt.includes('Claim: The documents') ? 'keep' : 'none')
        // the few-shot answer of direct and cite-v1
        : label === 'Answer:' ? 'Alpha holds the record [1][2][3]. Beta is unsupported [4]. The documents do not say who holds the gamma record.'
        : 'Yes';
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.001 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  let { port } = upstream.address() as AddressInfo;
  let proxy = await startProxy({
    upstreamUrl: `http://127.0.0.1:${port}/v1`,
    upstreamKey: 'real-key',
    defaultTemperature: 0.3,
    timeoutMs: 5000,
    maxCalls: 4,
    maxJudgeCalls: 5,
  });
  return {
    proxy,
    seen,
    async close() {
      await proxy.close();
      await new Promise((r) => upstream.close(r));
    },
  };
}
