import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { varianceLoss } from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string }
interface Factory { id: string }
interface Product { id: string }
interface TransferDetail {
  id: string;
  items: Array<{ id: string; productId: string; quantitySent: number; quantityReceived: number | null }>;
}
type StockRows = Array<{ product_id: string; variant_id: string | null; balance: number }>;

/**
 * Owner-settled transfer variance: each varianced line settles to factory,
 * branch, or loss. Factory/branch relocate the gap (sent - received) onto that
 * location's stock; loss writes a valued variance_loss row and leaves stock as
 * received. Settlement is gated to the owner-only variance.settle capability.
 */
describe("transfer variance settlement", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let branch: Branch;
  let product: Product;

  const PRICE = 3500;

  async function call<T>(method: string, path: string, body?: unknown, cookie = cookies): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  async function factoryQty(): Promise<number> {
    const r = await call<{ data: StockRows }>("GET", `/v1/stock/factory/${factory.id}`);
    return stockBalance(r.body.data, product.id);
  }
  async function branchQty(): Promise<number> {
    const r = await call<{ data: StockRows }>("GET", `/v1/stock/branch/${branch.id}`);
    return stockBalance(r.body.data, product.id);
  }

  /** Dispatch + arrive + receive a transfer, returning ids. received != sent puts it in received_with_variance. */
  async function variancedTransfer(sent: number, received: number): Promise<{ id: string; itemId: string }> {
    const created = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: sent }],
    });
    const id = created.body.data.id;
    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${id}`);
    const itemId = detail.body.data.items[0]!.id;
    await call("PATCH", `/v1/transfers/${id}/arrive`);
    await call("PATCH", `/v1/transfers/${id}/receive`, {
      items: [{ item_id: itemId, quantity_received: received, variance_reason: "short_shipped" }],
    });
    return { id, itemId };
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

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Settle Branch",
      code: "STL",
      delivery_zones: [{ name: "z", fee_ngn: 100 }],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Settle Factory" }).returning();
    factory = fac as Factory;

    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Settle Sunrise",
      slug: "settle-sunrise",
      category: "regular",
      ingredients: ["x"],
      initial_price_ngn: PRICE,
    });
    product = pRes.body.data;

    // Plenty of factory stock to dispatch across several test transfers.
    await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "opening_balance",
      items: [{ product_id: product.id, new_quantity: 1000 }],
    });
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("factory settle returns the gap to factory stock and writes no loss", async () => {
    const { id, itemId } = await variancedTransfer(100, 95); // gap = 5
    const factoryBefore = await factoryQty();
    const res = await call<{ data: { status: string } }>("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "factory" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("completed");
    expect(await factoryQty()).toBe(factoryBefore + 5);
    const losses = await db.select().from(varianceLoss).where(eq(varianceLoss.sourceId, id));
    expect(losses).toHaveLength(0);
  });

  it("branch settle adds the gap to branch stock", async () => {
    const { id, itemId } = await variancedTransfer(100, 90); // gap = 10
    const branchBefore = await branchQty();
    const res = await call("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "branch" }],
    });
    expect(res.status).toBe(200);
    expect(await branchQty()).toBe(branchBefore + 10);
  });

  it("loss settle writes a valued loss row and leaves stock as received", async () => {
    const { id, itemId } = await variancedTransfer(100, 95); // gap = 5
    const factoryBefore = await factoryQty();
    const branchBefore = await branchQty();
    const res = await call("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "loss" }],
    });
    expect(res.status).toBe(200);
    expect(await factoryQty()).toBe(factoryBefore);
    expect(await branchQty()).toBe(branchBefore);
    const losses = await db.select().from(varianceLoss).where(eq(varianceLoss.sourceId, id));
    expect(losses).toHaveLength(1);
    expect(losses[0]!.quantity).toBe(5);
    expect(losses[0]!.valueNgn).toBe(5 * PRICE);
    expect(losses[0]!.source).toBe("transfer");
  });

  it("rejects a non-owner (manager)", async () => {
    const { id, itemId } = await variancedTransfer(100, 95);
    await seedUser(db, { email: "manager@example.com", role: "manager", password: "managerpass123" });
    const managerCookies = await loginAs(baseUrl, "manager@example.com", "managerpass123");
    const res = await call(
      "PATCH",
      `/v1/transfers/${id}/approve`,
      { settlements: [{ item_id: itemId, settle: "factory" }] },
      managerCookies,
    );
    expect(res.status).toBe(403);
  });
});
