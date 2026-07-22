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
/**
 * Pull our merchant reference (order number) out of an OPay callback. OPay's
 * envelope shape isn't contractually fixed, so we look under the known nests
 * first, then fall back to a depth-bounded search for an EXACT `reference` key
 * anywhere in the body. We match the exact key (not any `*_reference`) so we
 * never grab OPay's own `transaction_reference`/`orderNo` by mistake — the same
 * class of bug that once silently no-op'd the Payaza webhook. The reference is
 * only ever used to re-query status server-to-server, so even a wrong guess can
 * at most trigger a status read of a real order (a safe no-op), never a money
 * decision. Also accepts the worker re-fire's top-level `{ reference }`.
 */
export function extractOpayReference(body: unknown, depth = 0): string | undefined {
  if (depth > 5 || body == null || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  const direct = obj.reference;
  if (typeof direct === "string" && direct.trim()) return direct;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = extractOpayReference(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

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
    const reference = extractOpayReference(parsed);
    if (!reference) {
      // Log the raw body (truncated) so we can learn OPay's ACTUAL callback
      // shape from production instead of guessing — the sweep still recovers
      // the payment regardless, so this is a diagnostic, not a failure.
      logger.warn(
        { requestId, rawSample: raw.slice(0, 2000) },
        "opay webhook: no reference in body — ignored (sweep will still reconcile)",
      );
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
