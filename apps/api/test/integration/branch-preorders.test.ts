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
  let server: ReturnType<typeof serve>;
  let branchA: string;
  let branchB: string;
  let preorderId: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    await seedUser(tdb.db, {
      email: "staff@example.com",
      password: "staffpassword123",
      role: "branch_staff",
    });
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    staffCookies = await loginAs(baseUrl, "staff@example.com", "staffpassword123");

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

  it("a branch's queue never shows another branch's preorders", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders`, { headers: { cookie: staffCookies } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((o) => o.id === preorderId)).toBe(false);
  });

  it("fulfilling through the wrong branch is rejected", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders/${preorderId}/fulfil`, {
      method: "PATCH",
      headers: { cookie: staffCookies },
    });
    expect(res.status).toBe(404);
  });
});
