import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq, and } from "drizzle-orm";
import { varianceLoss } from "@ms/db";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string }
interface ProductRow { id: string; variants: Array<{ id: string; size_ml: number }> }
type StockRows = Array<{ product_id: string; variant_id: string | null; balance: number }>;

/**
 * Shift close reconciles branch on-hand to the physical count (the count is the
 * truth). A shortfall is a genuine loss recorded at retail value; an overage is
 * found stock (no loss). Shift OPEN is intentionally not reconciled.
 */
describe("shift close reconciliation", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let product: ProductRow;
  let variantId: string;

  const PRICE = 3500;

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

  async function branchQty(branchId: string): Promise<number> {
    const r = await call<{ data: StockRows }>("GET", `/v1/stock/branch/${branchId}`);
    return stockBalance(r.body.data, product.id);
  }

  /** Make a branch, stock it with `qty`, open a clean shift (count == system). */
  async function branchWithStock(code: string, qty: number): Promise<string> {
    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: `Recon ${code}`,
      code,
      delivery_zones: [],
    });
    const branchId = bRes.body.data.id;
    await call("POST", "/v1/inventory/adjust", {
      location_type: "branch",
      location_id: branchId,
      reason_code: "opening_balance",
      items: [{ product_id: product.id, variant_id: variantId, new_quantity: qty }],
    });
    const today = new Date().toISOString().slice(0, 10);
    const open = await call<{ data: { id: string } }>("POST", `/v1/branches/${branchId}/shift-open`, {
      business_date: today,
      stock_counts: [{ product_id: product.id, variant_id: variantId, counted_quantity: qty }],
    });
    if (open.status !== 201) throw new Error(`openShift failed: ${open.status} ${JSON.stringify(open.body)}`);
    return branchId;
  }

  async function close(branchId: string, counted: number, reason: string): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ data: { id: string } }>("POST", `/v1/branches/${branchId}/daily-close`, {
      business_date: today,
      cash_counted_ngn: 0,
      transfers_counted_ngn: 0,
      stock_counts: [{ product_id: product.id, variant_id: variantId, counted_quantity: counted, variance_reason: reason }],
    });
    if (res.status !== 201 && res.status !== 200) throw new Error(`close failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.id;
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const pRes = await call<{ data: ProductRow }>("POST", "/v1/products", {
      name: "Recon Sunrise",
      slug: "recon-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: PRICE,
    });
    product = pRes.body.data;
    variantId = product.variants[0]!.id;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("sets branch on-hand to the counted quantity and logs the shortfall as a loss", async () => {
    const branchId = await branchWithStock("RC1", 30);
    const closeId = await close(branchId, 25, "spillage"); // -5
    expect(await branchQty(branchId)).toBe(25);
    const losses = await db
      .select()
      .from(varianceLoss)
      .where(and(eq(varianceLoss.sourceId, closeId), eq(varianceLoss.source, "shift_close")));
    expect(losses).toHaveLength(1);
    expect(losses[0]!.quantity).toBe(5);
    expect(losses[0]!.valueNgn).toBe(5 * PRICE);
  });

  it("counts up found stock without writing a loss", async () => {
    const branchId = await branchWithStock("RC2", 30);
    const closeId = await close(branchId, 33, "miscount"); // +3
    expect(await branchQty(branchId)).toBe(33);
    const losses = await db.select().from(varianceLoss).where(eq(varianceLoss.sourceId, closeId));
    expect(losses).toHaveLength(0);
  });
});
