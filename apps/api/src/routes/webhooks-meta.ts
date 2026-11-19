import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq, sql } from "drizzle-orm";
import { inboxWebhookEvent, type DbClient } from "@ms/db";
import {
  finishMetaWebhookEvent,
  ingestMetaEntry,
  metaEventKind,
  verifyMetaSignature,
  type MetaEntry,
  type MetaIngestResult,
  type MetaWebhookPayload,
} from "@ms/domain";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Meta webhook for Facebook Page and Instagram events (suite spec 02, foundation D6).
 *
 *   GET  — subscription handshake (hub.verify_token must match META_VERIFY_TOKEN).
 *   POST — signed with X-Hub-Signature-256 (HMAC-SHA256 of the raw body, app
 *          secret). Unsigned or wrongly signed → 401, nothing stored.
 *
 * Each entry is stored as its own inbox_webhook_event row first (rule R1, R2),
 * then processed in one transaction through ingestMetaEntry, the single
 * dispatch point (ruling 9.2.3). No call to Meta is made on this path, so the
 * answer stays well inside Meta's 5 seconds. A failure leaves the row
 * unprocessed for the worker to retry; Meta still gets its 200.
 */
export function metaWebhookRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.text("payload too large", 413) }));

  r.get("/", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN && challenge) {
      return c.text(challenge, 200);
    }
    return c.text("forbidden", 403);
  });

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    const secret = env.META_APP_SECRET;
    if (!secret || !verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), secret)) {
      logger.warn("meta webhook: bad or missing signature");
      return c.json({ error: { code: "unauthorized", message: "invalid signature" } }, 401);
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(raw) as MetaWebhookPayload;
    } catch {
      return c.json({ ok: true });
    }
    const object = payload?.object;
    if (object !== "page" && object !== "instagram") return c.json({ ok: true });

    const stored: { id: string; payload: StoredMetaPayload }[] = [];
    for (const entry of payload.entry ?? []) {
      const one: StoredMetaPayload = { object, entry: [entry] };
      const [event] = await db
        .insert(inboxWebhookEvent)
        .values({ source: "meta", kind: metaEventKind(object, entry), payload: one as unknown as Record<string, unknown> })
        .returning({ id: inboxWebhookEvent.id });
      stored.push({ id: event!.id, payload: one });
    }
    for (const ev of stored) await processStoredMetaEvent(db, ev.id, ev.payload);
    return c.json({ ok: true });
  });

  return r;
}

/** What one stored row holds: the object and exactly one entry. */
export interface StoredMetaPayload {
  object: string;
  entry: MetaEntry[];
}

/**
 * Process one stored Page/Instagram event. The worker's retry does the same
 * (ingestMetaEntry + finishMetaWebhookEvent in one transaction).
 */
export async function processStoredMetaEvent(
  db: DbClient,
  eventId: string,
  payload: StoredMetaPayload,
): Promise<MetaIngestResult | null> {
  const entry = payload.entry?.[0] ?? {};
  try {
    const result = await db.transaction(async (tx) => {
      const res = await ingestMetaEntry(tx, payload.object, entry, process.env.META_APP_ID ? { appId: process.env.META_APP_ID } : {});
      await finishMetaWebhookEvent(tx, eventId, res);
      return res;
    });
    if (result.unknownAccounts.length > 0) {
      logger.warn({ unknown: result.unknownAccounts }, "meta webhook for an account that isn't connected (parked)");
    }
    return result;
  } catch (err) {
    logger.warn({ err, eventId }, "meta webhook processing failed; worker will retry");
    await db
      .update(inboxWebhookEvent)
      .set({
        attempts: sql`${inboxWebhookEvent.attempts} + 1`,
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(inboxWebhookEvent.id, eventId));
    return null;
  }
}
