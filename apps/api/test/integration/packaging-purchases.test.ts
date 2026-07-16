import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Factory { id: string; name: string }

describe("packaging purchases + materials", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let materialId: string;

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
    const [f] = await tdb.db.insert(factoryTable).values({ name: "Pkg Factory" }).returning();
    factory = f as Factory;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("owner creates a material", async () => {
    const res = await call<{ data: { id: string; name: string } }>("POST", "/v1/packaging/materials", {
      name: "330ml glass bottle",
      unit_label: "bottle",
      size_ml: 330,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("330ml glass bottle");
    materialId = res.body.data.id;
  });

  it("records a purchase with feed_bookkeeping=true → creates business_expense", async () => {
    const res = await call<{ data: { id: string; business_expense_id: string | null } }>(
      "POST",
      "/v1/packaging/purchases",
      {
        factory_id: factory.id,
        packaging_material_id: materialId,
        quantity: 5000,
        unit_cost_ngn: 40,
        total_cost_ngn: 200000,
        supplier_name: "Glass Co.",
        purchase_date: "2026-06-05",
        feed_bookkeeping: true,
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.business_expense_id).not.toBeNull();
  });

  it("records a purchase with feed_bookkeeping=false → no business_expense", async () => {
    const res = await call<{ data: { business_expense_id: string | null } }>(
      "POST",
      "/v1/packaging/purchases",
      {
        factory_id: factory.id,
        packaging_material_id: materialId,
        quantity: 1000,
        unit_cost_ngn: 40,
        total_cost_ngn: 40000,
        purchase_date: "2026-06-05",
        feed_bookkeeping: false,
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.business_expense_id).toBeNull();
  });

  it("rejects mismatched total_cost_ngn", async () => {
    const res = await call("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: materialId,
      quantity: 100,
      unit_cost_ngn: 40,
      total_cost_ngn: 5000,
      purchase_date: "2026-06-05",
    });
    expect(res.status).toBe(400);
  });

  it("stock endpoint returns balance reflecting both purchases", async () => {
    const res = await call<{
      data: Array<{ material_id: string; balance: number; recent_unit_cost_ngn: number | null }>;
    }>("GET", `/v1/packaging/stock?factory_id=${factory.id}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((d) => d.material_id === materialId);
    expect(row?.balance).toBe(6000);
    expect(row?.recent_unit_cost_ngn).toBe(40);
  });

  it("ledger endpoint returns two purchase rows", async () => {
    const res = await call<{ data: Array<{ source_type: string; delta: number }> }>(
      "GET",
      `/v1/packaging/ledger?factory_id=${factory.id}&material_id=${materialId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data.every((r) => r.source_type === "purchase")).toBe(true);
  });

  it("edits a material", async () => {
    const res = await call<{ data: { name: string } }>("PATCH", `/v1/packaging/materials/${materialId}`, {
      name: "330ml glass bottle (clear)",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toContain("clear");
  });

  it("edits a purchase's unit cost + quantity, keeping stock and total in step", async () => {
    // Fresh material so this doesn't disturb the shared-balance assertions above.
    const mat = await call<{ data: { id: string } }>("POST", "/v1/packaging/materials", {
      name: "650ml edit bottle",
      unit_label: "bottle",
      size_ml: 650,
    });
    const editMatId = mat.body.data.id;
    // Enter it wrong (100 @ ₦15), like the real ₦15 typo.
    const created = await call<{ data: { id: string } }>("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: editMatId,
      quantity: 100,
      unit_cost_ngn: 15,
      total_cost_ngn: 1500,
      purchase_date: "2026-07-06",
      feed_bookkeeping: true,
    });
    const purchaseId = created.body.data.id;

    const before = await call<{ data: Array<{ material_id: string; balance: number }> }>(
      "GET",
      `/v1/packaging/stock?factory_id=${factory.id}`,
    );
    expect(before.body.data.find((d) => d.material_id === editMatId)?.balance).toBe(100);

    // Correct it: 120 @ ₦550.
    const edit = await call<{ data: { quantity: number; unit_cost_ngn: number; total_cost_ngn: number } }>(
      "PATCH",
      `/v1/packaging/purchases/${purchaseId}`,
      { quantity: 120, unit_cost_ngn: 550 },
    );
    expect(edit.status).toBe(200);
    expect(edit.body.data.quantity).toBe(120);
    expect(edit.body.data.unit_cost_ngn).toBe(550);
    expect(edit.body.data.total_cost_ngn).toBe(66000);

    // Factory stock reflects the +20 correction and the latest unit cost.
    const after = await call<{
      data: Array<{ material_id: string; balance: number; recent_unit_cost_ngn: number | null }>;
    }>("GET", `/v1/packaging/stock?factory_id=${factory.id}`);
    const row = after.body.data.find((d) => d.material_id === editMatId);
    expect(row?.balance).toBe(120);
    expect(row?.recent_unit_cost_ngn).toBe(550);
  });

  it("unauthenticated caller cannot read or write", async () => {
    const list = await fetch(`${baseUrl}/v1/packaging/materials`);
    expect([401, 403]).toContain(list.status);
    const post = await fetch(`${baseUrl}/v1/packaging/materials`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "X", unit_label: "x" }),
    });
    expect([401, 403]).toContain(post.status);
  });
});
