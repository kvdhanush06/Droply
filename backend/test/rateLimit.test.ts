import { describe, expect, it } from 'vitest';
import { KeyedRateLimiter, TokenBucket } from '../src/rateLimit.js';

describe('TokenBucket', () => {
  it('allows bursts up to capacity then throttles', () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(false);
  });

  it('refills over time', () => {
    const bucket = new TokenBucket(2, 2, 0); // 2 tokens/second
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(500)).toBe(true); // 1 token refilled
    expect(bucket.tryConsume(500)).toBe(false);
    expect(bucket.tryConsume(1500)).toBe(true); // 2 more tokens refilled
  });

  it('never exceeds capacity when idle', () => {
    const bucket = new TokenBucket(2, 10, 0);
    expect(bucket.tryConsume(60_000)).toBe(true);
    expect(bucket.tryConsume(60_000)).toBe(true);
    expect(bucket.tryConsume(60_000)).toBe(false); // capped at capacity 2
  });
});

describe('KeyedRateLimiter', () => {
  it('limits each key independently', () => {
    const limiter = new KeyedRateLimiter(2);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('evicts idle entries so memory stays bounded', () => {
    const limiter = new KeyedRateLimiter(10, 1000);
    limiter.allow('stale', 0);
    limiter.allow('fresh', 5000);
    // Trigger a sweep well past the idle window.
    limiter.allow('another', 60_000);
    expect(limiter.size).toBeLessThan(4);
  });
});
