import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import {
  packagingMaterial,
  packagingStockLedger,
  packagingBalanceAt,
  factory as factoryTable,
  type createDbClient,
} from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Workstream A2b — bags move on transfers. A transfer line is a product XOR a
 * packaging material; bag lines debit the factory packaging ledger on dispatch
 * and credit the branch packaging ledger on receive.
 */
describe("transfer bag lines (A2b)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: { id: string };
  let factory: { id: string };
  let bagId: string;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  const factoryBags = (): Promise<number> =>
    packagingBalanceAt(db, { locationType: "factory", locationId: factory.id }, bagId);
  const branchBags = (): Promise<number> =>
    packagingBalanceAt(db, { locationType: "branch", locationId: branch.id }, bagId);

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
      name: "Bag Branch",
      code: "BAG",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Bag Factory" }).returning();
    factory = fac as { id: string };

    // A bag material is seeded by migration 0044.
    const [bag] = await tdb.db.select().from(packagingMaterial).where(eq(packagingMaterial.kind, "bag")).limit(1);
    if (!bag) throw new Error("no seeded bag material");
    bagId = bag.id;

    // Stock the factory with 50 bags (opening balance).
    await tdb.db.insert(packagingStockLedger).values({
      locationType: "factory",
      locationId: factory.id,
      factoryId: factory.id,
      packagingMaterialId: bagId,
      delta: 50,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  let transferId: string;

  it("dispatching a bag line debits the factory packaging ledger", async () => {
    expect(await factoryBags()).toBe(50);
    const res = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ packaging_material_id: bagId, quantity_sent: 20 }],
    });
    expect(res.status).toBe(201);
    transferId = res.body.data.id;
    expect(await factoryBags()).toBe(30); // 50 − 20 dispatched
    expect(await branchBags()).toBe(0); // not received yet
  });

  it("receiving credits the branch packaging ledger", async () => {
    await call("PATCH", `/v1/transfers/${transferId}/arrive`);
    const detail = await call<{ data: { items: Array<{ id: string; packaging_material_id: string | null }> } }>(
      "GET",
      `/v1/transfers/${transferId}`,
    );
    const line = detail.body.data.items[0]!;
    expect(line.packaging_material_id).toBe(bagId);
    const recv = await call("PATCH", `/v1/transfers/${transferId}/receive`, {
      items: [{ item_id: line.id, quantity_received: 20 }],
    });
    expect(recv.status).toBe(200);
    expect(await branchBags()).toBe(20);
  });

  it("rejects a line that names both a product and a material", async () => {
    const res = await call("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: uuid(), packaging_material_id: bagId, quantity_sent: 1 }],
    });
    // Rejected at the zod XOR refine (validation_failed → 400).
    expect([400, 422]).toContain(res.status);
  });

  it("refuses to dispatch more bags than the factory holds", async () => {
    const res = await call("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ packaging_material_id: bagId, quantity_sent: 9999 }],
    });
    expect(res.status).toBe(422);
  });
});
