export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  public take(key: string, limit: number, now = Date.now()): RateLimitResult {
    const safeLimit = Math.max(1, Math.floor(limit));
    const cutoff = now - 60_000;
    const recent = (this.buckets.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= safeLimit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
      this.buckets.set(key, recent);
      return { allowed: false, limit: safeLimit, remaining: 0, retryAfterSeconds };
    }
    recent.push(now);
    this.buckets.set(key, recent);
    return {
      allowed: true,
      limit: safeLimit,
      remaining: Math.max(0, safeLimit - recent.length),
      retryAfterSeconds: 0,
    };
  }

  public reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}

export const proxyRateLimiter = new SlidingWindowRateLimiter();
