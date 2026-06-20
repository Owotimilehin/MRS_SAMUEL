import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Admin delivery endpoints — GET options / POST book / POST cancel.
 *
 * Uses the mock Bolt provider (DELIVERY_PROVIDER unset → BoltMockProvider).
 * The branch is created with an address so the pickup-branch check passes.
 * The order is placed with a customer who has phone + address so the
 * delivery-address check in load() passes.
 */
describe("admin delivery endpoints (mock provider)", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchId: string;
  let saleId: string;

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

    // Create a branch WITH an address so the load() pickup-branch check passes.
    const bRes = await fetch(`${baseUrl}/v1/branches`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        name: "Delivery Test Branch",
        code: "DLTB",
        address: "23 Allen Avenue, Ikeja, Lagos",
        delivery_zones: [{ name: "Lagos Island", fee_ngn: 1500 }],
      }),
    });
    branchId = ((await bRes.json()) as { data: { id: string } }).data.id;

    // Set up inventory so the order can actually be placed.
    const { factory } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factory).values({ name: "Delivery Test Factory" }).returning();
    if (!fac) throw new Error("factory insert failed");
    const factoryId = fac.id;

    const pRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        name: "Delivery Sunrise",
        slug: "delivery-sunrise",
        category: "regular",
        initial_price_ngn: 2500,
      }),
    });
    const pData = ((await pRes.json()) as {
      data: { id: string; variants: Array<{ id: string; size_ml: number }> };
    }).data;
    const productId = pData.id;
    const variantId = pData.variants.find((v) => v.size_ml === 330)!.id;

    // Purchase bottles at the factory.
    const matsRes = await fetch(`${baseUrl}/v1/packaging/materials`, {
      headers: { cookie: cookies },
    });
    const mats = ((await matsRes.json()) as {
      data: Array<{ id: string; size_ml: number | null }>;
    }).data;
    const bottle330 = mats.find((m) => m.size_ml === 330)!;
    await fetch(`${baseUrl}/v1/packaging/purchases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        factory_id: factoryId,
        packaging_material_id: bottle330.id,
        quantity: 100,
        unit_cost_ngn: 50,
        total_cost_ngn: 5000,
        purchase_date: "2026-06-01",
      }),
    });

    // Produce 10 units and transfer to branch.
    const run = await fetch(`${baseUrl}/v1/production-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        factory_id: factoryId,
        run_date: "2026-06-01",
        items: [{ product_id: productId, variant_id: variantId, quantity_produced: 10 }],
      }),
    });
    const runId = ((await run.json()) as { data: { id: string } }).data.id;
    await fetch(`${baseUrl}/v1/production-runs/${runId}/complete`, {
      method: "PATCH",
      headers: { cookie: cookies, "idempotency-key": uuid() },
    });

    const xf = await fetch(`${baseUrl}/v1/transfers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        factory_id: factoryId,
        branch_id: branchId,
        items: [{ product_id: productId, variant_id: variantId, quantity_sent: 10 }],
      }),
    });
    const xfId = ((await xf.json()) as { data: { id: string } }).data.id;
    await fetch(`${baseUrl}/v1/transfers/${xfId}/arrive`, {
      method: "PATCH",
      headers: { cookie: cookies, "idempotency-key": uuid() },
    });
    const detail = await fetch(`${baseUrl}/v1/transfers/${xfId}`, {
      headers: { cookie: cookies },
    });
    const detailBody = (await detail.json()) as { data: { items: Array<{ id: string }> } };
    await fetch(`${baseUrl}/v1/transfers/${xfId}/receive`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        items: [{ item_id: detailBody.data.items[0]!.id, quantity_received: 10 }],
      }),
    });

    // Place an online order with a customer that has name + phone + address.
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        zone_name: "Lagos Island",
        delivery_fee_ngn: 1500,
        customer: {
          name: "Ada Test",
          phone: "08099887766",
          email: "ada.delivery@example.com",
          address: "12 Allen Ave, Ikeja, Lagos",
        },
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const orderBody = (await orderRes.json()) as { data: { id: string } };
    saleId = orderBody.data.id;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("GET options returns at least one courier", async () => {
    const res = await fetch(
      `${baseUrl}/v1/branches/${branchId}/sales/${saleId}/delivery/options`,
      { headers: { cookie: cookies } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { options: Array<{ id: string; fee_ngn: number }> };
    };
    expect(Array.isArray(body.data.options)).toBe(true);
    expect(body.data.options.length).toBeGreaterThan(0);
    expect(body.data.options[0]).toHaveProperty("id");
    expect(body.data.options[0]).toHaveProperty("fee_ngn");
  });

  it("POST book creates a delivery_order and is idempotent (409 on second call)", async () => {
    // First, fetch options to get a valid option id + fee.
    const optRes = await fetch(
      `${baseUrl}/v1/branches/${branchId}/sales/${saleId}/delivery/options`,
      { headers: { cookie: cookies } },
    );
    expect(optRes.status).toBe(200);
    const optBody = (await optRes.json()) as {
      data: { options: Array<{ id: string; fee_ngn: number }> };
    };
    const opt = optBody.data.options[0]!;

    // Book the delivery.
    const book = await fetch(
      `${baseUrl}/v1/branches/${branchId}/sales/${saleId}/delivery/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookies,
          "idempotency-key": uuid(),
        },
        body: JSON.stringify({ option_id: opt.id, fee_ngn: opt.fee_ngn }),
      },
    );
    expect(book.status).toBe(200);
    const bookBody = (await book.json()) as { data: { externalRef: string } };
    expect(bookBody.data.externalRef).toBeTruthy();

    // Second book for same order must be 409.
    const again = await fetch(
      `${baseUrl}/v1/branches/${branchId}/sales/${saleId}/delivery/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookies,
          "idempotency-key": uuid(),
        },
        body: JSON.stringify({ option_id: opt.id, fee_ngn: opt.fee_ngn }),
      },
    );
    expect(again.status).toBe(409);
  });

  it("POST cancel marks the delivery as cancelled", async () => {
    const cancel = await fetch(
      `${baseUrl}/v1/branches/${branchId}/sales/${saleId}/delivery/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookies,
          "idempotency-key": uuid(),
        },
      },
    );
    expect(cancel.status).toBe(200);
    const cancelBody = (await cancel.json()) as { data: { status: string } };
    expect(cancelBody.data.status).toBe("cancelled");
  });
});
