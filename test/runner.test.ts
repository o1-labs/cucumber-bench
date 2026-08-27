import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadCases } from '../src/caseStore.js';
import { runSuite } from '../src/runner.js';
import { directSystem } from '../src/systems/direct.js';
import { harnessSystem } from '../src/systems/harness.js';
import { exactGrader } from '../src/graders/exact.js';
import type { ModelClient } from '../src/types.js';

// stub model that always answers "Yes" (or the first choice it is offered)
function stubModel(answer: string): ModelClient {
  return {
    model: 'stub',
    async generate() {
      return { text: answer, usage: { modelCalls: 1, tokensIn: 10, tokensOut: 2 } };
    },
  };
}

describe('runSuite', () => {
  it('should run both systems over the real case files and grade every run', async () => {
    let cases = await loadCases('cases');
    assert.equal(cases.length, 9);

    let { records } = await runSuite({
      runId: 'test',
      cases,
      systems: [directSystem(), harnessSystem()],
      graders: [exactGrader()],
      model: stubModel('Yes'),
      repetitions: 1,
    });

    // 9 cases x 2 systems
    assert.equal(records.length, 18);
    // stub answers "Yes"; exactly the two Yes-labeled cases pass per system
    let passes = records.filter((r) => r.grade.pass);
    assert.equal(passes.length, 4);
    // harness makes two model calls, direct makes one
    for (let { run } of records) {
      assert.equal(run.modelCalls, run.system === 'harness' ? 2 : 1);
    }
  });

  it('should record a failing grade when a system throws', async () => {
    let cases = (await loadCases('cases')).slice(0, 1);
    let broken: ModelClient = {
      model: 'broken',
      async generate() {
        throw Error('boom');
      },
    };
    let { records } = await runSuite({
      runId: 'test',
      cases,
      systems: [directSystem()],
      graders: [exactGrader()],
      model: broken,
      repetitions: 1,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].grade.pass, false);
    assert.match(records[0].run.error ?? '', /boom/);
  });
});
