import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { createDbClient } from "@ms/db";

interface Branch { id: string; name: string }
interface Product { id: string; name: string; slug: string }
interface SaleOrder { id: string; orderNumber: string; customerId: string | null }

describe("Customer identity by phone", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: Branch;
  let product: Product;

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
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
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

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Customer Test Branch",
      code: "CTB",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Customer Test Factory" }).returning();
    const factory = fac as { id: string };

    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Customer Test Sunrise",
      slug: "customer-test-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2000,
    });
    product = pRes.body.data;

    // Stock the branch: produce 50 then transfer + receive.
    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-06",
      items: [{ product_id: product.id, quantity_produced: 50 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
    const xfer = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: 50 }],
    });
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/arrive`);
    const detail = await call<{ data: { items: Array<{ id: string }> } }>(
      "GET",
      `/v1/transfers/${xfer.body.data.id}`,
    );
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/receive`, {
      items: [{ item_id: detail.body.data.items[0]!.id, quantity_received: 50 }],
    });
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("two POS sales with the same phone (different formats) resolve to ONE customer", async () => {
    const first = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      customer: { phone: "08031234567", name: "Bisi" },
      created_at_local: new Date().toISOString(),
    });
    expect(first.status).toBe(201);
    expect(first.body.data.customerId).toBeTruthy();

    // Same human, number typed in international format, name omitted this time.
    const second = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      customer: { phone: "+2348031234567" },
      created_at_local: new Date().toISOString(),
    });
    expect(second.status).toBe(201);

    // Both orders must point at the SAME customer row.
    expect(second.body.data.customerId).toBe(first.body.data.customerId);

    // Exactly one customer row exists for that normalized number, and the name
    // captured on the first sale is preserved.
    const { customer } = await import("@ms/db");
    const rows = await db.select().from(customer).where(eq(customer.phone, "+2348031234567"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Bisi");
  });

  it("a POS sale with a name but no phone still records a customer (no merge)", async () => {
    const res = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      customer: { name: "Walk-in Tunde" },
      created_at_local: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.customerId).toBeTruthy();
  });

  it("a POS sale with a junk phone still succeeds (never 422 at the counter)", async () => {
    const res = await call<{ data: SaleOrder }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      customer: { phone: "12", name: "Bad Number" },
      created_at_local: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.customerId).toBeTruthy();
  });

  interface CustomerSummary {
    id: string;
    name: string | null;
    phone: string | null;
    orders: number;
    lifetimeNgn: number;
    lastOrderAt: string;
    lastOrderNumber: string;
  }

  it("GET /v1/customers aggregates order count + lifetime spend per customer", async () => {
    // Two sales for one new phone (product price 2000): 1 + 2 bottles = ₦6000.
    await call("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      customer: { phone: "08055500001", name: "Ada" },
      created_at_local: new Date().toISOString(),
    });
    await call("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 2 }],
      payment_method: "cash",
      customer: { phone: "0805 550 0001" },
      created_at_local: new Date().toISOString(),
    });

    const res = await call<{ data: CustomerSummary[] }>("GET", "/v1/customers");
    expect(res.status).toBe(200);
    const ada = res.body.data.find((r) => r.phone === "+2348055500001");
    expect(ada).toBeTruthy();
    expect(ada!.name).toBe("Ada");
    expect(ada!.orders).toBe(2);
    expect(ada!.lifetimeNgn).toBe(6000);
  });

  it("GET /v1/customers/:id returns the customer's orders, newest first", async () => {
    const list = await call<{ data: CustomerSummary[] }>("GET", "/v1/customers");
    const ada = list.body.data.find((r) => r.phone === "+2348055500001")!;

    const res = await call<{
      data: {
        customer: { id: string; name: string | null; phone: string | null };
        orders: Array<{ orderNumber: string; totalNgn: number; createdAtLocal: string }>;
        lifetimeNgn: number;
      };
    }>("GET", `/v1/customers/${ada.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.customer.phone).toBe("+2348055500001");
    expect(res.body.data.orders).toHaveLength(2);
    expect(res.body.data.lifetimeNgn).toBe(6000);
    // Newest first.
    const [a, b] = res.body.data.orders;
    expect(a!.createdAtLocal >= b!.createdAtLocal).toBe(true);
  });
});
