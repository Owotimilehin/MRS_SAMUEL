import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import {
  productVariant,
  stockLedger,
  packagingMaterial,
  packagingStockLedger,
  packagingBalanceAt,
  type createDbClient,
} from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Workstream A2c — bags at the POS. A sale can carry bags; they are recorded
 * against the order and decremented from BRANCH bag stock at pay, but never
 * block a sale (warn-but-allow → branch bag balance may go negative).
 */
describe("POS bag consumption (A2c)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: { id: string };
  let product: { id: string };
  let bagA: string;
  let bagB: string;

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

  const branchBag = (id: string): Promise<number> =>
    packagingBalanceAt(db, { locationType: "branch", locationId: branch.id }, id);

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
      name: "Bag POS Branch",
      code: "BPOS",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const pRes = await call<{ data: { id: string } }>("POST", "/v1/products", {
      name: "Mango Tango",
      slug: "mango-tango-bag",
      category: "regular",
      ingredients: ["Mango"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;

    // Ensure a normal (non-preorder) sale: variant not preorder_only + branch stock.
    await db.update(productVariant).set({ preorderOnly: false }).where(eq(productVariant.productId, product.id));
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branch.id,
      productId: product.id,
      delta: 20,
      sourceType: "adjustment",
      sourceId: uuid(),
      note: "seed juice",
    });

    const bags = await db.select().from(packagingMaterial).where(eq(packagingMaterial.kind, "bag"));
    bagA = bags[0]!.id;
    bagB = bags[1]!.id;

    // Stock 5 of bagA at the branch; bagB intentionally left at 0.
    await db.insert(packagingStockLedger).values({
      locationType: "branch",
      locationId: branch.id,
      packagingMaterialId: bagA,
      delta: 5,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });

    // Open a shift so the sale-creation gate is satisfied.
    const today = new Date().toISOString().slice(0, 10);
    const shiftRes = await call("POST", `/v1/branches/${branch.id}/shift-open`, {
      business_date: today,
      stock_counts: [],
    });
    if ((shiftRes as { status: number }).status !== 201) {
      throw new Error(`shift-open failed in pos-bag setup: ${JSON.stringify(shiftRes)}`);
    }
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("records bags on the sale and decrements branch bag stock at pay", async () => {
    expect(await branchBag(bagA)).toBe(5);
    const confirm = await call<{ data: { id: string } }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      packaging: [{ packaging_material_id: bagA, quantity: 2 }],
      created_at_local: new Date().toISOString(),
    });
    expect(confirm.status).toBe(201);
    // Not consumed until pay.
    expect(await branchBag(bagA)).toBe(5);

    const pay = await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    expect(pay.status).toBe(200);
    expect(await branchBag(bagA)).toBe(3); // 5 − 2
  });

  it("allows a bag the branch has none of (warn-but-allow → goes negative)", async () => {
    expect(await branchBag(bagB)).toBe(0);
    const confirm = await call<{ data: { id: string } }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      packaging: [{ packaging_material_id: bagB, quantity: 2 }],
      created_at_local: new Date().toISOString(),
    });
    expect(confirm.status).toBe(201);
    const pay = await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    expect(pay.status).toBe(200); // not blocked
    expect(await branchBag(bagB)).toBe(-2); // branch bag stock went negative
  });

  it("a plain sale with no bags still works", async () => {
    const confirm = await call<{ data: { id: string } }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      created_at_local: new Date().toISOString(),
    });
    expect(confirm.status).toBe(201);
    const pay = await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    expect(pay.status).toBe(200);
  });

  it("GET /bags lists bag sizes with this branch's on-hand counts", async () => {
    const res = await call<{ data: Array<{ material_id: string; name: string; balance: number }> }>(
      "GET",
      `/v1/branches/${branch.id}/sales/bags`,
    );
    expect(res.status).toBe(200);
    const a = res.body.data.find((row) => row.material_id === bagA);
    const b = res.body.data.find((row) => row.material_id === bagB);
    expect(a?.balance).toBe(3); // 5 − 2 consumed earlier
    expect(b?.balance).toBe(-2); // went negative (warn-but-allow)
  });

  it("branch_staff (pos.sell, no packaging.view) can read bag stock for the POS", async () => {
    await seedUser(db, { email: "till@example.com", role: "branch_staff", branchId: branch.id });
    const staffCookies = await loginAs(baseUrl, "till@example.com", "userpassword123");
    const res = await fetch(`${baseUrl}/v1/branches/${branch.id}/sales/bags`, {
      headers: { cookie: staffCookies },
    });
    expect(res.status).toBe(200);
  });
});
