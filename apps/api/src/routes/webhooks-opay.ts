import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { saleOrder, type DbClient } from "@ms/db";
import { verifyOpayTransaction, isOpaySuccess } from "../payments/opay.js";
import { applyPaymentConfirmation } from "../payments/reconcile.js";
import { logger } from "../logger.js";

/**
 * OPay callback receiver. OPay signs callbacks (HMAC with the secret key) and
 * retries them, but — exactly like the Payaza webhook — we treat the callback
 * purely as a WAKE-UP and never trust its body for the money decision. On every
 * callback we re-query cashier/status (server-to-server, signed) and only flip
 * the order to paid when OPay itself reports SUCCESS. The `reference` is our own
 * order number, so a forged callback can at most trigger a status re-read of a
 * real order. Idempotent: replaying for an already-paid order is a no-op.
 *
 * This endpoint also accepts the worker sweep's re-fire body `{ reference }`.
 */
export function opayWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post("/", async (c) => {
    const requestId = c.get("requestId") as string | undefined;
    const raw = await c.req.raw.clone().text();
    logger.info({ requestId, rawLen: raw.length }, "opay webhook: inbound");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn({ requestId }, "opay webhook: non-JSON body — ignored");
      return c.json({ ok: true });
    }
    // OPay nests the merchant reference under a few envelope shapes; also accept
    // the worker re-fire's top-level { reference }.
    const p = parsed as {
      reference?: string;
      data?: { reference?: string };
      payload?: { reference?: string };
    };
    const reference = p.reference ?? p.data?.reference ?? p.payload?.reference;
    if (!reference || typeof reference !== "string") {
      logger.warn({ requestId }, "opay webhook: no reference in body — ignored");
      return c.json({ ok: true });
    }

    let confirmed;
    try {
      confirmed = await verifyOpayTransaction(reference);
    } catch (err) {
      logger.error(
        { requestId, reference, err },
        "opay webhook: status query FAILED — 500 so OPay retries",
      );
      throw err;
    }
    if (!isOpaySuccess(confirmed.status)) {
      logger.info(
        { requestId, reference, opayStatus: confirmed.status },
        "opay webhook: not SUCCESS — no-op",
      );
      return c.json({ ok: true });
    }

    const outcome = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, reference));
      if (!o) return { kind: "order_not_found" as const };
      return applyPaymentConfirmation(tx, o, confirmed, { processor: "opay" });
    });

    switch (outcome.kind) {
      case "order_not_found":
        logger.warn({ requestId, reference }, "opay webhook: no matching order — no-op");
        break;
      case "already_processed":
        logger.info(
          { requestId, reference, status: outcome.status },
          "opay webhook: already processed — no-op (idempotent)",
        );
        break;
      case "underpaid":
        logger.warn(
          { requestId, reference, totalNgn: outcome.totalNgn, netNgn: outcome.netNgn, shortfallNgn: outcome.shortfallNgn },
          "opay webhook: UNDERPAID — parked for reconcile",
        );
        break;
      case "paid":
        logger.info(
          {
            requestId,
            reference,
            orderNumber: outcome.orderNumber,
            amountNgn: outcome.amountNgn,
            isPreorder: outcome.isPreorder,
          },
          "opay webhook: order marked PAID",
        );
        break;
    }

    return c.json({ ok: true });
  });

  return r;
}
