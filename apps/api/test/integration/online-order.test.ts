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
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
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
    // POST /v1/transfers creates the row already in `dispatched` status —
    // no separate /dispatch call is needed (or exists on the route table).
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

  it("stores scheduled_delivery_at when the customer schedules for later", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        scheduled_delivery_at: future,
        customer: {
          name: "Sched Customer",
          phone: "+2348025550001",
          email: "sched@example.com",
          address: "1 Future Street",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string } };

    const detail = await fetch(`${baseUrl}/v1/branches/${branchId}/sales/${body.data.id}`, {
      headers: { cookie: cookies },
    });
    const detailBody = (await detail.json()) as {
      data: { scheduledDeliveryAt: string | null };
    };
    expect(detailBody.data.scheduledDeliveryAt).not.toBeNull();
    expect(new Date(detailBody.data.scheduledDeliveryAt!).toISOString()).toBe(future);
  });

  it("rejects a scheduled_delivery_at in the past", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        scheduled_delivery_at: past,
        customer: { name: "Past", phone: "+2348025550002", address: "2 Past Street" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(422);
  });

  it("outside-Lagos order stores the state and is charged a ₦0 delivery fee", async () => {
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Outside Lagos",
        delivery_fee_ngn: 0,
        delivery_state: "Oyo",
        customer: { name: "Oyo Customer", phone: "+2348025550006", address: "7 Ibadan Road" },
        items: [{ product_id: productId, quantity: 2 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string; total_ngn: number } };
    expect(body.data.total_ngn).toBe(5000);

    const detail = await fetch(`${baseUrl}/v1/branches/${branchId}/sales/${body.data.id}`, {
      headers: { cookie: cookies },
    });
    const detailBody = (await detail.json()) as {
      data: { deliveryState: string | null; deliveryFeeNgn: number };
    };
    expect(detailBody.data.deliveryState).toBe("Oyo");
    expect(detailBody.data.deliveryFeeNgn).toBe(0);
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

  it("tracking returns scheduled_delivery_at and delivery_state", async () => {
    const future = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
    const phone = "+2348025550005";
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Outside Lagos",
        delivery_fee_ngn: 0,
        scheduled_delivery_at: future,
        delivery_state: "Abuja (FCT)",
        customer: { name: "Track Sched", phone, address: "5 Track Street" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    const orderBody = (await orderRes.json()) as { data: { order_number: string } };

    const track = await fetch(
      `${baseUrl}/v1/public/orders/${orderBody.data.order_number}?phone=${encodeURIComponent(phone)}`,
    );
    const t = (await track.json()) as {
      data: { scheduled_delivery_at: string | null; delivery_state: string | null };
    };
    expect(new Date(t.data.scheduled_delivery_at!).toISOString()).toBe(future);
    expect(t.data.delivery_state).toBe("Abuja (FCT)");
  });

  async function eventsForOrder(orderId: string) {
    const { outboxEvent } = await import("@ms/db");
    const all = await db.select().from(outboxEvent);
    return all.filter(
      (e) => (e.payload as Record<string, unknown>)["sale_order_id"] === orderId,
    );
  }

  async function placeAndPay(extra: Record<string, unknown>, phone: string) {
    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: { name: "BP", phone, email: `${phone}@example.com`, address: "9 Pay Street" },
        items: [{ product_id: productId, quantity: 1 }],
        ...extra,
      }),
    });
    const ob = (await orderRes.json()) as { data: { order_number: string; total_ngn: number } };
    await fetch(`${baseUrl}/v1/webhooks/payaza`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "transaction.success",
        data: {
          transaction_reference: ob.data.order_number,
          status: "success",
          amount: ob.data.total_ngn,
          payaza_reference: `PYZ-${phone}`,
        },
      }),
    });
    const [order] = await db
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.orderNumber, ob.data.order_number));
    return order!;
  }

  it("scheduled order: emits sale.paid_online but NOT delivery.request", async () => {
    const future = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const order = await placeAndPay({ scheduled_delivery_at: future }, "+2348025550003");
    const mine = await eventsForOrder(order.id);
    expect(mine.some((e) => e.eventType === "delivery.request")).toBe(false);
    expect(mine.some((e) => e.eventType === "sale.paid_online")).toBe(true);
  });

  it("outside-Lagos order: emits sale.paid_online but NOT delivery.request", async () => {
    const order = await placeAndPay(
      { delivery_state: "Oyo", zone_name: "Outside Lagos", delivery_fee_ngn: 0 },
      "+2348025550007",
    );
    const mine = await eventsForOrder(order.id);
    expect(mine.some((e) => e.eventType === "delivery.request")).toBe(false);
    const paid = mine.find((e) => e.eventType === "sale.paid_online");
    expect(paid).toBeDefined();
    expect((paid!.payload as Record<string, unknown>)["delivery_state"]).toBe("Oyo");
  });

  it("immediate Lagos order: emits BOTH sale.paid_online and delivery.request", async () => {
    const order = await placeAndPay({}, "+2348025550004");
    const mine = await eventsForOrder(order.id);
    expect(mine.some((e) => e.eventType === "delivery.request")).toBe(true);
    expect(mine.some((e) => e.eventType === "sale.paid_online")).toBe(true);
  });

  it("Lagos order: accepts a fee matching a configured zone fee with NO zone_name", async () => {
    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 1500, // equals the "Test zone" fee
        customer: { name: "No Zone", phone: "+2348025550010", address: "1 Zoneless Rd" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { total_ngn: number } };
    expect(body.data.total_ngn).toBe(2500 + 1500);
  });

  it("Lagos order: rejects a fee that matches no zone and has no quote", async () => {
    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 777, // not a configured zone fee, no quote id
        customer: { name: "Bad Fee", phone: "+2348025550011", address: "2 Bad Fee Rd" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(422);
  });
});
