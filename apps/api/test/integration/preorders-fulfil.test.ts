import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { productVariant, stockLedger, type createDbClient } from "@ms/db";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Workstream D Tasks 3 + 4 — payment without deduction, queue + fulfilment.
 * Drives the in-store (admin POS) path: a preorder reaches `paid` without
 * moving stock; the Preorders queue lists it; `fulfil` deducts stock then,
 * blocks when stock is short, and is idempotent against a double-fulfil.
 */
interface SaleOrder {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
  isPreorder: boolean;
  fulfilledAt: string | null;
}

describe("preorders: pay-without-deduct + queue + fulfil", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: { id: string };
  let product: { id: string };

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
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

  async function branchBalance(): Promise<number> {
    const res = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    return stockBalance(res.body.data, product.id);
  }

  // Seed branch stock directly into the ledger. We bypass the production-run
  // pipeline on purpose: it hard-blocks a flavour whose variant has no linked
  // bottle material (the A1 guard), which these freshly-created test products do.
  async function stockBranch(qty: number): Promise<void> {
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branch.id,
      productId: product.id,
      delta: qty,
      sourceType: "adjustment",
      sourceId: uuid(),
      note: "Test seed — stock for preorder fulfilment",
    });
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

    const bRes = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: "Preorder Branch",
      code: "PREF",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const pRes = await call<{ data: { id: string } }>("POST", "/v1/products", {
      name: "Lemon Sip",
      slug: "lemon-sip-fulfil",
      category: "regular",
      ingredients: ["Lemon"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;

    // Make this product's variant preorder-only (made-to-order).
    await db.update(productVariant).set({ preorderOnly: true }).where(eq(productVariant.productId, product.id));
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  let orderId: string;

  it("POS confirm of a preorder_only item with 0 stock → 201 + is_preorder (no 422)", async () => {
    expect(await branchBalance()).toBe(0);
    const confirm = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 3 }],
      payment_method: "cash",
      created_at_local: new Date().toISOString(),
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.data.status).toBe("confirmed");
    expect(confirm.body.data.isPreorder).toBe(true);
    orderId = confirm.body.data.id;
  });

  it("paying a preorder reaches paid WITHOUT deducting stock", async () => {
    const pay = await call<{ data: SaleOrder }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${orderId}/pay`,
    );
    expect(pay.status).toBe(200);
    expect(pay.body.data.status).toBe("paid");
    expect(await branchBalance()).toBe(0); // no stock moved by payment
  });

  it("the paid preorder shows in the queue", async () => {
    const q = await call<{ data: Array<{ id: string; items: unknown[] }> }>("GET", "/v1/preorders");
    expect(q.status).toBe(200);
    const row = q.body.data.find((r) => r.id === orderId);
    expect(row).toBeDefined();
    expect(row!.items.length).toBe(1);
  });

  it("fulfilling with no stock is blocked (422)", async () => {
    const res = await call("PATCH", `/v1/preorders/${orderId}/fulfil`);
    expect(res.status).toBe(422);
  });

  it("fulfilling once stock exists deducts stock and hands over", async () => {
    await stockBranch(5);
    expect(await branchBalance()).toBe(5);

    const res = await call<{ data: SaleOrder }>("PATCH", `/v1/preorders/${orderId}/fulfil`);
    expect(res.status).toBe(200);
    expect(res.body.data.fulfilledAt).not.toBeNull();
    expect(res.body.data.status).toBe("handed_over");
    expect(await branchBalance()).toBe(2); // 5 − 3 deducted at fulfilment

    const q = await call<{ data: Array<{ id: string }> }>("GET", "/v1/preorders");
    expect(q.body.data.some((r) => r.id === orderId)).toBe(false);
  });

  it("a second fulfil attempt is a 409 conflict", async () => {
    const res = await call("PATCH", `/v1/preorders/${orderId}/fulfil`);
    expect(res.status).toBe(409);
  });

  it("a POS preorder registers its fulfilment date and shows it in the queue", async () => {
    const fulfilBy = "2026-07-01T12:00:00.000Z";
    const confirm = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      scheduled_delivery_at: fulfilBy,
      created_at_local: new Date().toISOString(),
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.data.isPreorder).toBe(true);
    await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);

    const q = await call<{ data: Array<{ id: string; scheduled_delivery_at: string | null }> }>(
      "GET",
      "/v1/preorders",
    );
    const row = q.body.data.find((r) => r.id === confirm.body.data.id);
    expect(row).toBeDefined();
    expect(row!.scheduled_delivery_at).not.toBeNull();
    expect(new Date(row!.scheduled_delivery_at as string).toISOString()).toBe(fulfilBy);
  });
});
