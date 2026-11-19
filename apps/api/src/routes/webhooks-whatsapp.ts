import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, eq, gt, sql } from "drizzle-orm";
import { inboxWebhookEvent, outboxEvent, type DbClient } from "@ms/db";
import {
  finishWebhookEvent,
  ingestWhatsAppPayload,
  metaConfigFromEnv,
  syncTemplatesForWaba,
  verifyMetaSignature,
  type WaWebhookPayload,
} from "@ms/domain";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Meta WhatsApp Cloud API webhook.
 *
 *   GET  — subscription handshake (hub.verify_token must match META_VERIFY_TOKEN).
 *   POST — signed with X-Hub-Signature-256 (HMAC-SHA256 of the raw body, app
 *          secret). Unsigned or wrongly signed → 401, nothing stored.
 *
 * A valid POST is saved to inbox_webhook_event first, then processed in one
 * transaction. If processing fails the row stays unprocessed and the worker
 * retries it; Meta still gets its 200 so it doesn't hammer us with retries.
 */
export function whatsappWebhookRoutes(db: DbClient) {
  const r = new Hono();
  // Reject oversized bodies before reading them (Meta payloads are small).
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
      logger.warn("whatsapp webhook: bad or missing signature");
      return c.json({ error: { code: "unauthorized", message: "invalid signature" } }, 401);
    }

    let payload: WaWebhookPayload;
    try {
      payload = JSON.parse(raw) as WaWebhookPayload;
    } catch {
      return c.json({ ok: true });
    }
    if (payload.object !== "whatsapp_business_account") return c.json({ ok: true });

    const kind = payload.entry?.[0]?.changes?.[0]?.field ?? "unknown";
    const [event] = await db
      .insert(inboxWebhookEvent)
      .values({ source: "meta", kind, payload: payload as unknown as Record<string, unknown> })
      .returning({ id: inboxWebhookEvent.id });

    await processStoredWhatsAppEvent(db, event!.id, payload);
    return c.json({ ok: true });
  });

  return r;
}

/** Template re-syncs started after a webhook committed (not awaited by the route; tests wait on them). */
const pendingResyncs = new Set<Promise<void>>();

/** Resolves when every re-sync started by a template webhook has finished. For tests. */
export async function settleTemplateResyncs(): Promise<void> {
  while (pendingResyncs.size > 0) await Promise.allSettled([...pendingResyncs]);
}

/**
 * A template event for a template we do not hold (made in WhatsApp Manager): sync that account once,
 * after the webhook's transaction has committed and without making Meta wait for its 200. A failure
 * is logged; the hourly sync catches up.
 */
function resyncTemplates(db: DbClient, wabas: string[]): void {
  const cfg = metaConfigFromEnv();
  if (!cfg) return;
  for (const waba of wabas) {
    const run = syncTemplatesForWaba(db, cfg, waba)
      .then(() => undefined)
      .catch((err: unknown) => logger.warn({ err, waba }, "template re-sync after a webhook failed; the hourly sync will catch up"))
      .finally(() => pendingResyncs.delete(run));
    pendingResyncs.add(run);
  }
}

/**
 * Process one stored webhook event. Shared shape with the worker's retry, which
 * calls ingestWhatsAppPayload the same way.
 */
export async function processStoredWhatsAppEvent(
  db: DbClient,
  eventId: string,
  payload: WaWebhookPayload,
): Promise<void> {
  try {
    const result = await db.transaction(async (tx) => {
      const res = await ingestWhatsAppPayload(tx, payload);
      await finishWebhookEvent(tx, eventId, res);
      return res;
    });
    if (result.templateResyncWabas.length > 0) resyncTemplates(db, result.templateResyncWabas);
    if (result.unknownNumbers.length > 0) {
      logger.warn({ unknown: result.unknownNumbers }, "whatsapp webhook for unknown business number (parked)");
      await alertUnknownNumbers(db, result.unknownNumbers, eventId);
    }
  } catch (err) {
    logger.error({ err, eventId }, "whatsapp webhook processing failed; worker will retry");
    await db
      .update(inboxWebhookEvent)
      .set({
        attempts: sql`${inboxWebhookEvent.attempts} + 1`,
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(inboxWebhookEvent.id, eventId));
  }
}

/** Tell the owner once a day per unknown number, not on every webhook. */
async function alertUnknownNumbers(db: DbClient, ids: string[], eventId: string): Promise<void> {
  for (const id of ids) {
    const [recent] = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, "inbox.unknown_number"),
          gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
          sql`${outboxEvent.payload}->>'phone_number_ids' = ${id}`,
        ),
      )
      .limit(1);
    if (recent) continue;
    await db.insert(outboxEvent).values({
      eventType: "inbox.unknown_number",
      payload: { phone_number_ids: id, webhook_event_id: eventId },
    });
  }
}
