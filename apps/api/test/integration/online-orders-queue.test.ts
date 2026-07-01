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

  it("lists active online orders newest-first (now including awaiting-payment)", async () => {
    await seedOnlineOrder(db, { status: "paid" });
    await seedOnlineOrder(db, { status: "confirmed" });

    const res = await app.request("/v1/online-orders/active", {
      headers: ownerHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    // The till list now shows the awaiting-payment states too, so every row is
    // one of the widened LIST_STATUSES.
    const listStatuses = body.data.map((o) => o.status);
    expect(
      listStatuses.every((s) =>
        ["confirmed", "reconcile_needed", "paid", "out_for_delivery"].includes(s),
      ),
    ).toBe(true);
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

  it("till /active lists awaiting-payment orders (confirmed + reconcile_needed), branch-scoped", async () => {
    // A dedicated branch so the assertions are exact.
    const [br] = await db
      .insert(branch)
      .values({ name: "Awaiting Pay Branch", code: `APB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("branch insert failed");
    const [otherBr] = await db
      .insert(branch)
      .values({ name: "Other Await Branch", code: `OAB-${Date.now()}` })
      .returning();
    if (!otherBr) throw new Error("other branch insert failed");

    const paid = await seedOnlineOrder(db, { status: "paid", branchId: br.id });
    const confirmed = await seedOnlineOrder(db, { status: "confirmed", branchId: br.id });
    const reconcile = await seedOnlineOrder(db, { status: "reconcile_needed", branchId: br.id });
    // Same-status order on a DIFFERENT branch must not leak to this till.
    const otherConfirmed = await seedOnlineOrder(db, { status: "confirmed", branchId: otherBr.id });

    const staffHeaders = await authBranchStaff(app, db, { branchId: br.id });
    const res = await app.request("/v1/online-orders/active", { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((o) => o.id);
    expect(ids).toContain(paid.id);
    expect(ids).toContain(confirmed.id);
    expect(ids).toContain(reconcile.id);
    expect(ids).not.toContain(otherConfirmed.id); // branch scope holds
  });

  it("badge count stays paid-only after the list widens", async () => {
    const [br] = await db
      .insert(branch)
      .values({ name: "Badge Count Branch", code: `BCB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("branch insert failed");

    await seedOnlineOrder(db, { status: "paid", branchId: br.id });
    await seedOnlineOrder(db, { status: "confirmed", branchId: br.id });
    await seedOnlineOrder(db, { status: "reconcile_needed", branchId: br.id });

    const staffHeaders = await authBranchStaff(app, db, { branchId: br.id });
    const res = await app.request("/v1/online-orders/active-count", { headers: staffHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    // Only the single paid order counts — confirmed/reconcile_needed must not
    // trip the new-order badge/chime.
    expect(body.data.count).toBe(1);
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

  it("active-count respects branch scope", async () => {
    // Seed a branch the staff user will NOT belong to
    const [otherBranch] = await db
      .insert(branch)
      .values({ name: "Other Branch Count", code: `OBC-${Date.now()}` })
      .returning();
    if (!otherBranch) throw new Error("branch insert failed");

    // Seed an active (paid) online order on the default branch
    await seedOnlineOrder(db, { status: "paid" });

    // Staff bound to otherBranch (no orders there)
    const staffHeaders = await authBranchStaff(app, db, { branchId: otherBranch.id });

    const res = await app.request("/v1/online-orders/active-count", {
      headers: staffHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number; new_since: number } };
    // Staff's branch has no active orders → count 0, new_since 0
    expect(body.data.count).toBe(0);
    expect(body.data.new_since).toBe(0);
  });
});
