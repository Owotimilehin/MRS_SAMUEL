import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { getDeliveryProvider } from "../delivery/index.js";
import { applyDeliveryStatus } from "../delivery/apply-status.js";
import { logger } from "../logger.js";

/**
 * Reconcile trigger for the worker's delivery watchdog. It POSTs { external_ref }
 * here for deliveries whose webhook has gone silent; we poll the provider for the
 * current status and apply it through the same path the webhook uses. Mirrors the
 * Payaza self-heal (worker re-fires over HTTP; the API owns the single apply path).
 *
 * SECURITY: this route sits under /v1/ and is reachable from the public internet
 * (nginx proxies all of /v1/ to the API). The applied status is provider-sourced
 * (getStatus), never taken from the request body — but with the mock provider
 * getStatus returns a terminal snapshot for any ref, so a caller who knows a live
 * external_ref could force a state transition. Gate on a shared secret: when
 * INTERNAL_RECONCILE_TOKEN is set, require a matching X-Internal-Token header (the
 * watchdog sends it). Unset = open (parity with the existing Payaza webhook) — set
 * it in prod on BOTH the api and worker services to close the endpoint.
 */
export function deliveryReconcileRoutes(db: DbClient) {
  const r = new Hono();
  r.post("/", async (c) => {
    const requiredToken = process.env["INTERNAL_RECONCILE_TOKEN"];
    if (requiredToken && c.req.header("x-internal-token") !== requiredToken) {
      return c.json({ ok: false, changed: false, reason: "unauthorized" }, 401);
    }

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
