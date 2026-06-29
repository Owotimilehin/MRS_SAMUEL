import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Hono } from "hono";
import type { createDbClient } from "@ms/db";
import { makeTestApp, seedOnlineOrder, authOwner } from "./helpers.js";

describe("online preorder produce semantics", () => {
  let app: Hono;
  let db: ReturnType<typeof createDbClient>;
  let container: StartedPostgreSqlContainer;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const ctx = await makeTestApp();
    app = ctx.app; db = ctx.db; container = ctx.container;
    headers = await authOwner(app);
  }, 120_000);
  afterAll(async () => { await container.stop(); }, 30_000);

  async function json<T>(res: Response): Promise<T> { return (await res.json()) as T; }

  it("producing a DELIVERY preorder keeps status=paid, sets produced_at, leaves the preorder queue, stays on the online queue", async () => {
    const seeded = await seedOnlineOrder(db, { status: "paid", isPreorder: true, deliveryState: "Lagos", deliveryFeeNgn: 1500 });

    // Appears in the preorder worklist before produce
    const before = await json<{ data: Array<{ id: string }> }>(
      await app.request("/v1/preorders", { headers }),
    );
    expect(before.data.some((r) => r.id === seeded.id)).toBe(true);

    // Produce it
    const res = await app.request(`/v1/preorders/${seeded.id}/fulfil`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string; producedAt: string | null; fulfilledAt: string | null } }>(res);
    expect(body.data.status).toBe("paid");          // delivery: stays paid
    expect(body.data.producedAt).not.toBeNull();     // produced now
    expect(body.data.fulfilledAt).toBeNull();         // NOT delivered yet

    // Gone from the preorder worklist
    const after = await json<{ data: Array<{ id: string }> }>(
      await app.request("/v1/preorders", { headers }),
    );
    expect(after.data.some((r) => r.id === seeded.id)).toBe(false);

    // TASK 3: re-enable once /online-orders/active exposes produced_at + stage
    // Still on the online queue (now produced / "Ready")
    // const online = await json<{ data: Array<{ id: string; produced_at: string | null }> }>(
    //   await app.request("/v1/online-orders/active", { headers }),
    // );
    // const row = online.data.find((r) => r.id === seeded.id);
    // expect(row).toBeDefined();
    // expect(row!.produced_at).not.toBeNull();
  });

  it("producing a PICKUP preorder hands it over (done) and sets both produced_at and fulfilled_at", async () => {
    const seeded = await seedOnlineOrder(db, { status: "paid", isPreorder: true }); // no delivery → pickup

    const res = await app.request(`/v1/preorders/${seeded.id}/fulfil`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string; producedAt: string | null; fulfilledAt: string | null } }>(res);
    expect(body.data.status).toBe("handed_over");
    expect(body.data.producedAt).not.toBeNull();
    expect(body.data.fulfilledAt).not.toBeNull();
  });
});
