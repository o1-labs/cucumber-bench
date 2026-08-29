import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadCases } from '../src/caseStore.js';
import { runSuite } from '../src/runner.js';
import { exactGrader } from '../src/graders/exact.js';
import { leakageGrader, removalGrader, retentionGrader } from '../benchmarks/redaction/graders.js';
import type { ModelProxy, SystemUnderTest } from '../src/types.js';

// the runner uses the proxy only for the graders' judge token; nothing calls it here
let proxy: ModelProxy = {
  url: 'http://127.0.0.1:1',
  register: () => 'judge-token',
  usage: () => ({ modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] }),
  requests: () => [],
  close: async () => {},
};

// fake system: fixed output, echoes the raw input as what it sent to the model
function fakeSystem(output: string): SystemUnderTest {
  return {
    name: 'fake',
    models: { main: 'm', safety: 'm' },
    async run(c, ctx) {
      return {
        caseId: c.id, system: 'fake', repetition: ctx.repetition, output,
        modelRequests: [c.input], modelCalls: 1, tokensIn: 10, tokensOut: 2, costUsd: 0, models: [],
      };
    },
  };
}

describe('runSuite', () => {
  it('should run the legalbench cases, grade every run, and measure latency', async () => {
    let cases = await loadCases('benchmarks/legalbench');
    assert.equal(cases.length, 9);

    let records = await runSuite({
      runId: 'test', cases, systems: [fakeSystem('Yes')], graders: [exactGrader()], proxy, judgeFor: () => 'j', repetitions: 1, concurrency: 4,
    });

    assert.equal(records.length, 9);
    // concurrent runs still land in case order
    assert.deepEqual(records.map((r) => r.run.caseId), cases.map((c) => c.pub.id));
    assert.deepEqual(records[0].judge, { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, models: [] });
    // fake answers "Yes"; exactly the two Yes-labeled cases pass
    assert.equal(records.filter((r) => r.grades[0].pass).length, 2);
    for (let { run, grades } of records) {
      assert.equal(run.modelCalls, 1);
      assert.ok(run.latencyMs >= 0);
      assert.equal(grades.length, 1);
    }
  });

  it('should grade redaction cases with all three graders; sending the raw input leaks everything', async () => {
    let cases = await loadCases('benchmarks/redaction');
    let records = await runSuite({
      runId: 'test', cases, systems: [fakeSystem('[REDACTED]')],
      graders: [removalGrader(), leakageGrader(), retentionGrader()], proxy, judgeFor: () => 'j', repetitions: 1,
    });
    assert.equal(records.length, cases.length);
    for (let { grades } of records) {
      assert.deepEqual(grades.map((g) => g.grader), ['removal', 'leakage', 'retention']);
      assert.equal(grades[0].pass, true); // nothing survived in "[REDACTED]"
      assert.equal(grades[1].score, 0); // but every protected span reached the model
      assert.equal(grades[2].pass, false); // and nothing useful survived either
    }
  });

  it('should run repetitions of one case in parallel under concurrency', async () => {
    let cases = (await loadCases('benchmarks/legalbench')).slice(0, 1);
    let slow: SystemUnderTest = {
      ...fakeSystem('Yes'),
      async run(c, ctx) {
        await new Promise((r) => setTimeout(r, 60));
        return fakeSystem('Yes').run(c, ctx);
      },
    };
    let t0 = Date.now();
    let records = await runSuite({
      runId: 'test', cases, systems: [slow], graders: [exactGrader()], proxy, judgeFor: () => 'j', repetitions: 4, concurrency: 4,
    });
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((r) => r.run.repetition), [1, 2, 3, 4]);
    assert.ok(Date.now() - t0 < 4 * 60, 'four repetitions took as long as one');
  });

  it('should run two systems in one pool, records still in (system, repetition, case) order', async () => {
    let cases = (await loadCases('benchmarks/legalbench')).slice(0, 2);
    let slow = (name: string): SystemUnderTest => ({
      ...fakeSystem('Yes'),
      name,
      async run(c, ctx) {
        await new Promise((r) => setTimeout(r, 60));
        return { ...(await fakeSystem('Yes').run(c, ctx)), system: name };
      },
    });
    let t0 = Date.now();
    let records = await runSuite({
      runId: 'test', cases, systems: [slow('a'), slow('b')], graders: [exactGrader()], proxy, judgeFor: () => 'j', repetitions: 1, concurrency: 4,
    });
    assert.deepEqual(records.map((r) => `${r.run.system}/${r.run.caseId}`), [
      `a/${cases[0].pub.id}`, `a/${cases[1].pub.id}`, `b/${cases[0].pub.id}`, `b/${cases[1].pub.id}`,
    ]);
    assert.ok(Date.now() - t0 < 2 * 60, 'the second system waited for the first');
  });

  it('should record a failed grade, not crash, when a grader throws', async () => {
    let cases = (await loadCases('benchmarks/legalbench')).slice(0, 2);
    let broken = { name: 'exact', description: 'x', async grade() { throw Error('judge down'); } };
    let records = await runSuite({
      runId: 'test', cases, systems: [fakeSystem('Yes')], graders: [broken], proxy, judgeFor: () => 'j', repetitions: 1,
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].grades[0].pass, false);
    assert.match(records[0].grades[0].detail ?? '', /grader error: judge down/);
  });

  it('should record a failing grade when a system throws', async () => {
    let cases = (await loadCases('benchmarks/legalbench')).slice(0, 1);
    let broken: SystemUnderTest = {
      name: 'broken',
      models: { main: 'm', safety: 'm' },
      async run() {
        throw Error('boom');
      },
    };
    let records = await runSuite({
      runId: 'test', cases, systems: [broken], graders: [exactGrader()], proxy, judgeFor: () => 'j', repetitions: 1,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].grades[0].pass, false);
    assert.match(records[0].run.error ?? '', /boom/);
  });
});
