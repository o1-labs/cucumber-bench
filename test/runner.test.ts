import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadCases } from '../src/caseStore.js';
import { runSuite } from '../src/runner.js';
import { exactGrader } from '../src/graders/exact.js';
import { leakageGrader, removalGrader, retentionGrader } from '../src/graders/redaction.js';
import type { ModelProxy, SystemUnderTest } from '../src/types.js';

// the runner never talks to the proxy itself; systems do
let proxy = {} as ModelProxy;

// fake system: fixed output, echoes the raw input as what it sent to the model
function fakeSystem(output: string): SystemUnderTest {
  return {
    name: 'fake',
    async run(c, ctx) {
      return {
        caseId: c.id, system: 'fake', repetition: ctx.repetition, output,
        modelRequests: [c.input], modelCalls: 1, tokensIn: 10, tokensOut: 2,
      };
    },
  };
}

describe('runSuite', () => {
  it('should run the legalbench cases, grade every run, and measure latency', async () => {
    let cases = await loadCases('cases/legalbench');
    assert.equal(cases.length, 9);

    let records = await runSuite({
      runId: 'test', cases, systems: [fakeSystem('Yes')], graders: [exactGrader()], model: 'm', proxy, repetitions: 1,
    });

    assert.equal(records.length, 9);
    // fake answers "Yes"; exactly the two Yes-labeled cases pass
    assert.equal(records.filter((r) => r.grades[0].pass).length, 2);
    for (let { run, grades } of records) {
      assert.equal(run.modelCalls, 1);
      assert.ok(run.latencyMs >= 0);
      assert.equal(grades.length, 1);
    }
  });

  it('should grade redaction cases with all three graders; sending the raw input leaks everything', async () => {
    let cases = await loadCases('cases/redaction');
    let records = await runSuite({
      runId: 'test', cases, systems: [fakeSystem('[REDACTED]')],
      graders: [removalGrader(), leakageGrader(), retentionGrader()], model: 'm', proxy, repetitions: 1,
    });
    assert.equal(records.length, cases.length);
    for (let { grades } of records) {
      assert.deepEqual(grades.map((g) => g.grader), ['removal', 'leakage', 'retention']);
      assert.equal(grades[0].pass, true); // nothing survived in "[REDACTED]"
      assert.equal(grades[1].score, 0); // but every protected span reached the model
      assert.equal(grades[2].pass, false); // and nothing useful survived either
    }
  });

  it('should record a failing grade when a system throws', async () => {
    let cases = (await loadCases('cases/legalbench')).slice(0, 1);
    let broken: SystemUnderTest = {
      name: 'broken',
      async run() {
        throw Error('boom');
      },
    };
    let records = await runSuite({
      runId: 'test', cases, systems: [broken], graders: [exactGrader()], model: 'm', proxy, repetitions: 1,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].grades[0].pass, false);
    assert.match(records[0].run.error ?? '', /boom/);
  });
});
