import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { minutesFromSeconds } from '../src/duration.js';

describe('minutesFromSeconds', () => {
  it('converts seconds to whole minutes', () => {
    assert.equal(minutesFromSeconds(300), 5);
    assert.equal(minutesFromSeconds(150), 3);
    assert.equal(minutesFromSeconds(60), 1);
  });

  it('never reports zero minutes', () => {
    assert.equal(minutesFromSeconds(30), 1);
    assert.equal(minutesFromSeconds(1), 1);
  });
});
