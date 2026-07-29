import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import {
  stockLedger,
  stockReservation,
  saleOrder,
  saleOrderItem,
  payment,
  auditLog,
  type DbClient,
} from "@ms/db";

interface Branch { id: string; name: string }
interface Product { id: string; name: string; slug: string }
interface SaleOrder {
  id: string;
  orderNumber: string;
  status: string;
  subtotalNgn: number;
  totalNgn: number;
  paymentStatus: string;
}

/**
 * Task 4 — PATCH /branches/:branchId/sales/:id/items and .../delivery-date.
 * Editing an order's line set after confirmation, repriced from current
 * variant prices, with a manual-reconcile gate on paid orders (never an
 * automatic charge or refund) and a schedule-window guard on the date.
 */
describe("edit order items + delivery date", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: Branch;
  let factory: { id: string };
  let productA: Product;
  let productB: Product;
  let variantA: string;
  let variantB: string;
  let db: DbClient;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  async function seedProduct(name: string, slug: string, price: number): Promise<Product & { variantId: string }> {
    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name,
      slug,
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: price,
    });
    const p = pRes.body.data;
    const variantId = (p as unknown as {
      variants: Array<{ id: string; size_ml: number }>;
    }).variants.find((v) => v.size_ml === 330)!.id;
    return { ...p, variantId };
  }

  async function createPhoneOrder(variantId: string, productId: string, qty: number): Promise<SaleOrder> {
    const res = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "phone",
      items: [{ variant_id: variantId, product_id: productId, quantity: qty }],
      payment_method: "transfer",
      created_at_local: new Date().toISOString(),
    });
    return res.body.data;
  }

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

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Edit Test Branch",
      code: "ETB",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Edit Test Factory" }).returning();
    factory = fac as { id: string };

    const a = await seedProduct("Edit Sunrise", "edit-sunrise", 2500);
    const b = await seedProduct("Edit Mango", "edit-mango", 3000);
    productA = a;
    productB = b;
    variantA = a.variantId;
    variantB = b.variantId;

    // Give the factory bottles (both 330ml share the seeded 330ml material).
    const mats = await call<{ data: Array<{ id: string; size_ml: number | null }> }>(
      "GET",
      "/v1/packaging/materials",
    );
    const bottle330 = mats.body.data.find((m) => m.size_ml === 330)!;
    await call("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: bottle330.id,
      quantity: 1000,
      unit_cost_ngn: 50,
      total_cost_ngn: 50_000,
      purchase_date: "2026-05-01",
    });

    // Produce + transfer stock for both products to the branch.
    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-05-11",
      items: [
        { product_id: productA.id, variant_id: variantA, quantity_produced: 50 },
        { product_id: productB.id, variant_id: variantB, quantity_produced: 50 },
      ],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
    const xfer = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [
        { product_id: productA.id, variant_id: variantA, quantity_sent: 50 },
        { product_id: productB.id, variant_id: variantB, quantity_sent: 50 },
      ],
    });
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/arrive`);
    const detail = await call<{ data: { items: Array<{ id: string; product_id: string }> } }>(
      "GET",
      `/v1/transfers/${xfer.body.data.id}`,
    );
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/receive`, {
      items: detail.body.data.items.map((it) => ({ item_id: it.id, quantity_received: 50 })),
    });

    const today = new Date().toISOString().slice(0, 10);
    await call("POST", `/v1/branches/${branch.id}/shift-open`, { business_date: today, stock_counts: [] });
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("unpaid order: editing qty recomputes totals and adjusts the reservation", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 2); // 2 × 2500 = 5000
    expect(order.status).toBe("confirmed");
    expect(order.totalNgn).toBe(5000);

    const res = await call<{ data: { subtotalNgn: number; totalNgn: number } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/items`,
      { items: [{ productId: productA.id, variantId: variantA, quantity: 3 }] },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.subtotalNgn).toBe(7500);
    expect(res.body.data.totalNgn).toBe(7500);

    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
    expect(row?.totalNgn).toBe(7500);

    const items = await db.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, order.id));
    expect(items.length).toBe(1);
    expect(items[0]!.quantity).toBe(3);
    expect(items[0]!.lineTotalNgn).toBe(7500);

    const resv = await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order.id));
    const totalReserved = resv.reduce((s, r) => s + r.quantity, 0);
    expect(totalReserved).toBe(3);
  });

  it("unpaid order: adding a new line inserts item + reservation and reprices", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 1); // 2500
    const res = await call<{ data: { totalNgn: number } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/items`,
      {
        items: [
          { productId: productA.id, variantId: variantA, quantity: 1 },
          { productId: productB.id, variantId: variantB, quantity: 2 }, // + 6000
        ],
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.totalNgn).toBe(2500 + 6000);

    const items = await db.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, order.id));
    expect(items.length).toBe(2);
    const resv = await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order.id));
    expect(resv.length).toBe(2);
  });

  it("reconcile_needed order: editing qty updates the live reservation", async () => {
    // A reconcile_needed order still holds live reservations (set at confirmed,
    // deducted only at paid), so an edit must re-base them.
    const order = await createPhoneOrder(variantA, productA.id, 2); // confirmed, reserves 2
    await db.update(saleOrder).set({ status: "reconcile_needed" }).where(eq(saleOrder.id, order.id));

    const res = await call<{ data: { totalNgn: number } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/items`,
      { items: [{ productId: productA.id, variantId: variantA, quantity: 4 }] },
    );
    expect(res.status).toBe(200);

    const resv = await db.select().from(stockReservation).where(eq(stockReservation.saleOrderId, order.id));
    const totalReserved = resv.reduce((s, r) => s + r.quantity, 0);
    expect(totalReserved).toBe(4);
  });

  it("paid order: increasing qty beyond branch stock → 422 (not a raw 500)", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 2); // deducts 2
    await call("PATCH", `/v1/branches/${branch.id}/sales/${order.id}/pay`);

    // Increase far past anything the branch could hold. reconciled:true clears
    // the money gate, so the failure can ONLY come from the stock pre-check.
    const res = await call<{ error: { code: string; details: Record<string, unknown> } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/items`,
      { items: [{ productId: productA.id, variantId: variantA, quantity: 10000 }], reconciled: true },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.details.available).toBeDefined();
  });

  it("paid order without reconciled → 409 reconcile_required with the delta", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 2); // 5000
    await call("PATCH", `/v1/branches/${branch.id}/sales/${order.id}/pay`);

    const res = await call<{ error: { code: string; details: Record<string, unknown> } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/items`,
      { items: [{ productId: productA.id, variantId: variantA, quantity: 3 }] }, // 7500 ≠ 5000
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("reconcile_required");
    // Delta surfaced so the UI can prompt (7500 - 5000 = 2500).
    expect(res.body.error.details.delta_ngn).toBe(2500);
  });

  it("paid order with reconciled → succeeds, posts the stock-ledger delta, no refund/charge", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 2); // 5000, deducts 2
    await call("PATCH", `/v1/branches/${branch.id}/sales/${order.id}/pay`);

    const paymentsBefore = await db.select().from(payment).where(eq(payment.saleOrderId, order.id));
    expect(paymentsBefore.length).toBe(1);

    const res = await call<{ data: { totalNgn: number } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/items`,
      {
        items: [{ productId: productA.id, variantId: variantA, quantity: 1 }], // reduce → owe customer, but NO auto refund
        reconciled: true,
        reconcileNote: "customer dropped one bottle",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.totalNgn).toBe(2500);

    // A compensating ledger row restores 1 bottle to the SAME variant bucket.
    const editLedger = await db
      .select()
      .from(stockLedger)
      .where(and(eq(stockLedger.sourceId, order.id), eq(stockLedger.sourceType, "sale_cancelled")));
    expect(editLedger.length).toBe(1);
    expect(editLedger[0]!.variantId).toBe(variantA);
    expect(editLedger[0]!.delta).toBe(1); // reduced qty by 1 → restore 1

    // No new payment / refund / charge row was created.
    const paymentsAfter = await db.select().from(payment).where(eq(payment.saleOrderId, order.id));
    expect(paymentsAfter.length).toBe(1);

    // Audit written.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, order.id), eq(auditLog.action, "sale.items_edit")));
    expect(audits.length).toBe(1);
  });

  it("rejects editing a delivered order with 409", async () => {
    const { seedOnlineOrder } = await import("./helpers.js");
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "delivered", branchId: branch.id });
    const res = await call(
      "PATCH",
      `/v1/branches/${branchId}/sales/${saleId}/items`,
      { items: [{ productId: productA.id, variantId: variantA, quantity: 1 }] },
    );
    expect(res.status).toBe(409);
  });

  it("rejects editing a handed_over order with 409", async () => {
    const { seedOnlineOrder } = await import("./helpers.js");
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "handed_over", branchId: branch.id });
    const res = await call(
      "PATCH",
      `/v1/branches/${branchId}/sales/${saleId}/items`,
      { items: [{ productId: productA.id, variantId: variantA, quantity: 1 }] },
    );
    expect(res.status).toBe(409);
  });

  // ----- delivery date -----

  it("sets a future delivery date within the window", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 1);
    const when = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await call<{ data: { scheduledDeliveryAt: string } }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/delivery-date`,
      { scheduledDeliveryAt: when },
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
    expect(row?.scheduledDeliveryAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, order.id), eq(auditLog.action, "sale.delivery_date_edit")));
    expect(audits.length).toBe(1);
  });

  it("rejects a past delivery date with 422", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 1);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const res = await call(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/delivery-date`,
      { scheduledDeliveryAt: past },
    );
    expect(res.status).toBe(422);
  });

  it("rejects a too-far delivery date (> 3 months) with 422", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 1);
    const tooFar = new Date(Date.now() + 200 * 86_400_000).toISOString();
    const res = await call(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${order.id}/delivery-date`,
      { scheduledDeliveryAt: tooFar },
    );
    expect(res.status).toBe(422);
  });

  it("rejects a delivery-date edit when the path branchId does not own the order with 404", async () => {
    const order = await createPhoneOrder(variantA, productA.id, 1);
    const when = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await call(
      "PATCH",
      `/v1/branches/${uuid()}/sales/${order.id}/delivery-date`, // mismatched branch in path
      { scheduledDeliveryAt: when },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a delivery-date edit on a delivered order with 409", async () => {
    const { seedOnlineOrder } = await import("./helpers.js");
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "delivered", branchId: branch.id });
    const when = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await call(
      "PATCH",
      `/v1/branches/${branchId}/sales/${saleId}/delivery-date`,
      { scheduledDeliveryAt: when },
    );
    expect(res.status).toBe(409);
  });
});
