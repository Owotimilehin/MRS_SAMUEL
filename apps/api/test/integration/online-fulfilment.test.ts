import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch } from "@ms/db";
import type { Hono } from "hono";
import type { createDbClient } from "@ms/db";
import { makeTestApp, seedOnlineOrder, authOwner, authBranchStaff } from "./helpers.js";

describe("online order advance", () => {
  let app: Hono;
  let db: ReturnType<typeof createDbClient>;
  let container: StartedPostgreSqlContainer;
  let ownerHeaders: Record<string, string>;

  beforeAll(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
    db = ctx.db;
    container = ctx.container;
    ownerHeaders = await authOwner(app);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("delivery order: paid -> out_for_delivery -> delivered", async () => {
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "paid",
      deliveryState: "Lagos",
      deliveryFeeNgn: 1500,
    });

    let res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body1 = (await res.json()) as { data: { status: string } };
    expect(body1.data.status).toBe("out_for_delivery");

    res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body2 = (await res.json()) as { data: { status: string } };
    expect(body2.data.status).toBe("delivered");
  });

  it("pickup order: paid -> handed_over", async () => {
    // No delivery signals → pickup
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "paid" });

    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("handed_over");
  });

  it("rejects advancing a delivered order (409)", async () => {
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "delivered" });

    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });

  it("forbids a branch_staff from advancing another branch's order (403)", async () => {
    // Seed a second branch for the staff user.
    const [otherBranch] = await db
      .insert(branch)
      .values({ name: "Other Branch", code: `OB-${Date.now()}` })
      .returning();
    if (!otherBranch) throw new Error("branch insert failed");

    // Create a paid order on a different branch.
    const { saleId, branchId: orderBranchId } = await seedOnlineOrder(db, { status: "paid" });

    // Log in as staff bound to otherBranch (not the order's branch).
    const staffHeaders = await authBranchStaff(app, db, { branchId: otherBranch.id });

    const res = await app.request(
      `/v1/branches/${orderBranchId}/sales/${saleId}/advance`,
      {
        method: "PATCH",
        headers: { ...staffHeaders, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(res.status).toBe(403);
  });
});
