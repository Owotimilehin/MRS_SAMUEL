import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { saleOrder, outboxEvent } from "@ms/db";
import { makeTestApp, authOwner, seedOnlineOrder } from "./helpers.js";
import type { Hono } from "hono";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Task 2 part (B): payments-admin.ts POST /:id/cancel-refund must ask (via the
 * request body) whether a refund is owed instead of always flagging one.
 *
 * Uses seedOnlineOrder (direct DB insert) rather than the real /public/orders
 * checkout flow — this route only cares about the order's current status, and
 * going through real checkout would require a configured payment provider.
 */
describe("cancel-refund honours the refund-owed choice", () => {
  let app: Hono;
  let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    const t = await makeTestApp();
    app = t.app;
    db = t.db;
    container = t.container;
  }, 120000);

  afterAll(async () => {
    await container.stop();
  }, 30000);

  it("paid order + refundOwed:true sets refundOwedNgn (clamped to the order total) and emits sale.refund_owed", async () => {
    const { cookie } = await authOwner(app);
    const { saleId } = await seedOnlineOrder(db, { status: "paid" });
    const [before] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    const totalNgn = before!.totalNgn;

    const res = await app.request(`/v1/online-orders/${saleId}/cancel-refund`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        reason: "Product unavailable after payment",
        refundOwed: true,
        // Deliberately above the order total to prove the clamp.
        refundAmountNgn: totalNgn + 10_000,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; refund_owed_ngn: number } };
    expect(body.data.status).toBe("cancelled");
    expect(body.data.refund_owed_ngn).toBe(totalNgn);

    const [after] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(after?.status).toBe("cancelled");
    expect(after?.refundOwedNgn).toBe(totalNgn);

    const events = await db.select().from(outboxEvent);
    const refundEvent = events.find(
      (e) =>
        e.eventType === "sale.refund_owed" &&
        (e.payload as Record<string, unknown>)["sale_order_id"] === saleId,
    );
    expect(refundEvent).toBeDefined();
    expect((refundEvent!.payload as Record<string, unknown>)["refund_owed_ngn"]).toBe(totalNgn);
  });

  it("paid order + refundOwed:false cancels, leaves refundOwedNgn null, and emits NO sale.refund_owed event", async () => {
    const { cookie } = await authOwner(app);
    const { saleId } = await seedOnlineOrder(db, { status: "paid" });

    const res = await app.request(`/v1/online-orders/${saleId}/cancel-refund`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "Customer accepted store credit instead", refundOwed: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; refund_owed_ngn: number | null } };
    expect(body.data.status).toBe("cancelled");
    expect(body.data.refund_owed_ngn ?? null).toBeNull();

    const [after] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(after?.status).toBe("cancelled");
    expect(after?.refundOwedNgn).toBeNull();

    const events = await db.select().from(outboxEvent);
    const refundEvent = events.find(
      (e) =>
        e.eventType === "sale.refund_owed" &&
        (e.payload as Record<string, unknown>)["sale_order_id"] === saleId,
    );
    expect(refundEvent).toBeUndefined();
  });

  it("unpaid (confirmed) order + refundOwed:false cancels cleanly with no refund flag (regression for the old unconditional-set bug)", async () => {
    const { cookie } = await authOwner(app);
    const { saleId } = await seedOnlineOrder(db, { status: "confirmed" });

    const res = await app.request(`/v1/online-orders/${saleId}/cancel-refund`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "Customer changed mind before paying", refundOwed: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; refund_owed_ngn: number | null } };
    expect(body.data.status).toBe("cancelled");
    expect(body.data.refund_owed_ngn ?? null).toBeNull();

    const [after] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(after?.status).toBe("cancelled");
    expect(after?.refundOwedNgn).toBeNull();
  });
});
