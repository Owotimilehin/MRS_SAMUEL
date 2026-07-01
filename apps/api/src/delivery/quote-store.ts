import Redis from "ioredis";

/**
 * Short-lived storage for delivery quotes so the create-order endpoint can
 * verify the customer didn't tamper with the fee. Backed by Redis with the
 * same TTL the provider returned (typically 5 minutes).
 *
 * Key shape: `dq:{provider_quote_id}` → JSON envelope.
 *
 * If Redis is unavailable we fail OPEN — drop the verification rather than
 * block a paying customer. The static-zone fee path remains a safe fallback.
 */

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redis.on("error", () => {
    // Swallow — callers degrade gracefully.
  });
  return redis;
}

export interface QuoteEnvelope {
  provider: "manual" | "shipbubble" | "fallback";
  branch_id: string;
  fee_ngn: number;
  dropoff_address: string;
  expires_at: number; // epoch ms
}

/** One courier option as offered to the customer, stored for validation. */
export interface StoredOption {
  id: string;
  fee_ngn: number;
}

/** The full option set offered for a quote_token, so order creation can verify
 *  the chosen option id + fee is one we actually offered. */
export interface OptionSetEnvelope {
  provider: "manual" | "shipbubble";
  branch_id: string;
  dropoff_address: string;
  options: StoredOption[];
  /** The courier-validated dropoff captured at quote time. Reused at dispatch
   *  so the rider routes to exactly this address. */
  address_code?: number;
  address_formatted?: string;
  expires_at: number; // epoch ms
}

export async function storeOptionSet(
  quoteToken: string,
  envelope: OptionSetEnvelope,
  ttlSeconds: number,
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(
      `dqo:${quoteToken}`,
      JSON.stringify(envelope),
      "EX",
      Math.max(60, ttlSeconds),
    );
  } catch {
    // Storage failure — fall through; verification fails open (delivery ₦0).
  }
}

export async function loadOptionSet(quoteToken: string): Promise<OptionSetEnvelope | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(`dqo:${quoteToken}`);
    if (!raw) return null;
    const env = JSON.parse(raw) as OptionSetEnvelope;
    if (env.expires_at < Date.now()) return null;
    return env;
  } catch {
    return null;
  }
}

export async function storeQuote(
  providerQuoteId: string,
  envelope: QuoteEnvelope,
  ttlSeconds: number,
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(
      `dq:${providerQuoteId}`,
      JSON.stringify(envelope),
      "EX",
      Math.max(60, ttlSeconds),
    );
  } catch {
    // Storage failure — fall through; verification will fail open.
  }
}

export async function loadQuote(providerQuoteId: string): Promise<QuoteEnvelope | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(`dq:${providerQuoteId}`);
    if (!raw) return null;
    const env = JSON.parse(raw) as QuoteEnvelope;
    if (env.expires_at < Date.now()) return null;
    return env;
  } catch {
    return null;
  }
}

/** Constant-time-ish comparator for the few fields we need to verify. */
export function quoteMatches(
  env: QuoteEnvelope,
  expected: { branch_id: string; fee_ngn: number; dropoff_address: string },
): boolean {
  return (
    env.branch_id === expected.branch_id &&
    env.fee_ngn === expected.fee_ngn &&
    env.dropoff_address.trim() === expected.dropoff_address.trim()
  );
}
