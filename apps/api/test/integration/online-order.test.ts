import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Customer-site happy path:
 *   1. Public menu returns seeded products + a zone for our branch
 *   2. Anonymous customer creates an order (zone valid, stock available)
 *   3. Payaza callback → webhook re-verifies against Payaza (stubbed) → paid
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
    // A PKTEST key so checkout-config builds in "Test" mode and the webhook's
    // verify takes the real server-to-server path (stubbed per-test). There is
    // no mock-confirm fallback anymore — without a key, order creation throws.
    // Set on process.env directly (not vi.stubEnv) so it survives the
    // afterEach unstubAllEnvs and stays in force for the whole suite.
    process.env.PAYAZA_PUBLIC_KEY = "PZ78-PKTEST-itest";
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

    // Task 5 flipped the default active provider to OPay. This whole suite was
    // written against Payaza's popup-SDK response shape, so pin the setting to
    // payaza for the suite's default — the dedicated "provider dispatch" tests
    // below explicitly flip it to opay for their own assertions.
    const { appSetting, PAYMENT_PROVIDER_KEY } = await import("@ms/db");
    await tdb.db
      .insert(appSetting)
      .values({ key: PAYMENT_PROVIDER_KEY, value: { provider: "payaza" } })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: { provider: "payaza" } } });

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
    delete process.env.PAYAZA_PUBLIC_KEY;
    server.close();
    await container.stop();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
        is_preorder: boolean;
        payment: { provider: string; reference: string; payaza: { connectionMode: string; reference: string } };
      };
    };
    // No live quote → delivery is not charged; total is the subtotal only.
    expect(orderBody.data.total_ngn).toBe(2500 * 3);
    // In stock (20 on hand, ordered 3) → a normal order, not made-to-order.
    expect(orderBody.data.is_preorder).toBe(false);
    expect(orderBody.data.payment.provider).toBe("payaza");
    expect(orderBody.data.payment.payaza.reference).toBe(orderBody.data.order_number);
    expect(orderBody.data.payment.payaza.connectionMode).toBe("Test"); // PKTEST key in test env

    // The callback is only a wake-up; the webhook re-verifies the txn against
    // Payaza server-to-server. Stub THAT single query to report a completed
    // payment (delegating every other URL — including this test's own calls to
    // baseUrl — to the real fetch), so the order is confirmed via the real
    // verify+reconcile path, never a mock shim.
    const realFetch = globalThis.fetch;
    const merchantRef = orderBody.data.order_number;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("transaction-query")) {
          // Payaza's verify endpoint searches by OUR merchant reference (the
          // order number). A query by Payaza's own internal id answers "not
          // found" — exactly like the live API. This is what catches the
          // wrong-reference bug: the webhook must verify by the merchant ref.
          const byMerchantRef = String(url).includes(
            `merchant_reference=${encodeURIComponent(merchantRef)}`,
          );
          if (byMerchantRef) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    transaction_status: "Completed",
                    amount_received: 2500 * 3,
                    transaction_reference: "PZ-INTERNAL-REF",
                    merchant_transaction_reference: merchantRef,
                  },
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({ success: false, message: "Transaction not found", data: null }),
              { status: 400 },
            ),
          );
        }
        return realFetch(url as Parameters<typeof realFetch>[0], init);
      }),
    );

    // Simulate the REAL Payaza callback shape: `transaction_reference` is
    // Payaza's own internal id, `merchant_transaction_reference` is our order
    // number. The webhook must verify by the merchant reference, not Payaza's id.
    const webhook = await fetch(`${baseUrl}/v1/webhooks/payaza`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          transaction_reference: "PZ-INTERNAL-REF",
          merchant_transaction_reference: orderBody.data.order_number,
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

  it("webhook ALONE marks the order paid, verifying by the merchant reference not Payaza's internal id", async () => {
    // Regression for the prod bug where the webhook read Payaza's own
    // `transaction_reference` and verified by it — Payaza's verify endpoint
    // searches by the MERCHANT reference, so it answered "not found" and the
    // webhook never confirmed. We assert the DB state straight after the webhook
    // (no tracking call, which would re-verify and mask the bug).
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: { name: "Bola Webhook", phone: "+2348025550000", address: "1 Test Rd" },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const { data: order } = (await orderRes.json()) as { data: { order_number: string } };
    const merchantRef = order.order_number;

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("transaction-query")) {
          const byMerchantRef = String(url).includes(
            `merchant_reference=${encodeURIComponent(merchantRef)}`,
          );
          if (byMerchantRef) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: {
                    transaction_status: "Completed",
                    amount_received: 2500,
                    transaction_reference: "PZ-INTERNAL-REF",
                    merchant_transaction_reference: merchantRef,
                  },
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({ success: false, message: "Transaction not found", data: null }),
              { status: 400 },
            ),
          );
        }
        return realFetch(url as Parameters<typeof realFetch>[0], init);
      }),
    );

    // Real Payaza callback shape: `transaction_reference` is Payaza's internal id.
    const webhook = await fetch(`${baseUrl}/v1/webhooks/payaza`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          transaction_reference: "PZ-INTERNAL-REF",
          merchant_transaction_reference: merchantRef,
          status: "SUCCESSFUL",
        },
      }),
    });
    expect(webhook.status).toBe(200);

    // Assert straight from the DB — the webhook itself must have marked it paid.
    const { createDbClient, saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const db = createDbClient(process.env.DATABASE_URL!);
    const [row] = await db
      .select({ status: saleOrder.status, paymentStatus: saleOrder.paymentStatus })
      .from(saleOrder)
      .where(eq(saleOrder.orderNumber, merchantRef));
    expect(row.status).toBe("paid");
    expect(row.paymentStatus).toBe("paid");
  });

  it("flags an out-of-stock order as made-to-order (is_preorder) so checkout can reassure the customer", async () => {
    // Order far more than any branch on-hand → the line is out of stock, so the
    // backend makes the whole order a preorder. The create response must surface
    // that so the customer site can show the gracious "made to order" modal.
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 0,
        customer: {
          name: "Out Of Stock",
          phone: "+2348025550000",
          email: "oos@example.com",
          address: "1 Made To Order Lane",
        },
        items: [{ product_id: productId, quantity: 9999 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { is_preorder: boolean } };
    expect(body.data.is_preorder).toBe(true);
  });

  it("stores scheduled_delivery_at when the customer schedules for later", async () => {
    // scheduled_delivery_at in the request body is now ignored — the server
    // computes it authoritatively from orderSchedule. We just assert it's
    // non-null and is a parseable ISO datetime.
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
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
    // Server-derived: must be a valid ISO datetime
    expect(new Date(detailBody.data.scheduledDeliveryAt!).getTime()).toBeGreaterThan(0);
  });

  it("sale detail returns customer name, phone, email and address", async () => {
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "Ada Test",
          phone: "08099887766",
          email: "ada.test@example.com",
          address: "3 Ada Test Street",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string } };

    const detail = await fetch(`${baseUrl}/v1/branches/${branchId}/sales/${body.data.id}`, {
      headers: { cookie: cookies },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: {
        customerName: string | null;
        customerPhone: string | null;
        customerEmail: string | null;
        customerAddress: string | null;
        items: Array<{ sizeMl: number | null }>;
      };
    };
    // Items carry the variant bottle size so staff/receipts can show it.
    expect(detailBody.data.items[0]).toHaveProperty("sizeMl");
    expect(typeof detailBody.data.items[0]!.sizeMl).toBe("number");
    expect(detailBody.data.customerName).toBe("Ada Test");
    // The public-orders flow normalizes phones to international form at customer
    // creation, so the stored/returned value is +234… not the raw 0… input.
    expect(detailBody.data.customerPhone).toBe("+2348099887766");
    expect(detailBody.data.customerEmail).toBe("ada.test@example.com");
    expect(detailBody.data.customerAddress).toBe("3 Ada Test Street");
  });

  it("sale list returns customer name and phone per row", async () => {
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "List Customer",
          phone: "+2348025558888",
          email: "list@example.com",
          address: "8 List Street",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string } };

    const list = await fetch(`${baseUrl}/v1/branches/${branchId}/sales`, {
      headers: { cookie: cookies },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: Array<{ id: string; customerName: string | null; customerPhone: string | null }>;
    };
    const row = listBody.data.find((r) => r.id === body.data.id);
    expect(row).toBeDefined();
    expect(row!.customerName).toBe("List Customer");
    expect(row!.customerPhone).toBe("+2348025558888");
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

  it("tracking returns items, is_preorder, reservation_expires_at and resume_payment while unpaid", async () => {
    // The route's on-view re-verify (Task 5) would query Payaza on the GET
    // below. Stub that query to report "not found" (delegating every other URL,
    // e.g. this test's own calls to baseUrl, to the real fetch) so the order
    // stays unpaid and this test stays isolated to the tracking fields.
    const realFetch = globalThis.fetch;
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "pub_test_unpaid");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("transaction-query")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ success: false, data: null, message: "Transaction not found" }),
              { status: 400 },
            ),
          );
        }
        return realFetch(input, init);
      }),
    );

    const phone = "+2348025550012";
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "Resume Pay",
          phone,
          email: "resumepay@example.com",
          address: "11 Resume Street",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const orderBody = (await orderRes.json()) as { data: { order_number: string } };

    const track = await fetch(
      `${baseUrl}/v1/public/orders/${orderBody.data.order_number}?phone=${encodeURIComponent(phone)}`,
    );
    expect(track.status).toBe(200);
    const { data } = (await track.json()) as { data: Record<string, unknown> };

    expect(Array.isArray(data["items"])).toBe(true);
    const items = data["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toHaveProperty("name");
    expect(items[0]).toHaveProperty("size_ml");
    expect(data).toHaveProperty("is_preorder");
    expect(data).toHaveProperty("reservation_expires_at");
    expect(data["reservation_expires_at"]).not.toBeNull(); // unpaid, non-preorder → live hold
    expect(data["resume_payment"]).not.toBeNull(); // unpaid → resume config present
    const resumePayment = data["resume_payment"] as { payaza: { reference: string } };
    expect(resumePayment.payaza.reference).toBe(orderBody.data.order_number);
  });

  it("tracking re-verifies an unpaid order against Payaza on view and flips it to paid", async () => {
    // No webhook is fired here — the order is left `confirmed` with a live
    // reservation. We stub the Payaza transaction-query to report "Completed"
    // so the tracking endpoint's on-view re-verify reconciles the order to
    // paid, same as the webhook would — exercising the real verify path.
    const phone = "+2348025550013";
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "OnView Reverify",
          phone,
          email: "onviewreverify@example.com",
          address: "13 OnView Street",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const orderBody = (await orderRes.json()) as { data: { order_number: string } };

    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [before] = await db
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.orderNumber, orderBody.data.order_number));
    expect(before!.status).toBe("confirmed"); // unpaid, no webhook fired yet

    // Stub the Payaza query the on-view re-verify will make; delegate the
    // tracking request itself (to baseUrl) to the real fetch.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("transaction-query")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: { transaction_status: "Completed", transaction_reference: "PZ-ONVIEW" },
              }),
              { status: 200 },
            ),
          );
        }
        return realFetch(url as Parameters<typeof realFetch>[0], init);
      }),
    );

    const track = await fetch(
      `${baseUrl}/v1/public/orders/${orderBody.data.order_number}?phone=${encodeURIComponent(phone)}`,
    );
    expect(track.status).toBe(200);
    const trackBody = (await track.json()) as {
      data: { status: string; payment_status: string };
    };
    expect(trackBody.data.status).toBe("paid");
    expect(trackBody.data.payment_status).toBe("paid");
  });

  it("tracking returns scheduled_delivery_at and delivery_state", async () => {
    // scheduled_delivery_at is now server-derived. We assert it's non-null and
    // is a valid ISO datetime; delivery_state must still match what was sent.
    const phone = "+2348025550005";
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Outside Lagos",
        delivery_fee_ngn: 0,
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
    expect(t.data.scheduled_delivery_at).not.toBeNull();
    // Server-derived: must be a valid ISO datetime
    expect(new Date(t.data.scheduled_delivery_at!).getTime()).toBeGreaterThan(0);
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
    // The webhook below re-verifies against Payaza; stub that single query to
    // report a completed payment (delegating all other URLs to real fetch) so
    // the order reconciles to paid via the real path. afterEach unstubs.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("transaction-query")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: { transaction_status: "Completed", transaction_reference: `PZ-${uuid()}` },
              }),
              { status: 200 },
            ),
          );
        }
        return realFetch(url as Parameters<typeof realFetch>[0], init);
      }),
    );
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
    // Guard: this test assumes AUTO_DISPATCH_DELIVERY is not "true". Ensure it is
    // unset regardless of the ambient environment so the assertion is reliable.
    delete process.env["AUTO_DISPATCH_DELIVERY"];
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

  it("tracking response includes a delivery rider block when a delivery_order row exists", async () => {
    // Task 10: seed a paid online order + delivery_order with status in_transit,
    // then assert the public tracking endpoint returns the delivery block.
    const phone = "+2348025557777";
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Test zone",
        delivery_fee_ngn: 1500,
        customer: {
          name: "Rider Test",
          phone,
          email: "ridertest@example.com",
          address: "5 Rider Test Road",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const orderBody = (await orderRes.json()) as { data: { id: string; order_number: string } };
    const saleOrderId = orderBody.data.id;

    // Insert a delivery_order row directly — simulates the admin booking a rider.
    const { deliveryOrder } = await import("@ms/db");
    await db.insert(deliveryOrder).values({
      saleOrderId,
      provider: "shipbubble",
      status: "in_transit",
      pickupBranchId: branchId,
      pickupAddress: "1 Mrs Samuel Kitchen, Lagos",
      dropoffAddress: "5 Rider Test Road, Lagos",
      quotedFeeNgn: 1500,
      riderName: "Emeka Obi",
      riderPhone: "+2348033001234",
      riderVehicle: "Motorcycle",
      trackingUrl: "https://shipbubble.test/track/test-123",
    });

    const track = await fetch(
      `${baseUrl}/v1/public/orders/${orderBody.data.order_number}?phone=${encodeURIComponent(phone)}`,
    );
    expect(track.status).toBe(200);
    const trackBody = (await track.json()) as {
      data: {
        delivery: {
          status: string;
          rider_name: string | null;
          rider_phone: string | null;
          rider_vehicle: string | null;
          tracking_url: string | null;
        } | null;
      };
    };
    expect(trackBody.data.delivery).not.toBeNull();
    expect(trackBody.data.delivery!.status).toBe("in_transit");
    expect(trackBody.data.delivery!.rider_name).toBe("Emeka Obi");
    expect(trackBody.data.delivery!.tracking_url).toBe("https://shipbubble.test/track/test-123");
  });

  describe("Task 5: order creation dispatches checkout by the active provider", () => {
    async function setActiveProvider(provider: "opay" | "payaza") {
      const { appSetting, PAYMENT_PROVIDER_KEY } = await import("@ms/db");
      await db
        .insert(appSetting)
        .values({ key: PAYMENT_PROVIDER_KEY, value: { provider } })
        .onConflictDoUpdate({ target: appSetting.key, set: { value: { provider } } });
    }

    afterEach(async () => {
      // Restore the suite-wide default so later tests (if any run after this
      // block) keep exercising the payaza path they were written against.
      await setActiveProvider("payaza");
    });

    it("payment_provider=payaza: order creation returns the payaza checkout config", async () => {
      await setActiveProvider("payaza");
      const res = await fetch(`${baseUrl}/v1/public/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": uuid() },
        body: JSON.stringify({
          branch_id: branchId,
          zone_name: "Test zone",
          delivery_fee_ngn: 1500,
          customer: {
            name: "Payaza Provider",
            phone: "+2348025550020",
            email: "payazaprovider@example.com",
            address: "20 Provider Street",
          },
          items: [{ product_id: productId, quantity: 1 }],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        data: {
          order_number: string;
          payment: { provider: string; reference: string; payaza?: { reference: string } };
        };
      };
      expect(body.data.payment.provider).toBe("payaza");
      expect(body.data.payment.payaza).toBeDefined();
      expect(body.data.payment.payaza!.reference).toBe(body.data.order_number);

      // The order row itself is stamped with the provider it was created under.
      const { saleOrder } = await import("@ms/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ paymentProvider: saleOrder.paymentProvider })
        .from(saleOrder)
        .where(eq(saleOrder.orderNumber, body.data.order_number));
      expect(row!.paymentProvider).toBe("payaza");
    });

    it("payment_provider=opay: order creation returns an OPay redirect_url", async () => {
      await setActiveProvider("opay");
      vi.stubEnv("OPAY_MERCHANT_ID", "256625123456789");
      vi.stubEnv("OPAY_PUBLIC_KEY", "OPAYPUB_TEST_itest");
      vi.stubEnv("OPAY_SECRET_KEY", "OPAYPRV_TEST_itest");

      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL | Request, init?: RequestInit) => {
          if (String(url).includes("cashier/create")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "00000",
                  data: { cashierUrl: "https://sandboxcashier.opaycheckout.com/x", orderNo: "1" },
                }),
                { status: 200 },
              ),
            );
          }
          return realFetch(url as Parameters<typeof realFetch>[0], init);
        }),
      );

      const res = await fetch(`${baseUrl}/v1/public/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": uuid() },
        body: JSON.stringify({
          branch_id: branchId,
          zone_name: "Test zone",
          delivery_fee_ngn: 1500,
          customer: {
            name: "Opay Provider",
            phone: "+2348025550021",
            email: "opayprovider@example.com",
            address: "21 Provider Street",
          },
          items: [{ product_id: productId, quantity: 1 }],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        data: { order_number: string; payment: { provider: string; redirect_url?: string } };
      };
      expect(body.data.payment.provider).toBe("opay");
      expect(body.data.payment.redirect_url).toBe("https://sandboxcashier.opaycheckout.com/x");

      const { saleOrder } = await import("@ms/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ paymentProvider: saleOrder.paymentProvider })
        .from(saleOrder)
        .where(eq(saleOrder.orderNumber, body.data.order_number));
      expect(row!.paymentProvider).toBe("opay");
    });

    it("OPay webhook wake-up re-queries cashier/status and marks the order paid", async () => {
      await setActiveProvider("opay");
      vi.stubEnv("OPAY_MERCHANT_ID", "256625123456789");
      vi.stubEnv("OPAY_PUBLIC_KEY", "OPAYPUB_TEST_itest");
      vi.stubEnv("OPAY_SECRET_KEY", "OPAYPRV_TEST_itest");

      // Stub BOTH OPay endpoints: cashier/create (order placement) and
      // cashier/status (the webhook's authoritative re-query). status reports
      // SUCCESS with amount.total in kobo (naira × 100). Every other URL —
      // including this test's own calls to baseUrl — delegates to the real fetch.
      const realFetch = globalThis.fetch;
      const total = 2500; // 1 bottle @ ₦2500
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL | Request, init?: RequestInit) => {
          if (String(url).includes("cashier/create")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "00000",
                  data: { cashierUrl: "https://sandboxcashier.opaycheckout.com/y", orderNo: "2110" },
                }),
                { status: 200 },
              ),
            );
          }
          if (String(url).includes("cashier/status")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "00000",
                  message: "SUCCESSFUL",
                  data: {
                    reference: refHolder.value,
                    orderNo: "2110",
                    status: "SUCCESS",
                    amount: { total: total * 100, currency: "NGN" },
                  },
                }),
                { status: 200 },
              ),
            );
          }
          return realFetch(url as Parameters<typeof realFetch>[0], init);
        }),
      );

      // Placeholder so the status stub can echo back the created order number.
      const refHolder = { value: "" };

      const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": uuid() },
        body: JSON.stringify({
          branch_id: branchId,
          zone_name: "Test zone",
          delivery_fee_ngn: 0,
          customer: {
            name: "Opay Webhook",
            phone: "+2348025550022",
            email: "opaywebhook@example.com",
            address: "22 Webhook Street",
          },
          items: [{ product_id: productId, quantity: 1 }],
        }),
      });
      expect(orderRes.status).toBe(201);
      const orderBody = (await orderRes.json()) as { data: { order_number: string } };
      refHolder.value = orderBody.data.order_number;

      // OPay's callback is a wake-up only; the money decision comes from the
      // cashier/status re-query above. Post the minimal { reference } body.
      const webhook = await fetch(`${baseUrl}/v1/webhooks/opay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: orderBody.data.order_number }),
      });
      expect(webhook.status).toBe(200);

      // Assert straight from the DB — the webhook itself must have marked it paid
      // and stamped the payment row with the opay processor.
      const { saleOrder, payment } = await import("@ms/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ status: saleOrder.status, paymentStatus: saleOrder.paymentStatus, id: saleOrder.id })
        .from(saleOrder)
        .where(eq(saleOrder.orderNumber, orderBody.data.order_number));
      expect(row!.status).toBe("paid");
      expect(row!.paymentStatus).toBe("paid");
      const [pay] = await db
        .select({ processor: payment.processor })
        .from(payment)
        .where(eq(payment.saleOrderId, row!.id));
      expect(pay!.processor).toBe("opay");
    });

    it("resume: mints a fresh OPay cashier session for an unpaid order (correct phone)", async () => {
      await setActiveProvider("opay");
      vi.stubEnv("OPAY_MERCHANT_ID", "256625123456789");
      vi.stubEnv("OPAY_PUBLIC_KEY", "OPAYPUB_TEST_itest");
      vi.stubEnv("OPAY_SECRET_KEY", "OPAYPRV_TEST_itest");

      // Stub cashier/create for BOTH the initial order and the resume regenerate.
      const realFetch = globalThis.fetch;
      let createCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL | Request, init?: RequestInit) => {
          if (String(url).includes("cashier/create")) {
            createCalls++;
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "00000",
                  data: { cashierUrl: `https://sandboxcashier.opaycheckout.com/resume-${createCalls}`, orderNo: "3" },
                }),
                { status: 200 },
              ),
            );
          }
          return realFetch(url as Parameters<typeof realFetch>[0], init);
        }),
      );

      const phone = "+2348025550023";
      const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": uuid() },
        body: JSON.stringify({
          branch_id: branchId,
          zone_name: "Test zone",
          delivery_fee_ngn: 0,
          customer: {
            name: "Opay Resume",
            phone,
            email: "opayresume@example.com",
            address: "23 Resume Street",
          },
          items: [{ product_id: productId, quantity: 1 }],
        }),
      });
      expect(orderRes.status).toBe(201);
      const orderNumber = ((await orderRes.json()) as { data: { order_number: string } }).data.order_number;

      // Correct phone → a fresh redirect_url.
      const ok = await fetch(
        `${baseUrl}/v1/public/orders/${orderNumber}/opay-session?phone=${encodeURIComponent(phone)}`,
        { method: "POST" },
      );
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { redirect_url: string };
      expect(okBody.redirect_url).toContain("sandboxcashier.opaycheckout.com/resume-");

      // Wrong phone → 404 (no enumeration).
      const wrong = await fetch(
        `${baseUrl}/v1/public/orders/${orderNumber}/opay-session?phone=${encodeURIComponent("+2340000000000")}`,
        { method: "POST" },
      );
      expect(wrong.status).toBe(404);
    });

    it("resume: rejects a session for an order that is not awaiting payment (400)", async () => {
      await setActiveProvider("opay");
      vi.stubEnv("OPAY_MERCHANT_ID", "256625123456789");
      vi.stubEnv("OPAY_PUBLIC_KEY", "OPAYPUB_TEST_itest");
      vi.stubEnv("OPAY_SECRET_KEY", "OPAYPRV_TEST_itest");

      const realFetch = globalThis.fetch;
      const total = 2500;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL | Request, init?: RequestInit) => {
          if (String(url).includes("cashier/create")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "00000",
                  data: { cashierUrl: "https://sandboxcashier.opaycheckout.com/z", orderNo: "4" },
                }),
                { status: 200 },
              ),
            );
          }
          if (String(url).includes("cashier/status")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "00000",
                  data: { reference: paidRef.value, orderNo: "4", status: "SUCCESS", amount: { total: total * 100, currency: "NGN" } },
                }),
                { status: 200 },
              ),
            );
          }
          return realFetch(url as Parameters<typeof realFetch>[0], init);
        }),
      );
      const paidRef = { value: "" };

      const phone = "+2348025550024";
      const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": uuid() },
        body: JSON.stringify({
          branch_id: branchId,
          zone_name: "Test zone",
          delivery_fee_ngn: 0,
          customer: { name: "Opay Paid", phone, email: "opaypaid@example.com", address: "24 Paid Street" },
          items: [{ product_id: productId, quantity: 1 }],
        }),
      });
      const orderNumber = ((await orderRes.json()) as { data: { order_number: string } }).data.order_number;
      paidRef.value = orderNumber;

      // Pay it via the webhook first.
      await fetch(`${baseUrl}/v1/webhooks/opay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: orderNumber }),
      });

      // Now a resume attempt must be rejected — the order is already paid.
      const res = await fetch(
        `${baseUrl}/v1/public/orders/${orderNumber}/opay-session?phone=${encodeURIComponent(phone)}`,
        { method: "POST" },
      );
      expect(res.status).toBe(400);
    });
  });
});
