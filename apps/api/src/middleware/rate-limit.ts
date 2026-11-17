import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
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

/** True only for a request carrying the internal shared secret, i.e. one made
 *  by our own storefront server over the compose network. Off (always false)
 *  when INTERNAL_RECONCILE_TOKEN is unset. Read per request, like
 *  delivery-reconcile.ts does, so it follows the environment. */
function isFromStorefront(c: Context): boolean {
  const expected = process.env.INTERNAL_RECONCILE_TOKEN;
  const given = c.req.header("x-internal-token");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The bucket a request counts against.
 *
 * The storefront's server calls this API on the shopper's behalf from one
 * in-network address with no X-Forwarded-For, so without help every shopper
 * lands in the single "anon" bucket. The storefront therefore forwards the
 * shopper's address as X-Shopper-IP. That header is honoured ONLY alongside the
 * internal shared secret: anyone can send X-Shopper-IP, so from an outside
 * caller it is ignored and the request is keyed exactly as before.
 *
 * Trusted keys are namespaced ("shopper:") so an outside caller cannot aim at a
 * shopper's bucket by forging X-Forwarded-For either.
 */
export function rateLimitKey(c: Context): string {
  if (isFromStorefront(c)) {
    const ip = c.req.header("x-shopper-ip")?.trim();
    if (ip && isIP(ip) !== 0) return `shopper:${ip}`;
  }
  return c.req.header("x-forwarded-for") ?? "anon";
}

export function rateLimit(opts: RateLimitOpts): MiddlewareHandler {
  let limiter: RateLimiterRedis | null = null;
  return async (c, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "1") return next();
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
    const key = opts.keyFn ? opts.keyFn(c) : rateLimitKey(c);
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
