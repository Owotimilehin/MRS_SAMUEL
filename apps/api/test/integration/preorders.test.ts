import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Workstream D Task 2 — Preorder-aware order creation.
 *
 * Rules under test:
 *  - A line whose variant has `preorder_only=true` OR whose branch stock is 0
 *    makes the WHOLE order a preorder: `is_preorder=true`, no stock_reservation.
 *  - An in-stock normal order (no preorder_only, stock >= qty) behaves exactly
 *    as before: `is_preorder=false`, a stock_reservation row exists.
 *
 * Stock is seeded directly via `stock_ledger` rows to avoid the production-run
 * pipeline (which requires variant + bottle material from migration 0032+).
 */
describe("Preorder-aware order creation", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchId: string;
  /** Product whose 330ml variant will be flagged preorder_only */
  let preorderProductId: string;
  /** Variant id of the preorder_only variant */
  let preorderVariantId: string;
  /** Product whose variants are NOT preorder_only but branch has 0 stock */
  let noStockProductId: string;
  /** Variant id of the no-stock variant */
  let noStockVariantId: string;
  /** Product with real stock — standard path */
  let inStockProductId: string;
  /** Variant id of the in-stock product */
  let inStockVariantId: string;

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

    // Create a branch (no delivery zones needed — delivery_fee_ngn stays 0).
    const bRes = await fetch(`${baseUrl}/v1/branches`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({ name: "Preorder Branch", code: "PRB" }),
    });
    branchId = ((await bRes.json()) as { data: { id: string } }).data.id;

    const { productVariant, stockLedger } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");

    // ── Product A: preorder_only ──────────────────────────────────────────
    const pARes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "Preorder Sunrise",
        slug: "preorder-sunrise",
        category: "regular",
        initial_price_ngn: 1800,
      }),
    });
    preorderProductId = ((await pARes.json()) as { data: { id: string } }).data.id;

    // The API creates a default variant. Grab it and flip preorder_only=true.
    const [varA] = await tdb.db
      .select()
      .from(productVariant)
      .where(eq(productVariant.productId, preorderProductId));
    if (!varA) throw new Error("variant A not found");
    preorderVariantId = varA.id;
    await tdb.db
      .update(productVariant)
      .set({ preorderOnly: true })
      .where(eq(productVariant.id, preorderVariantId));
    // No stock — branch has 0 for this product.

    // ── Product B: NOT preorder_only, 0 branch stock ──────────────────────
    const pBRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "No Stock Mango",
        slug: "no-stock-mango",
        category: "regular",
        initial_price_ngn: 2200,
      }),
    });
    noStockProductId = ((await pBRes.json()) as { data: { id: string } }).data.id;

    const [varB] = await tdb.db
      .select()
      .from(productVariant)
      .where(eq(productVariant.productId, noStockProductId));
    if (!varB) throw new Error("variant B not found");
    noStockVariantId = varB.id;
    // preorder_only stays false; stock stays at 0.

    // ── Product C: in-stock normal product ────────────────────────────────
    const pCRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "In Stock Guava",
        slug: "in-stock-guava",
        category: "regular",
        initial_price_ngn: 2500,
      }),
    });
    inStockProductId = ((await pCRes.json()) as { data: { id: string } }).data.id;

    const [varC] = await tdb.db
      .select()
      .from(productVariant)
      .where(eq(productVariant.productId, inStockProductId));
    if (!varC) throw new Error("variant C not found");
    inStockVariantId = varC.id;

    // Seed 10 bottles directly into the branch stock_ledger.
    // This bypasses the production-run pipeline (which requires bottle materials
    // from migration 0032+) while still exercising the real availability query.
    await tdb.db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branchId,
      productId: inStockProductId,
      variantId: inStockVariantId,
      delta: 10,
      sourceType: "adjustment",
      sourceId: inStockProductId, // arbitrary stable UUID
      note: "Test seed — in-stock product for preorder tests",
    });
  }, 90_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  // ── (a) preorder_only variant with 0 stock ────────────────────────────────
  it("(a) preorder_only variant with 0 stock places an order (not 422)", async () => {
    const { saleOrder, stockReservation } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");

    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        customer: {
          name: "Preorder Customer",
          phone: "+2348031110001",
          address: "1 Preorder Lane",
        },
        items: [{ variant_id: preorderVariantId, product_id: preorderProductId, quantity: 1 }],
      }),
    });

    expect(res.status, "should be 201 not 422 for preorder_only variant").toBe(201);
    const body = (await res.json()) as { data: { id: string; order_number: string } };

    // Fetch the sale_order row and assert is_preorder = true
    const [order] = await db.select().from(saleOrder).where(eq(saleOrder.id, body.data.id));
    expect(order, "order row must exist").toBeDefined();
    expect(order!.isPreorder, "is_preorder must be true for preorder_only variant").toBe(true);

    // Assert NO stock_reservation row was created
    const reservations = await db
      .select()
      .from(stockReservation)
      .where(eq(stockReservation.saleOrderId, body.data.id));
    expect(reservations.length, "preorder must have no stock reservations").toBe(0);
  });

  // ── (b) out-of-stock normal item becomes a preorder ───────────────────────
  it("(b) out-of-stock normal item becomes a preorder (not 422)", async () => {
    const { saleOrder, stockReservation } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");

    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        customer: {
          name: "No Stock Customer",
          phone: "+2348031110002",
          address: "2 Empty Stock Road",
        },
        items: [{ variant_id: noStockVariantId, product_id: noStockProductId, quantity: 1 }],
      }),
    });

    expect(res.status, "should be 201 not 422 for out-of-stock item").toBe(201);
    const body = (await res.json()) as { data: { id: string; order_number: string } };

    const [order] = await db.select().from(saleOrder).where(eq(saleOrder.id, body.data.id));
    expect(order, "order row must exist").toBeDefined();
    expect(order!.isPreorder, "is_preorder must be true for out-of-stock item").toBe(true);

    const reservations = await db
      .select()
      .from(stockReservation)
      .where(eq(stockReservation.saleOrderId, body.data.id));
    expect(reservations.length, "out-of-stock preorder must have no reservations").toBe(0);
  });

  // ── (c) in-stock normal order: NOT a preorder, DOES reserve ──────────────
  it("(c) in-stock normal order is NOT a preorder and DOES create a reservation", async () => {
    const { saleOrder, stockReservation } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");

    const res = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        customer: {
          name: "Normal Customer",
          phone: "+2348031110003",
          address: "3 In Stock Avenue",
        },
        items: [{ variant_id: inStockVariantId, product_id: inStockProductId, quantity: 2 }],
      }),
    });

    expect(res.status, "in-stock order should be 201").toBe(201);
    const body = (await res.json()) as { data: { id: string; order_number: string } };

    const [order] = await db.select().from(saleOrder).where(eq(saleOrder.id, body.data.id));
    expect(order, "order row must exist").toBeDefined();
    expect(order!.isPreorder, "in-stock order must NOT be a preorder").toBe(false);

    const reservations = await db
      .select()
      .from(stockReservation)
      .where(eq(stockReservation.saleOrderId, body.data.id));
    expect(reservations.length, "in-stock order must have at least one reservation").toBeGreaterThan(0);
  });
});
