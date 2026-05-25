import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Customer-site happy path:
 *   1. Public menu returns seeded products + a zone for our branch
 *   2. Anonymous customer creates an order (zone valid, stock available)
 *   3. Payaza webhook (HMAC validation off in test mode) marks paid
 *   4. Branch ledger decrements; tracking endpoint shows paid status
 */
describe("Phase 3 customer-site online order flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    // Branch with one zone
    const bRes = await fetch(`${baseUrl}/v1/branches`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "Online Branch",
        code: "ONLB",
        delivery_zones: [{ name: "Test zone", fee_ngn: 1500 }],
      }),
    });
    branchId = ((await bRes.json()) as { data: { id: string } }).data.id;

    const { factory } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factory).values({ name: "Online Factory" }).returning();
    if (!fac) throw new Error("factory failed");
    const factoryId = fac.id;

    const pRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "Online Sunrise",
        slug: "online-sunrise",
        category: "regular",
        initial_price_ngn: 2500,
      }),
    });
    productId = ((await pRes.json()) as { data: { id: string } }).data.id;

    // 20 to branch
    const run = await fetch(`${baseUrl}/v1/production-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        factory_id: factoryId,
        run_date: "2026-05-11",
        items: [{ product_id: productId, quantity_produced: 20 }],
      }),
    });
    const runId = ((await run.json()) as { data: { id: string } }).data.id;
    await fetch(`${baseUrl}/v1/production-runs/${runId}/complete`, {
      method: "PATCH",
      headers: { cookie: cookies, "idempotency-key": uuid() },
    });
    const xf = await fetch(`${baseUrl}/v1/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        factory_id: factoryId,
        branch_id: branchId,
        items: [{ product_id: productId, quantity_sent: 20 }],
      }),
    });
    const xfId = ((await xf.json()) as { data: { id: string } }).data.id;
    await fetch(`${baseUrl}/v1/transfers/${xfId}/dispatch`, {
      method: "PATCH",
      headers: { cookie: cookies, "idempotency-key": uuid() },
    });
    await fetch(`${baseUrl}/v1/transfers/${xfId}/arrive`, {
      method: "PATCH",
      headers: { cookie: cookies, "idempotency-key": uuid() },
    });
    const detail = await fetch(`${baseUrl}/v1/transfers/${xfId}`, { headers: { cookie: cookies } });
    const detailBody = (await detail.json()) as { data: { items: Array<{ id: string }> } };
    await fetch(`${baseUrl}/v1/transfers/${xfId}/receive`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        items: [{ item_id: detailBody.data.items[0]!.id, quantity_received: 20 }],
      }),
    });
  }, 90_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("public catalog returns seeded products and zones", async () => {
    const products = await fetch(`${baseUrl}/v1/public/catalog/products`).then((r) => r.json()) as {
      data: Array<{ id: string; name: string; price_ngn: number }>;
    };
    expect(products.data.length).toBeGreaterThan(0);
    expect(products.data[0]!.price_ngn).toBeGreaterThan(0);

    const zones = await fetch(`${baseUrl}/v1/public/catalog/zones`).then((r) => r.json()) as {
      data: Array<{ branch_id: string; name: string; fee_ngn: number }>;
    };
    expect(zones.data.some((z) => z.branch_id === branchId)).toBe(true);
  });

  it("anonymous customer places + pays online order, branch ledger decrements", async () => {
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "Aisha Okeke",
          phone: "+2348025551234",
          email: "aisha@example.com",
          address: "14B Babafemi Bakare Street",
        },
        items: [{ product_id: productId, quantity: 3 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const orderBody = (await orderRes.json()) as {
      data: {
        order_number: string;
        total_ngn: number;
        payment: { authorization_url: string; reference: string };
      };
    };
    expect(orderBody.data.total_ngn).toBe(2500 * 3 + 1500);
    expect(orderBody.data.payment.authorization_url).toContain("paid=1");

    // Simulate the Payaza webhook landing on success (no signature in dev)
    const webhook = await fetch(`${baseUrl}/v1/webhooks/payaza`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "transaction.success",
        data: {
          transaction_reference: orderBody.data.order_number,
          status: "success",
          amount: orderBody.data.total_ngn,
          payaza_reference: "PYZ-MOCK-001",
        },
      }),
    });
    expect(webhook.status).toBe(200);

    // Tracking endpoint shows paid status
    const track = await fetch(
      `${baseUrl}/v1/public/orders/${orderBody.data.order_number}?phone=${encodeURIComponent("+2348025551234")}`,
    );
    expect(track.status).toBe(200);
    const trackBody = (await track.json()) as {
      data: { status: string; payment_status: string };
    };
    expect(trackBody.data.status).toBe("paid");
    expect(trackBody.data.payment_status).toBe("paid");

    // Branch ledger reflects the 3 bottles sold
    const stock = await fetch(`${baseUrl}/v1/stock/branch/${branchId}`, {
      headers: { cookie: cookies },
    });
    const stockBody = (await stock.json()) as { data: Record<string, number> };
    expect(stockBody.data[productId]).toBe(17); // 20 received - 3 sold
  });

  it("tracking with wrong phone returns 404 (no enumeration)", async () => {
    // Create another order to track
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "Tunde",
          phone: "+2348025559999",
          email: "tunde@example.com",
          address: "10 Test Road",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    const orderBody = (await orderRes.json()) as { data: { order_number: string } };

    const track = await fetch(
      `${baseUrl}/v1/public/orders/${orderBody.data.order_number}?phone=wrong-number`,
    );
    expect(track.status).toBe(404);
  });
});
