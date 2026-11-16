import { Hono } from "hono";
import Redis from "ioredis";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Public Instagram feed endpoint — proxies the latest posts from the
 * @mrs_samuelfruitjuice business account via Meta's Graph API. The long-lived
 * access token + business account ID are configured via env. Responses are
 * cached in Redis for 30 minutes to stay well under Graph API's 200 calls/hour
 * per user rate limit.
 *
 * Setup (see README): IG_ACCESS_TOKEN must be a long-lived (60-day) token, and
 * IG_BUSINESS_ACCOUNT_ID is the Instagram Business Account ID found via
 * `GET /{page-id}?fields=instagram_business_account` in Graph API Explorer.
 */

const CACHE_KEY = "ig:feed:v1";
const CACHE_TTL_S = 1800; // 30 minutes
const FIELDS = "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp";
const LIMIT = 12;
const GRAPH_TIMEOUT_MS = 4000;
/** After a failed Graph call, wait this long before trying again (rate limit: 200/h). */
const RETRY_AFTER_FAILURE_MS = 60_000;

type IgMedia = {
  id: string;
  caption?: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_url: string;
  permalink: string;
  thumbnail_url?: string;
  timestamp: string;
};

type FeedItem = {
  id: string;
  imageUrl: string;
  permalink: string;
  caption: string;
  isVideo: boolean;
  timestamp: string;
};

let redisClient: Redis | null = null;
let memCache: { at: number; data: FeedItem[] } | null = null;
function getRedis(): Redis {
  if (redisClient) return redisClient;
  redisClient = new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redisClient.on("error", (err) => logger.warn({ err }, "ig redis error"));
  return redisClient;
}

async function fetchFromGraphApi(): Promise<FeedItem[]> {
  const accountId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!accountId || !token) {
    throw new Error("IG_BUSINESS_ACCOUNT_ID / IG_ACCESS_TOKEN not configured");
  }
  const url = `https://graph.facebook.com/v18.0/${accountId}/media?fields=${FIELDS}&limit=${LIMIT}&access_token=${token}`;
  // Bounded: the home page waits on this feed, so a slow Meta must not hang it.
  const res = await fetch(url, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: IgMedia[] };
  const items = json.data ?? [];
  return items.map((m): FeedItem => ({
    id: m.id,
    imageUrl: m.media_type === "VIDEO" ? (m.thumbnail_url ?? m.media_url) : m.media_url,
    permalink: m.permalink,
    caption: (m.caption ?? "").slice(0, 280),
    isVideo: m.media_type === "VIDEO",
    timestamp: m.timestamp,
  }));
}

export function publicInstagramRoutes(): Hono {
  const r = new Hono();

  r.get("/feed", async (c) => {
    // The Redis cache is an optimisation, never a dependency: if it's
    // unreachable (e.g. "Stream isn't writeable" while the client is offline)
    // we fall back to a per-process memory cache and still fetch from Meta.
    const now = Date.now();
    if (memCache && now - memCache.at < CACHE_TTL_S * 1000) {
      return c.json({ data: memCache.data, cached: true });
    }
    try {
      const cached = await getRedis().get(CACHE_KEY);
      if (cached) {
        const data = JSON.parse(cached) as FeedItem[];
        memCache = { at: now, data };
        return c.json({ data, cached: true });
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ig cache read failed");
    }
    try {
      const feed = await fetchFromGraphApi();
      memCache = { at: now, data: feed };
      getRedis()
        .set(CACHE_KEY, JSON.stringify(feed), "EX", CACHE_TTL_S)
        .catch((err: unknown) =>
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ig cache write failed"),
        );
      return c.json({ data: feed, cached: false });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ig feed fetch failed");
      // Negative-cache the failure for a minute so a dead token/Meta outage
      // doesn't trigger a Graph call on every page view.
      const stale = memCache?.data ?? [];
      memCache = { at: now - CACHE_TTL_S * 1000 + RETRY_AFTER_FAILURE_MS, data: stale };
      // Serve the last good copy WITHOUT an error field (the site's apiFetch
      // treats any `error` as a failure and would discard it). Only an empty
      // result carries the error. Never echo internal error text publicly.
      return stale.length > 0
        ? c.json({ data: stale, cached: true, stale: true })
        : c.json({ data: [] satisfies FeedItem[], error: "feed unavailable" });
    }
  });

  return r;
}
