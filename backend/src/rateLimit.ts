/**
 * Small token-bucket helpers used to throttle connections, room operations
 * and signaling traffic. All state is in-memory and per-process.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    nowMs: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  /** Attempts to spend `cost` tokens. Returns true when allowed. */
  tryConsume(nowMs: number, cost = 1): boolean {
    const elapsedSeconds = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = nowMs;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

interface BucketEntry {
  bucket: TokenBucket;
  lastSeenMs: number;
}

/**
 * Maintains one token bucket per key (usually a client IP) with periodic
 * eviction of idle entries so the map cannot grow without bound.
 */
export class KeyedRateLimiter {
  private readonly entries = new Map<string, BucketEntry>();
  private lastSweepMs: number;

  constructor(
    private readonly capacityPerMinute: number,
    private readonly idleEvictMs = 10 * 60 * 1000,
    private readonly maxEntries = 10000,
  ) {
    this.lastSweepMs = Date.now();
  }

  /** Returns true when the key is allowed to perform one action now. */
  allow(key: string, nowMs: number = Date.now()): boolean {
    this.maybeSweep(nowMs);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.capacityPerMinute, this.capacityPerMinute / 60, nowMs), lastSeenMs: nowMs };
      this.entries.set(key, entry);
    }
    entry.lastSeenMs = nowMs;
    return entry.bucket.tryConsume(nowMs);
  }

  get size(): number {
    return this.entries.size;
  }

  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < this.idleEvictMs) return;
    this.lastSweepMs = nowMs;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastSeenMs > this.idleEvictMs) {
        this.entries.delete(key);
      }
    }
    // Hard cap as a last resort against memory exhaustion.
    if (this.entries.size > this.maxEntries) {
      const excess = this.entries.size - this.maxEntries;
      let removed = 0;
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }
}
