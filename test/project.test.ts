import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadProject } from '../src/project.js';

describe('loadProject system selection', () => {
  let originalToken = process.env.HF_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = originalToken;
  });

  it('should not require credentials belonging only to an unselected harness', async () => {
    delete process.env.HF_TOKEN;

    let project = await loadProject({ systemNames: ['review-v1', 'review-bm25-v1'] });

    assert.deepEqual([...project.systems.keys()], ['review-v1', 'review-bm25-v1']);
    assert.ok('direct-4b' in project.help.systems);
  });

  it('should still fail fast when a selected harness is missing its credential', async () => {
    delete process.env.HF_TOKEN;

    await assert.rejects(
      loadProject({ systemNames: ['direct-4b'] }),
      /harness direct-4b: the provider key env variable HF_TOKEN is not set/,
    );
  });
});
