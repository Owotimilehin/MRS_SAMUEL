import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { saleOrder, outboxEvent, payment, stockLedger, type DbClient } from "@ms/db";
import { makeTestApp, seedOnlineOrder } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * P1: a payment that lands after the 60-minute auto-cancel.
 *
 * The worker's late-payment sweep re-fires this webhook for orders cancelled as
 * `payment_expired`; OPay's own callback may hit it as well. Whoever arrives,
 * and however many times, the owner must get exactly ONE "refund needed" alert
 * and nothing else may move.
 */
describe("OPay webhook: payment on an order already cancelled as unpaid", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db, container } = await makeTestApp());
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** What OPay's cashier/status answers for every reference. */
  function opayStatus(answer: "SUCCESS" | "PENDING" | "down"): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (!String(url).includes("/cashier/status")) throw new Error(`unexpected fetch ${String(url)}`);
        if (answer === "down") return new Response("bad gateway", { status: 502 });
        return new Response(
          JSON.stringify({
            code: "00000",
            data: { status: answer, orderNo: "OPAY-LATE-1", amount: { total: 250000, currency: "NGN" } },
          }),
          { status: 200 },
        );
      }),
    );
  }

  /** An online order the expiry job cancelled an hour after it was placed. */
  async function expiredOrder(): Promise<{ id: string; orderNumber: string }> {
    const { id } = await seedOnlineOrder(db, { status: "cancelled" });
    const [o] = await db
      .update(saleOrder)
      .set({ cancelReason: "payment_expired", cancelledAt: new Date() })
      .where(eq(saleOrder.id, id))
      .returning();
    return { id, orderNumber: o!.orderNumber };
  }

  /** The worker's re-fire body; OPay's real callback carries the same reference. */
  function webhook(orderNumber: string): Promise<Response> {
    return Promise.resolve(
      app.request("/v1/webhooks/opay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: orderNumber }),
      }),
    );
  }

  const alertsFor = (orderId: string) =>
    db
      .select()
      .from(outboxEvent)
      .where(
        sql`${outboxEvent.eventType} = 'sale.paid_after_cancel' and ${outboxEvent.payload}->>'sale_order_id' = ${orderId}`,
      );

  it("raises the paid-after-cancel alert and changes nothing else", async () => {
    const o = await expiredOrder();
    opayStatus("SUCCESS");

    expect((await webhook(o.orderNumber)).status).toBe(200);

    const alerts = await alertsFor(o.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({
      sale_order_id: o.id,
      order_number: o.orderNumber,
      gross_ngn: 2500,
      processor: "opay",
      processor_reference: "OPAY-LATE-1",
    });

    // Not reinstated, not booked as paid, no stock moved: the owner decides.
    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, o.id));
    expect(row!.status).toBe("cancelled");
    expect(row!.paymentStatus).toBe("pending");
    expect(await db.select().from(payment).where(eq(payment.saleOrderId, o.id))).toHaveLength(0);
    expect(await db.select().from(stockLedger).where(eq(stockLedger.sourceId, o.id))).toHaveLength(0);
  });

  it("alerts once even when the callback and the sweep arrive together, and again later", async () => {
    const o = await expiredOrder();
    opayStatus("SUCCESS");

    const together = await Promise.all(Array.from({ length: 10 }, () => webhook(o.orderNumber)));
    expect(together.every((r) => r.status === 200)).toBe(true);
    expect(await alertsFor(o.id)).toHaveLength(1);

    // The next sweep, and a provider retry of the callback, find it already handled.
    await webhook(o.orderNumber);
    await webhook(o.orderNumber);
    expect(await alertsFor(o.id)).toHaveLength(1);
  });

  it("a second confirmation arriving before the first has committed cannot alert too", async () => {
    const o = await expiredOrder();
    opayStatus("SUCCESS");
    const { applyPaymentConfirmation } = await import("../../src/payments/reconcile.js");

    let second!: Promise<Response>;
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(saleOrder).where(eq(saleOrder.id, o.id));
      await applyPaymentConfirmation(
        tx,
        row!,
        {
          status: "SUCCESS",
          amountNgn: 2500,
          feeNgn: null,
          netNgn: 2500,
          processorReference: "OPAY-LATE-1",
          authorization: null,
          raw: {},
        },
        { processor: "opay" },
      );
      // The first caller has written its alert but not committed, so the second
      // cannot see it. It must wait for the order's row lock rather than decide
      // "no alert yet" and write another.
      second = webhook(o.orderNumber);
      await new Promise((r) => setTimeout(r, 400));
    });

    expect((await second).status).toBe(200);
    expect(await alertsFor(o.id)).toHaveLength(1);
  });

  it("stays silent while OPay says the order is not paid", async () => {
    const o = await expiredOrder();
    opayStatus("PENDING");
    expect((await webhook(o.orderNumber)).status).toBe(200);
    expect(await alertsFor(o.id)).toHaveLength(0);
  });

  it("answers non-2xx when the status check itself fails, so the worker knows it does not know", async () => {
    const o = await expiredOrder();
    opayStatus("down");
    expect((await webhook(o.orderNumber)).status).toBe(500);
    expect(await alertsFor(o.id)).toHaveLength(0);
  });
});
