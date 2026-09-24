// Shared wire and model adapter for both review lanes. The benchmark comparison therefore
// changes passage selection, not the model client or request shape.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type { Generate, ReviewCase } from './core.js';

type ReviewInput = {
  publicCase: ReviewCase;
  proxyUrl: string;
  token: string;
  models: { main: string };
};

export { generateFor, readInput, respond };

function generateFor(proxyUrl: string, token: string, modelName: string): Generate {
  let model = createOpenAICompatible({
    name: 'guarded',
    baseURL: `${proxyUrl}/v1`,
    apiKey: token,
  })(modelName);
  return async (prompt, temperature) => {
    let { text } = await generateText({ model, prompt, temperature });
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };
}

async function readInput(): Promise<ReviewInput> {
  let chunks: Buffer[] = [];
  for await (let chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function respond(value: unknown) {
  process.stdout.write(JSON.stringify(value));
}
