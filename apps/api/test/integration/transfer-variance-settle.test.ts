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
  let bagMaterialId: string;

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

  type BagRows = Array<{ material_id: string; balance: number }>;
  async function factoryBagQty(): Promise<number> {
    const r = await call<{ data: BagRows }>("GET", `/v1/packaging/stock?factory_id=${factory.id}`);
    return r.body.data.find((d) => d.material_id === bagMaterialId)?.balance ?? 0;
  }
  async function branchBagQty(): Promise<number> {
    const r = await call<{ data: BagRows }>(
      "GET",
      `/v1/packaging/stock?location_type=branch&location_id=${branch.id}`,
    );
    return r.body.data.find((d) => d.material_id === bagMaterialId)?.balance ?? 0;
  }

  /** Dispatch + arrive + receive a bag transfer with a variance. */
  async function variancedBagTransfer(sent: number, received: number): Promise<{ id: string; itemId: string }> {
    const created = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ packaging_material_id: bagMaterialId, quantity_sent: sent }],
    });
    const id = created.body.data.id;
    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${id}`);
    const itemId = detail.body.data.items[0]!.id;
    await call("PATCH", `/v1/transfers/${id}/arrive`);
    await call("PATCH", `/v1/transfers/${id}/receive`, {
      items: [{ item_id: itemId, quantity_received: received, variance_reason: "damaged_in_transit" }],
    });
    return { id, itemId };
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

    // A bag material with plenty of factory stock, for bag-variance settlement.
    const mats = await call<{ data: Array<{ id: string; kind: string }> }>("GET", "/v1/packaging/materials");
    bagMaterialId = mats.body.data.find((m) => m.kind === "bag")!.id;
    await call("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: bagMaterialId,
      quantity: 1000,
      unit_cost_ngn: 200,
      total_cost_ngn: 200_000,
      purchase_date: "2026-07-01",
      feed_bookkeeping: false,
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

  it("rejects an approval that leaves a varianced line unsettled (no silent loss)", async () => {
    const { id } = await variancedTransfer(100, 95); // gap = 5, unsettled
    const factoryBefore = await factoryQty();
    const branchBefore = await branchQty();
    const res = await call<{ error: { code: string; details?: { unsettled_item_ids: string[] } } }>(
      "PATCH",
      `/v1/transfers/${id}/approve`,
      { settlements: [] },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    // Nothing moved, nothing written off, and the transfer stays in review.
    expect(await factoryQty()).toBe(factoryBefore);
    expect(await branchQty()).toBe(branchBefore);
    const losses = await db.select().from(varianceLoss).where(eq(varianceLoss.sourceId, id));
    expect(losses).toHaveLength(0);
    const detail = await call<{ data: { status: string } }>("GET", `/v1/transfers/${id}`);
    expect(detail.body.data.status).toBe("received_with_variance");
  });

  it("rejects writing off an over-receive as loss", async () => {
    const { id, itemId } = await variancedTransfer(100, 110); // gap = -10 (over-receive)
    const res = await call<{ error: { code: string } }>("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "loss" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    const detail = await call<{ data: { status: string } }>("GET", `/v1/transfers/${id}`);
    expect(detail.body.data.status).toBe("received_with_variance");
  });

  it("rejects a receive that omits a transfer line (no silent stock leak)", async () => {
    // A two-line transfer where the branch submits only the first line. The
    // omitted line was debited from the factory at dispatch; if the receive is
    // allowed to complete, that stock is credited nowhere and never written off
    // — a silent leak. The receive must be rejected wholesale.
    const p2 = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Settle Second",
      slug: "settle-second",
      category: "regular",
      ingredients: ["y"],
      initial_price_ngn: PRICE,
    });
    await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "opening_balance",
      items: [{ product_id: p2.body.data.id, new_quantity: 100 }],
    });
    const created = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [
        { product_id: product.id, quantity_sent: 10 },
        { product_id: p2.body.data.id, quantity_sent: 20 },
      ],
    });
    const id = created.body.data.id;
    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${id}`);
    const firstItemId = detail.body.data.items[0]!.id;
    await call("PATCH", `/v1/transfers/${id}/arrive`);

    const res = await call<{ error: { code: string; details?: { missing_item_ids: string[] } } }>(
      "PATCH",
      `/v1/transfers/${id}/receive`,
      { items: [{ item_id: firstItemId, quantity_received: 10 }] }, // omits the second line
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    // Nothing was received — the transfer stays arrived, awaiting a full receipt.
    const after = await call<{ data: { status: string } }>("GET", `/v1/transfers/${id}`);
    expect(after.body.data.status).toBe("arrived");
  });

  it("bag variance: factory settle relocates the gap to factory bag stock", async () => {
    const { id, itemId } = await variancedBagTransfer(50, 45); // gap = 5
    const factoryBefore = await factoryBagQty();
    const branchBefore = await branchBagQty();
    const res = await call<{ data: { status: string } }>("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "factory" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("completed");
    expect(await factoryBagQty()).toBe(factoryBefore + 5);
    expect(await branchBagQty()).toBe(branchBefore); // branch keeps the 45 it received
  });

  it("bag variance: branch settle adds the gap to branch bag stock", async () => {
    const { id, itemId } = await variancedBagTransfer(50, 40); // gap = 10
    const branchBefore = await branchBagQty();
    const res = await call("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "branch" }],
    });
    expect(res.status).toBe(200);
    expect(await branchBagQty()).toBe(branchBefore + 10);
  });

  it("bag variance: loss settle records the decision but moves no bag stock and writes no valued loss", async () => {
    const { id, itemId } = await variancedBagTransfer(50, 45); // gap = 5
    const factoryBefore = await factoryBagQty();
    const branchBefore = await branchBagQty();
    const res = await call<{ data: { status: string } }>("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: itemId, settle: "loss" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("completed");
    expect(await factoryBagQty()).toBe(factoryBefore);
    expect(await branchBagQty()).toBe(branchBefore);
    // Bags are tracked-only: no product-valued variance_loss row is written.
    const losses = await db.select().from(varianceLoss).where(eq(varianceLoss.sourceId, id));
    expect(losses).toHaveLength(0);
  });

  it("rejects a bag-variance approval that leaves the bag line unsettled (no silent drop)", async () => {
    const { id } = await variancedBagTransfer(50, 45); // gap = 5, unsettled
    const factoryBefore = await factoryBagQty();
    const branchBefore = await branchBagQty();
    const res = await call<{ error: { code: string; details?: { unsettled_item_ids: string[] } } }>(
      "PATCH",
      `/v1/transfers/${id}/approve`,
      { settlements: [] },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    // Nothing moved and the transfer stays in the owner review inbox.
    expect(await factoryBagQty()).toBe(factoryBefore);
    expect(await branchBagQty()).toBe(branchBefore);
    const detail = await call<{ data: { status: string } }>("GET", `/v1/transfers/${id}`);
    expect(detail.body.data.status).toBe("received_with_variance");
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
