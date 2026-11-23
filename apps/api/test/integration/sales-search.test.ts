import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface Product { id: string; name: string; slug: string }
interface SaleOrder { id: string; orderNumber: string; branchId: string }

/**
 * GET /v1/branches/:branchId/sales?q= finds a sale by its SO-… order number
 * (or the tail of it) or by the short receipt code a till prints before the
 * sale syncs ("R-" + first 8 hex of the client-generated sale id). The search
 * stays scoped to the branch in the URL and rejects anything that isn't one of
 * those two shapes.
 */
describe("branch sales search (q)", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchA: Branch;
  let branchB: Branch;
  let product: Product;
  let sale: SaleOrder;
  const saleId = uuid();

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
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

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

    branchA = (await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Search Branch A",
      code: "SBA",
      delivery_zones: [],
    })).body.data;
    branchB = (await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Search Branch B",
      code: "SBB",
      delivery_zones: [],
    })).body.data;

    product = (await call<{ data: Product }>("POST", "/v1/products", {
      name: "Search Test Sunrise",
      slug: "search-test-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    })).body.data;

    // A preorder needs no stock, so no production/transfer setup is required.
    // The owner is exempt from the open-shift gate. The client supplies the id,
    // exactly as the offline till does.
    const created = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branchA.id}/sales`, {
      id: saleId,
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "transfer",
      is_preorder: true,
      scheduled_delivery_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      created_at_local: new Date().toISOString(),
    });
    expect(created.status).toBe(201);
    sale = created.body.data;
    expect(sale.id).toBe(saleId);
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  const receiptCode = (): string => `R-${saleId.slice(0, 8).toUpperCase()}`;

  it("finds the sale by its full order number", async () => {
    const res = await call<{ data: SaleOrder[] }>(
      "GET",
      `/v1/branches/${branchA.id}/sales?q=${encodeURIComponent(sale.orderNumber)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id)).toEqual([saleId]);
  });

  it("finds the sale by the tail of its order number", async () => {
    const tail = sale.orderNumber.split("-").pop()!;
    const res = await call<{ data: SaleOrder[] }>("GET", `/v1/branches/${branchA.id}/sales?q=${tail}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id)).toContain(saleId);
  });

  it("finds the sale by its receipt code, with or without the dash, any case", async () => {
    for (const q of [receiptCode(), receiptCode().replace("-", ""), receiptCode().toLowerCase()]) {
      const res = await call<{ data: SaleOrder[] }>(
        "GET",
        `/v1/branches/${branchA.id}/sales?q=${encodeURIComponent(q)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((s) => s.id)).toEqual([saleId]);
    }
  });

  it("stays scoped to the branch in the URL", async () => {
    const res = await call<{ data: SaleOrder[] }>(
      "GET",
      `/v1/branches/${branchB.id}/sales?q=${encodeURIComponent(receiptCode())}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("rejects wildcards and other junk with 400", async () => {
    for (const q of ["%", "SO_2026", "a'b", "R-12345"]) {
      const res = await call<{ error: { code: string } }>(
        "GET",
        `/v1/branches/${branchA.id}/sales?q=${encodeURIComponent(q)}`,
      );
      // "R-12345" is not a receipt code, but it is a valid order-number term
      // (letters, digits, dashes) — it just matches nothing.
      if (q === "R-12345") {
        expect(res.status).toBe(200);
        expect((res.body as unknown as { data: unknown[] }).data).toEqual([]);
      } else {
        expect(res.status).toBe(400);
      }
    }
  });

  it("without q still lists the branch's sales", async () => {
    const res = await call<{ data: SaleOrder[] }>("GET", `/v1/branches/${branchA.id}/sales`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id)).toContain(saleId);
  });
});
