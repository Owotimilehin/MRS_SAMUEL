import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("Branch-scoped preorder session", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let ownerCookies: string;
  let staffCookies: string;
  let managerCookies: string;
  let server: ReturnType<typeof serve>;
  let branchA: string;
  let branchB: string;
  let preorderId: string;
  let variantId: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    // Create branches BEFORE seeding staff so we can bind staff to branchA.
    const mkBranch = async (name: string, code: string): Promise<string> => {
      const res = await fetch(`${baseUrl}/v1/branches`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
        body: JSON.stringify({ name, code }),
      });
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    branchA = await mkBranch("Branch A", "BRA");
    branchB = await mkBranch("Branch B", "BRB");

    // Seed staff bound to branchA so requireBranchScope() is enforced.
    await seedUser(tdb.db, {
      email: "staff@example.com",
      password: "staffpassword123",
      role: "branch_staff",
      branchId: branchA,
    });
    staffCookies = await loginAs(baseUrl, "staff@example.com", "staffpassword123");

    // Seed a manager (cross-branch: no branchId pin). Managers have pos.preorder
    // but NOT pos.sell after Task 1, so they must still reach the preorder queue.
    await seedUser(tdb.db, {
      email: "manager@example.com",
      password: "managerpassword123",
      role: "manager",
    });
    managerCookies = await loginAs(baseUrl, "manager@example.com", "managerpassword123");

    // Create a product + take an explicit preorder at branch A (out of stock,
    // is_preorder:true, with a delivery date) so it lands paid+unfulfilled.
    const pRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({ name: "Mango", slug: "mango", category: "regular", initial_price_ngn: 1500 }),
    });
    const productId = ((await pRes.json()) as { data: { id: string } }).data.id;
    const { productVariant } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [variant] = await db.select().from(productVariant).where(eq(productVariant.productId, productId));
    variantId = variant!.id;

    // Open a shift at branchA so the sale-creation gate is satisfied.
    const today = new Date().toISOString().slice(0, 10);
    await fetch(`${baseUrl}/v1/branches/${branchA}/shift-open`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({ business_date: today, stock_counts: [] }),
    });

    const saleRes = await fetch(`${baseUrl}/v1/branches/${branchA}/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        channel: "walkup",
        payment_method: "cash",
        is_preorder: true,
        scheduled_delivery_at: new Date(Date.now() + 86400000).toISOString(),
        created_at_local: new Date().toISOString(),
        items: [{ variant_id: variant!.id, quantity: 2 }],
      }),
    });
    const saleId = ((await saleRes.json()) as { data: { id: string } }).data.id;
    // Mark it paid (preorder must be status=paid to appear in the queue).
    await fetch(`${baseUrl}/v1/branches/${branchA}/sales/${saleId}/pay`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({ payment_method: "cash" }),
    });
    preorderId = saleId;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await container.stop();
  });

  it("branch staff can list their branch's open preorders", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchA}/preorders`, { headers: { cookie: staffCookies } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((o) => o.id === preorderId)).toBe(true);
  });

  it("branch staff hitting another branch's queue gets 403 (scope mismatch)", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders`, { headers: { cookie: staffCookies } });
    expect(res.status).toBe(403);
  });

  it("branch staff fulfilling through the wrong branch is 403 (scope mismatch)", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders/${preorderId}/fulfil`, {
      method: "PATCH",
      headers: { cookie: staffCookies },
    });
    expect(res.status).toBe(403);
  });

  it("owner fulfilling through the wrong branch gets 404 (in-handler branch guard)", async () => {
    // Owner is exempt from requireBranchScope, so scope middleware passes.
    // fulfilPreorderTx checks the preorder belongs to the path branch — it
    // doesn't, so it 404s. This proves the in-handler guard is independent.
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders/${preorderId}/fulfil`, {
      method: "PATCH",
      headers: { cookie: ownerCookies },
    });
    expect(res.status).toBe(404);
  });

  it("manager (no pos.sell) can still list branch preorders", async () => {
    // Managers hold pos.preorder but NOT pos.sell after Task 1. This test
    // asserts the GET / gate now accepts either capability.
    const res = await fetch(`${baseUrl}/v1/branches/${branchA}/preorders`, {
      headers: { cookie: managerCookies },
    });
    expect(res.status).toBe(200);
  });

  it("manager (no pos.sell) CAN create a preorder sale", async () => {
    // pos.preorder lets a preorder-only role open the till's create path, but
    // only for is_preorder orders — the gate is open, the handler enforces.
    const res = await fetch(`${baseUrl}/v1/branches/${branchA}/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: managerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        channel: "walkup",
        payment_method: "cash",
        is_preorder: true,
        scheduled_delivery_at: new Date(Date.now() + 86400000).toISOString(),
        created_at_local: new Date().toISOString(),
        items: [{ variant_id: variantId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("manager (no pos.sell) is 403 ringing a stock-consuming sale", async () => {
    // No is_preorder — this would consume stock, which requires pos.sell. The
    // handler must reject it even though the gate accepted pos.preorder.
    const res = await fetch(`${baseUrl}/v1/branches/${branchA}/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: managerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        channel: "walkup",
        payment_method: "cash",
        created_at_local: new Date().toISOString(),
        items: [{ variant_id: variantId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(403);
  });
});
