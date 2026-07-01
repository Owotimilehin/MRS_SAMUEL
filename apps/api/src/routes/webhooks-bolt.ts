import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { getDeliveryProvider } from "../delivery/index.js";
import { applyDeliveryStatus } from "../delivery/apply-status.js";
import { BusinessError } from "../lib/errors.js";
import { logger } from "../logger.js";

/**
 * Bolt webhook receiver. Signed-payload verified, idempotent: replaying the
 * same event is a no-op once the row is at or beyond that status.
 *
 * Status flow on sale_order, driven by delivery_order webhooks:
 *   paid → out_for_delivery (when delivery goes picked_up or in_transit)
 *   out_for_delivery → delivered (when delivery.status = delivered)
 *
 * Failed / cancelled deliveries leave sale_order at `paid` so a human can
 * decide whether to retry, refund, or escalate.
 */
export function boltWebhookRoutes(db: DbClient) {
  return deliveryWebhookRoutes(db, "x-bolt-signature");
}

/** Shipbubble signs with `x-ship-signature` (HMAC-SHA512). */
export function shipbubbleWebhookRoutes(db: DbClient) {
  return deliveryWebhookRoutes(db, "x-ship-signature");
}

/**
 * Generic delivery webhook receiver. The active provider (selected by env)
 * verifies + normalizes the payload; the signature header name is the only
 * provider-specific bit, so it's a parameter.
 */
export function deliveryWebhookRoutes(db: DbClient, signatureHeader: string) {
  const r = new Hono();

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    const signature = c.req.header(signatureHeader) ?? null;
    const provider = getDeliveryProvider();

    let parsed;
    try {
      parsed = provider.parseWebhook(raw, signature);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "bolt webhook signature failure",
      );
      throw new BusinessError("unauthorized", "invalid signature", 401);
    }
    if (!parsed) {
      // Recognised payload, nothing to do.
      return c.json({ ok: true });
    }

    await db.transaction(async (tx) => {
      await applyDeliveryStatus(tx, parsed);
    });

    return c.json({ ok: true });
  });

  return r;
}
