import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Hono } from "hono";
import type { createDbClient } from "@ms/db";
import { branch } from "@ms/db";
import { makeTestApp, seedOnlineOrder, authOwner, authBranchStaff } from "./helpers.js";

describe("online orders queue", () => {
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

  it("lists active online orders newest-first", async () => {
    // Seed two orders: one active (paid), one inactive (confirmed)
    await seedOnlineOrder(db, { status: "paid" });
    await seedOnlineOrder(db, { status: "confirmed" }); // not active

    const res = await app.request("/v1/online-orders/active", {
      headers: ownerHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    // All paid/out_for_delivery online orders should appear; confirmed should not
    const activeStatuses = body.data.map((o) => o.status);
    expect(activeStatuses.every((s) => ["paid", "out_for_delivery"].includes(s))).toBe(true);
    // At least 1 paid order is present
    expect(body.data.some((o) => o.status === "paid")).toBe(true);

    // Verify newest-first ordering
    if (body.data.length >= 2) {
      const dates = body.data.map((o) => new Date((o as { created_at_local: string }).created_at_local).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]!);
      }
    }
  });

  it("active-count reports new_since", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    await seedOnlineOrder(db, { status: "paid" });

    const res = await app.request(
      `/v1/online-orders/active-count?since=${encodeURIComponent(since)}`,
      { headers: ownerHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number; newest: string | null; new_since: number } };
    // count >= 1 (at least the order we just seeded)
    expect(body.data.count).toBeGreaterThanOrEqual(1);
    // new_since >= 1 (the order was seeded after `since`)
    expect(body.data.new_since).toBeGreaterThanOrEqual(1);
    // newest should be a non-null ISO string
    expect(body.data.newest).not.toBeNull();
  });

  it("branch staff only see their branch", async () => {
    // Seed a branch that the staff user will NOT belong to
    const [otherBranch] = await db
      .insert(branch)
      .values({ name: "Other Branch Queue", code: `OBQ-${Date.now()}` })
      .returning();
    if (!otherBranch) throw new Error("branch insert failed");

    // Seed a paid order on some (default) branch
    await seedOnlineOrder(db, { status: "paid" });

    // Staff bound to otherBranch (no orders there)
    const staffHeaders = await authBranchStaff(app, db, { branchId: otherBranch.id });

    const res = await app.request("/v1/online-orders/active", {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<unknown> };
    // Staff should see 0 orders since the seeded order is on a different branch
    expect(body.data.length).toBe(0);
  });
});
