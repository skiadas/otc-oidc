import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rateLimit.js';

describe('RateLimiter', () => {
  it('allows requests up to the maximum within the window', () => {
    const limiter = new RateLimiter(60_000, 3);
    assert.equal(limiter.check('a'), true);
    assert.equal(limiter.check('a'), true);
    assert.equal(limiter.check('a'), true);
    assert.equal(limiter.check('a'), false);
  });

  it('tracks distinct keys independently', () => {
    const limiter = new RateLimiter(60_000, 2);
    assert.equal(limiter.check('a'), true);
    assert.equal(limiter.check('a'), true);
    assert.equal(limiter.check('a'), false);
    assert.equal(limiter.check('b'), true);
  });

  it('resets after the window passes', () => {
    const limiter = new RateLimiter(5, 1);
    assert.equal(limiter.check('a'), true);
    assert.equal(limiter.check('a'), false);
    const now = Date.now();
    const timestamps = [now - 100];
    (limiter as unknown as { buckets: Map<string, number[]> }).buckets.set('a', timestamps);
    assert.equal(limiter.check('a'), true);
  });

  it('sweep clears idle keys', () => {
    const limiter = new RateLimiter(1, 10);
    limiter.check('a');
    const buckets = (limiter as unknown as { buckets: Map<string, number[]> }).buckets;
    assert.equal(buckets.has('a'), true);
    const stale = Date.now() - 1000;
    buckets.set('a', [stale]);
    limiter.sweep();
    assert.equal(buckets.has('a'), false);
  });
});
