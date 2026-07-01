import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { getDeliveryProvider } from "../delivery/index.js";
import { applyDeliveryStatus } from "../delivery/apply-status.js";
import { logger } from "../logger.js";

/**
 * Internal reconcile trigger. The worker's delivery watchdog POSTs
 * { external_ref } here for deliveries whose webhook has gone silent; we poll
 * the provider for the current status and apply it through the same path the
 * webhook uses. Mirrors the Payaza self-heal (worker re-fires over HTTP; the
 * API owns the single apply path). Reachable only on the internal network
 * (INTERNAL_API_URL); status is provider-sourced so the body cannot inject one.
 */
export function deliveryReconcileRoutes(db: DbClient) {
  const r = new Hono();
  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { external_ref?: string };
    const externalRef = body.external_ref;
    if (!externalRef) return c.json({ ok: false, changed: false, reason: "missing external_ref" }, 400);

    const provider = getDeliveryProvider();
    const snap = await provider.getStatus(externalRef);
    if (!snap) return c.json({ ok: true, changed: false });

    const { changed } = await db.transaction((tx) => applyDeliveryStatus(tx, snap));
    if (changed) logger.info({ externalRef, status: snap.status }, "delivery reconciled via poll");
    return c.json({ ok: true, changed });
  });
  return r;
}
