import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("vendors CRUD + expense linkage", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let vendorId: string;

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
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("creates a vendor", async () => {
    const res = await call<{ data: { id: string; name: string } }>("POST", "/v1/vendors", {
      name: "Adebayo Orange Market",
      phone: "+2348012345678",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Adebayo Orange Market");
    vendorId = res.body.data.id;
  });

  it("searches vendors by substring", async () => {
    const hit = await call<{ data: Array<{ id: string }> }>("GET", "/v1/vendors?q=Adebayo");
    expect(hit.body.data.some((v) => v.id === vendorId)).toBe(true);
    const miss = await call<{ data: Array<{ id: string }> }>("GET", "/v1/vendors?q=ZZZNoMatch");
    expect(miss.body.data.length).toBe(0);
  });

  it("create expense with vendor_id resolves vendor name on read", async () => {
    const create = await call<{ data: { id: string; vendor_id: string | null; vendor_name: string | null } }>(
      "POST",
      "/v1/expenses",
      {
        expense_date: "2026-06-04",
        category_code: "raw_materials",
        amount_ngn: 8000,
        vendor_id: vendorId,
      },
    );
    expect(create.status).toBe(201);
    expect(create.body.data.vendor_id).toBe(vendorId);
    expect(create.body.data.vendor_name).toBe("Adebayo Orange Market");

    const read = await call<{ data: { vendor_name: string | null } }>("GET", `/v1/expenses/${create.body.data.id}`);
    expect(read.body.data.vendor_name).toBe("Adebayo Orange Market");
  });

  it("legacy free-text vendor_name still works without a vendor_id", async () => {
    const create = await call<{ data: { vendor_id: string | null; vendor_name: string | null } }>(
      "POST",
      "/v1/expenses",
      {
        expense_date: "2026-06-04",
        category_code: "rent",
        amount_ngn: 100000,
        vendor_name: "Landlord (no vendor record)",
      },
    );
    expect(create.body.data.vendor_id).toBeNull();
    expect(create.body.data.vendor_name).toBe("Landlord (no vendor record)");
  });

  it("soft-deleting a vendor leaves the linked expense able to resolve the name", async () => {
    const del = await call("DELETE", `/v1/vendors/${vendorId}`);
    expect(del.status).toBe(200);
    // The expense still has vendor_id; we joined to the row regardless of deleted_at.
    const list = await call<{ data: Array<{ vendor_id: string | null; vendor_name: string | null }> }>(
      "GET",
      "/v1/expenses?from=2026-06-01&to=2026-06-30",
    );
    const linked = list.body.data.find((e) => e.vendor_id === vendorId);
    expect(linked).toBeDefined();
    expect(linked!.vendor_name).toBe("Adebayo Orange Market");
  });

  it("unauthenticated caller cannot create or list vendors", async () => {
    const list = await fetch(`${baseUrl}/v1/vendors`);
    expect([401, 403]).toContain(list.status);
    const create = await fetch(`${baseUrl}/v1/vendors`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "X" }),
    });
    expect([401, 403]).toContain(create.status);
  });
});
