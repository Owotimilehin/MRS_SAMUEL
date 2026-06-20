import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Customer-site happy path:
 *   1. Public menu returns seeded products + a zone for our branch
 *   2. Anonymous customer creates an order (zone valid, stock available)
 *   3. Payaza callback (verify mock-confirms in test mode) marks paid
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
    const pData = ((await pRes.json()) as {
      data: { id: string; variants: Array<{ id: string; size_ml: number }> };
    }).data;
    productId = pData.id;
    // The legacy create defaults to a 330ml variant, auto-linked to the 330ml
    // bottle material (seeded by migration 0043 in every testcontainer).
    const variantId = pData.variants.find((v) => v.size_ml === 330)!.id;

    // Production completion hard-guards on bottle stock — purchase bottles at
    // the factory against the existing 330ml material so the run can complete.
    const matsRes = await fetch(`${baseUrl}/v1/packaging/materials`, {
      headers: { cookie: cookies },
    });
    const mats = ((await matsRes.json()) as {
      data: Array<{ id: string; size_ml: number | null }>;
    }).data;
    const bottle330 = mats.find((m) => m.size_ml === 330)!;
    await fetch(`${baseUrl}/v1/packaging/purchases`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        factory_id: factoryId,
        packaging_material_id: bottle330.id,
        quantity: 1000,
        unit_cost_ngn: 50,
        total_cost_ngn: 50_000,
        purchase_date: "2026-05-01",
      }),
    });

    // 20 to branch
    const run = await fetch(`${baseUrl}/v1/production-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        factory_id: factoryId,
        run_date: "2026-05-11",
        items: [{ product_id: productId, variant_id: variantId, quantity_produced: 20 }],
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
        items: [{ product_id: productId, variant_id: variantId, quantity_sent: 20 }],
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
        payment: { provider: string; reference: string; payaza: { connectionMode: string; reference: string } };
      };
    };
    // No live quote → delivery is not charged; total is the subtotal only.
    expect(orderBody.data.total_ngn).toBe(2500 * 3);
    expect(orderBody.data.payment.provider).toBe("payaza");
    expect(orderBody.data.payment.payaza.reference).toBe(orderBody.data.order_number);
    expect(orderBody.data.payment.payaza.connectionMode).toBe("Mock"); // no keys in test

    // Simulate the Payaza callback landing (mock verify confirms in dev)
    const webhook = await fetch(`${baseUrl}/v1/webhooks/payaza`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          transaction_reference: orderBody.data.order_number,
          status: "SUCCESSFUL",
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
    const stockBody = (await stock.json()) as {
      data: Array<{ product_id: string; variant_id: string | null; balance: number }>;
    };
    expect(stockBalance(stockBody.data, productId)).toBe(17); // 20 received - 3 sold
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
        data: {
          transaction_reference: ob.data.order_number,
          status: "SUCCESSFUL",
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

  it("immediate Lagos order: emits sale.paid_online but NOT delivery.request when auto-dispatch is off", async () => {
    const order = await placeAndPay({}, "+2348025550004");
    const mine = await eventsForOrder(order.id);
    expect(mine.some((e) => e.eventType === "sale.paid_online")).toBe(true);
    expect(mine.some((e) => e.eventType === "delivery.request")).toBe(false);
  });

  it("Lagos order: a client-sent fee with no live quote is ignored (delivery ₦0)", async () => {
    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 1500, // ignored — only a locked live quote can charge
        customer: { name: "No Zone", phone: "+2348025550010", address: "1 Zoneless Rd" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { total_ngn: number } };
    expect(body.data.total_ngn).toBe(2500);
  });

  it("Lagos order: an arbitrary fee with no quote is forced to ₦0, not rejected", async () => {
    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 777, // no live quote → forced to ₦0
        customer: { name: "Bad Fee", phone: "+2348025550011", address: "2 Bad Fee Rd" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { total_ngn: number } };
    expect(body.data.total_ngn).toBe(2500);
  });

  it("quote: a branch with an address but no coords still returns live options", async () => {
    // Regression: the quote endpoint used to hard-gate on pickup lat/lng, so a
    // branch created without coordinates (the prod state) always fell back to
    // ₦0 with "Live delivery pricing is unavailable" and never showed couriers.
    // The active provider geocodes the address, so only the address is required.
    const res = await fetch(`${baseUrl}/v1/public/orders/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        branch_id: branchId,
        dropoff_address: "15 Admiralty Way, Lekki Phase 1, Lagos",
        delivery_state: "Lagos",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { provider: string; options: Array<{ id: string; fee_ngn: number }> };
    };
    expect(body.data.provider).not.toBe("fallback");
    expect(body.data.options.length).toBeGreaterThan(0);
  });
});
