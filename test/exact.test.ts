import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { exactGrader, extractChoice, normalize } from '../src/graders/exact.js';
import type { PublicCase, PrivateCase, RunResult } from '../src/types.js';

describe('exactGrader', () => {
  let pub = { id: 'c1', choices: ['Yes', 'No'] } as PublicCase;
  let priv: PrivateCase = { id: 'c1', grader: 'exact', answer: 'Yes' };

  function result(output: string, error?: string): RunResult {
    return {
      caseId: 'c1', system: 's', repetition: 1, output, error,
      latencyMs: 0, modelCalls: 1, tokensIn: 0, tokensOut: 0,
    };
  }

  describe('normalize', () => {
    it('should trim, lowercase, and strip wrapping punctuation', () => {
      assert.equal(normalize('  Yes. '), 'yes');
      assert.equal(normalize('"No"'), 'no');
      assert.equal(normalize('**suggestive**'), 'suggestive');
    });
  });

  describe('extractChoice', () => {
    it('should match a bare label', () => {
      assert.equal(extractChoice('Yes', ['Yes', 'No']), 'yes');
    });

    it('should find a unique label in chatty output', () => {
      assert.equal(extractChoice('The answer is: fanciful, because it is invented.', ['generic', 'fanciful']), 'fanciful');
    });

    it('should prefer a bare label on the first line over labels in the explanation', () => {
      let out = 'descriptive\n\n"Coppertone" describes the tan, not merely suggestive or arbitrary.';
      assert.equal(extractChoice(out, ['descriptive', 'suggestive', 'arbitrary']), 'descriptive');
    });

    it('should reject output that mentions several labels', () => {
      assert.equal(extractChoice('Could be Yes or No.', ['Yes', 'No']), undefined);
    });

    it('should reject output with no label', () => {
      assert.equal(extractChoice('I am not sure.', ['Yes', 'No']), undefined);
    });
  });

  it('should pass on exact answer and fail on wrong answer', () => {
    let grader = exactGrader();
    assert.equal(grader.grade(pub, priv, result('Yes.')).pass, true);
    assert.equal(grader.grade(pub, priv, result('No')).pass, false);
  });

  it('should accept aliases', () => {
    let grader = exactGrader();
    let withAlias: PrivateCase = { ...priv, aliases: ['correct'] };
    assert.equal(grader.grade(pub, withAlias, result('correct')).pass, true);
  });

  it('should fail an errored run', () => {
    let grader = exactGrader();
    let g = grader.grade(pub, priv, result('', 'timeout'));
    assert.equal(g.pass, false);
    assert.match(g.detail ?? '', /timeout/);
  });
});
