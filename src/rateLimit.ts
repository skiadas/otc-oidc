/**
 * Sliding-window rate limiter, in memory per process.
 *
 * Each key keeps the timestamps of the requests that fell inside the current
 * window; a request is allowed when fewer than `maxRequests` timestamps remain
 * in the window, and rejected otherwise. The window slides because stale
 * timestamps are pruned on every access (and by {@link sweep}), so a quiet
 * period lets the bucket refill.
 */
export class RateLimiter {
  readonly windowMs: number;
  private readonly maxRequests: number;
  private buckets = new Map<string, number[]>();

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  check(key: string): boolean {
    const { buckets, maxRequests, windowMs } = this;
    const now = Date.now();
    const cutoff = now - windowMs;
    const recentRequests = (buckets.get(key) ?? []).filter((t) => t > cutoff);

    buckets.set(key, recentRequests);
    const allowed = recentRequests.length < maxRequests;
    if (allowed) recentRequests.push(now);

    return allowed;
  }

  /** Drop keys whose window has fully emptied, so idle buckets stop growing. */
  sweep(): void {
    const { buckets, windowMs } = this;
    const now = Date.now();
    const cutoff = now - windowMs;
    for (const [key, requests] of buckets) {
      buckets.set(
        key,
        requests.filter((t) => t > cutoff),
      );
    }

    for (const [key, requests] of buckets) if (requests.length === 0) buckets.delete(key);
  }
}
