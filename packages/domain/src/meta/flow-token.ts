/**
 * Signed form tokens (suite spec 07, section 5.4). Every form message carries one, so an answer
 * (and, in Phase B, a call to the data endpoint) can be tied to the form and the conversation it
 * was sent in. A token is not a secret from the customer and carries no personal data.
 *
 *   "<key>.<conversationId>.<expiresEpochSeconds>.<sig>"
 *   sig = base64url(HMAC-SHA256(secret, "wa-flow:" + first three parts)).slice(0, 32)
 */
import crypto from "node:crypto";
import type { FlowKey } from "@ms/shared";

export const FLOW_TOKEN_TTL_MS = 3 * 24 * 3600_000;

function sign(secret: string, head: string): string {
  return crypto.createHmac("sha256", secret).update(`wa-flow:${head}`).digest("base64url").slice(0, 32);
}

export function makeFlowToken(secret: string, key: FlowKey, conversationId: string, now: Date, ttlMs: number = FLOW_TOKEN_TTL_MS): string {
  const head = `${key}.${conversationId}.${Math.floor((now.getTime() + ttlMs) / 1000)}`;
  return `${head}.${sign(secret, head)}`;
}

export type FlowTokenResult =
  | { ok: true; key: string; conversationId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function readFlowToken(secret: string, token: unknown, now: Date): FlowTokenResult {
  if (typeof token !== "string" || token.length > 300) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [key, conversationId, exp, sig] = parts as [string, string, string, string];
  if (!/^[a-z_]{1,40}$/.test(key) || !/^[0-9a-f-]{36}$/i.test(conversationId) || !/^\d{1,12}$/.test(exp) || sig === "") {
    return { ok: false, reason: "malformed" };
  }
  const expected = Buffer.from(sign(secret, `${key}.${conversationId}.${exp}`));
  const given = Buffer.from(sig);
  if (!secret || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  if (Number(exp) * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, key, conversationId };
}

/**
 * The form and conversation a token names, WITHOUT checking its signature or its expiry. Used only
 * as the last fallback for working out which form an answer belongs to (spec 5.6, step 3): the
 * webhook is also replayed by the worker, which does not hold the signing secret, and an answer may
 * arrive after the token's three days. Never use this to authorise anything.
 */
export function peekFlowToken(token: unknown): { key: string; conversationId: string } | null {
  if (typeof token !== "string" || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [key, conversationId] = parts as [string, string, string, string];
  if (!/^[a-z_]{1,40}$/.test(key) || !/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  return { key, conversationId: conversationId.toLowerCase() };
}
