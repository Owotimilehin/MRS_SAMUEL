import type { Context, MiddlewareHandler } from "hono";
import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { BusinessError } from "../lib/errors.js";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL required for rate limiting");
  redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redis.on("error", () => {
    // Swallow connection errors; the limiter will fail open below.
  });
  return redis;
}

interface RateLimitOpts {
  points: number;
  durationSeconds: number;
  keyPrefix: string;
  keyFn?: (c: Context) => string;
}

export function rateLimit(opts: RateLimitOpts): MiddlewareHandler {
  let limiter: RateLimiterRedis | null = null;
  return async (c, next) => {
    if (!limiter) {
      try {
        limiter = new RateLimiterRedis({
          storeClient: getRedis(),
          keyPrefix: opts.keyPrefix,
          points: opts.points,
          duration: opts.durationSeconds,
        });
      } catch {
        // Fail open if Redis is unreachable — never block a legitimate request because
        // the rate limiter is down. Errors are logged elsewhere.
        return next();
      }
    }
    const key = opts.keyFn ? opts.keyFn(c) : c.req.header("x-forwarded-for") ?? "anon";
    try {
      await limiter.consume(key);
    } catch (info) {
      if (info instanceof Error) {
        // Real error (e.g., Redis disconnect) — fail open.
        return next();
      }
      const ms = (info as { msBeforeNext?: number }).msBeforeNext ?? 0;
      c.header("retry-after", String(Math.ceil(ms / 1000)));
      throw new BusinessError("rate_limited", "too many requests", 429);
    }
    await next();
  };
}
