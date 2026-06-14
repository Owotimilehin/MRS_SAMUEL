import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Factory { id: string; name: string }

describe("packaging kind + location-aware stock", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;

  const idem = () => ({ "idempotency-key": uuid() });

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? idem() : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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

    const { factory: factoryTable } = await import("@ms/db");
    const [f] = await tdb.db.insert(factoryTable).values({ name: "Location Test Factory" }).returning();
    factory = f as Factory;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("lists materials with kind and includes the seeded bags", async () => {
    const res = await call<{ data: Array<{ id: string; name: string; kind: string }> }>(
      "GET",
      "/v1/packaging/materials",
    );
    expect(res.status).toBe(200);

    const bags = res.body.data.filter((m) => m.kind === "bag");
    expect(bags.length).toBeGreaterThanOrEqual(3);

    const bagNames = bags.map((m) => m.name);
    expect(bagNames.some((n) => /small/i.test(n))).toBe(true);
    expect(bagNames.some((n) => /medium/i.test(n))).toBe(true);
    expect(bagNames.some((n) => /large/i.test(n))).toBe(true);

    const bottles = res.body.data.filter((m) => m.kind === "bottle");
    expect(bottles.length).toBeGreaterThanOrEqual(1);
  });

  it("reports packaging balance per location", async () => {
    // Get a bag material id from the materials list
    const materialsRes = await call<{ data: Array<{ id: string; kind: string }> }>(
      "GET",
      "/v1/packaging/materials",
    );
    expect(materialsRes.status).toBe(200);
    const bagMaterial = materialsRes.body.data.find((m) => m.kind === "bag");
    expect(bagMaterial).toBeDefined();
    const bagMaterialId = bagMaterial!.id;

    // Record a purchase of 50 of that bag material at our factory
    const purchaseRes = await call<{ data: { id: string; business_expense_id: string | null } }>(
      "POST",
      "/v1/packaging/purchases",
      {
        factory_id: factory.id,
        packaging_material_id: bagMaterialId,
        quantity: 50,
        unit_cost_ngn: 200,
        total_cost_ngn: 10000,
        purchase_date: "2026-06-14",
        feed_bookkeeping: false,
      },
    );
    expect(purchaseRes.status).toBe(201);

    // Stock at factory should show balance 50 for this bag material
    const stockRes = await call<{
      data: Array<{ material_id: string; balance: number; kind: string }>;
    }>("GET", `/v1/packaging/stock?factory_id=${factory.id}`);
    expect(stockRes.status).toBe(200);
    const row = stockRes.body.data.find((d) => d.material_id === bagMaterialId);
    expect(row).toBeDefined();
    expect(row?.balance).toBe(50);
    expect(row?.kind).toBe("bag");

    // Stock at a different branch location should show balance 0
    const randomBranchId = uuid();
    const branchStockRes = await call<{
      data: Array<{ material_id: string; balance: number }>;
    }>("GET", `/v1/packaging/stock?location_type=branch&location_id=${randomBranchId}`);
    expect(branchStockRes.status).toBe(200);
    const branchRow = branchStockRes.body.data.find((d) => d.material_id === bagMaterialId);
    // Either the row is absent or balance is 0
    expect(branchRow?.balance ?? 0).toBe(0);
  });

  it("creates a material with an explicit kind", async () => {
    const createRes = await call<{ data: { id: string; kind: string } }>(
      "POST",
      "/v1/packaging/materials",
      { name: "Test Bag X", unit_label: "bag", kind: "bag" },
    );
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.kind).toBe("bag");

    // Verify it appears in the list with the correct kind
    const listRes = await call<{ data: Array<{ name: string; kind: string }> }>(
      "GET",
      "/v1/packaging/materials",
    );
    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((m) => m.name === "Test Bag X");
    expect(found).toBeDefined();
    expect(found?.kind).toBe("bag");
  });
});
