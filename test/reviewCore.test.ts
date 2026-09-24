import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { reviewSelected } from '../harnesses/review-v1/src/core.js';

describe('shared review pipeline', () => {
  it('scans every remaining passage before composing an absence from an empty retrieval scan', async () => {
    let docs = Array.from({ length: 6 }, (_, index) => ({
      title: `part ${index + 1}`,
      text: index === 1
        ? 'The supplier may terminate the agreement after material breach.'
        : `Unrelated filler passage ${index + 1}.`,
    }));
    let prompts: string[] = [];
    let generate = async (prompt: string) => {
      prompts.push(prompt);
      let label = prompt.trimEnd().split('\n').at(-1);
      if (label === 'Quotes:') {
        return prompt.includes('Document [2]')
          ? '[2] "The supplier may terminate the agreement after material"'
          : 'none';
      }
      if (label === 'Answer from the findings:') {
        return 'The contract contains the clause: "The supplier may terminate the agreement after material" [2].';
      }
      throw Error(`unexpected prompt: ${label}`);
    };

    let result = await reviewSelected(
      {
        input: 'Question: Does the contract contain a termination clause?\n\nDocument [1]: omitted',
        instructions: 'Quote and cite the relevant clause.',
        docs,
        examples: [],
      },
      generate,
      {
        passageIndexes: [0],
        finding: 'selected one passage',
        metadata: { retrieval: { policy: 'test-policy', selectedPassageIds: [1] } },
      },
    );

    assert.equal(prompts.length, 3);
    assert.ok(prompts[2].includes('after reading every passage'));
    assert.equal(result.output, 'The contract contains the clause: "The supplier may terminate the agreement after material" [2].');
    assert.deepEqual(result.trace.stages[1].findings, [
      'selected one passage',
      'scanned 1 retrieved passages in 1 calls: 0 quote(s) from no passage',
      'retrieval produced no verified quote; scanned all 5 remaining passages before composing',
      'scanned 5 fallback passages in 1 calls: 1 quote(s) from [2]',
    ]);
    assert.deepEqual(result.trace.stages[1].metadata, {
      retrieval: { policy: 'test-policy', selectedPassageIds: [1] },
    });
  });
});
