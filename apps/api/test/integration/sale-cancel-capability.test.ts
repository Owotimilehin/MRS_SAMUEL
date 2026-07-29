import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { saleOrder, saleReturn } from "@ms/db";
import { makeTestApp, authOwner, authBranchStaff, seedOnlineOrder, seedUser } from "./helpers.js";
import type { Hono } from "hono";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Task 2: branch manager can cancel an order; cancel never auto-refunds.
 *
 * `manager` holds orders.manage but not pos.sell, so the cancel route's old
 * `requireCapability("pos.sell")` gate locked managers out even though they
 * are the role expected to handle order-ops cancellations. The route now
 * gates on requireAnyCapability("orders.manage", "pos.sell").
 *
 * Cancelling a paid order must never move money automatically — it restores
 * stock and marks the order cancelled, then flags refundOwed in the response
 * so the UI can prompt a human to action a manual refund via Returns.
 */
describe("sale cancel capability + refund-owed messaging", () => {
  let app: Hono;
  let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
  let container: StartedPostgreSqlContainer;

  async function authManager(branchId?: string): Promise<{ cookie: string }> {
    const email = `manager-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    await seedUser(db, {
      email,
      role: "manager",
      password: "managerpassword123",
      branchId: branchId ?? null,
    });
    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "managerpassword123" }),
    });
    if (!res.ok) throw new Error(`authManager: login failed ${res.status}`);
    return { cookie: res.headers.get("set-cookie") ?? "" };
  }

  beforeAll(async () => {
    const t = await makeTestApp();
    app = t.app;
    db = t.db;
    container = t.container;
  }, 120000);

  afterAll(async () => {
    await container.stop();
  }, 30000);

  it("a manager (orders.manage, no pos.sell) can cancel a cancellable order", async () => {
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "confirmed" });
    const { cookie } = await authManager(branchId);

    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/cancel`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "customer_changed_mind" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("cancelled");

    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(row?.status).toBe("cancelled");
  });

  it("cancelling a paid order returns refundOwed + paidAmountNgn and creates no return row", async () => {
    const { cookie } = await authOwner(app);
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "paid" });

    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/cancel`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "out_of_stock_realized_late" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; totalNgn: number };
      refundOwed: boolean;
      paidAmountNgn: number;
    };
    expect(body.data.status).toBe("cancelled");
    expect(body.refundOwed).toBe(true);
    expect(body.paidAmountNgn).toBe(body.data.totalNgn);

    // No refund/return record should have been auto-created.
    const returns = await db
      .select()
      .from(saleReturn)
      .where(eq(saleReturn.originalSaleOrderId, saleId));
    expect(returns.length).toBe(0);
  });

  it("cancelling a non-paid (confirmed) order does NOT flag refundOwed", async () => {
    const { cookie } = await authOwner(app);
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "confirmed" });

    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/cancel`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "duplicate_order" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refundOwed?: boolean };
    expect(body.refundOwed).toBeFalsy();
  });

  it("branch_staff (pos.sell) can still cancel — no regression", async () => {
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "confirmed" });
    const { cookie } = await authBranchStaff(app, db, { branchId });

    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/cancel`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "customer_changed_mind" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("cancelled");
  });
});
