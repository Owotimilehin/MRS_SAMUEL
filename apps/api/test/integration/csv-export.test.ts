import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("expenses + P&L CSV export", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

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

  async function rawGet(path: string): Promise<{ status: number; body: string; contentType: string; disposition: string }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get("content-type") ?? "",
      disposition: res.headers.get("content-disposition") ?? "",
    };
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

    await call("POST", "/v1/expenses", {
      expense_date: "2026-06-03",
      category_code: "raw_materials",
      amount_ngn: 14500,
      vendor_name: "Adebayo Orange",
      description: "20 baskets, edge case: commas, in the description",
    });
    await call("POST", "/v1/expenses", {
      expense_date: "2026-06-04",
      category_code: "rent",
      amount_ngn: 120000,
    });
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("expenses CSV returns text/csv with the expected header + rows + attachment", async () => {
    const res = await rawGet("/v1/expenses?from=2026-06-01&to=2026-06-30&format=csv");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/csv");
    expect(res.disposition).toContain("attachment");
    expect(res.disposition).toContain("expenses-2026-06-01_2026-06-30.csv");
    expect(res.body.split("\r\n")[0]).toBe("Date,Category,Vendor,Description,Amount (NGN),Notes");
    // value with comma should be quoted + internal commas preserved
    expect(res.body).toContain("\"20 baskets, edge case: commas, in the description\"");
    expect(res.body).toContain("Raw materials");
    expect(res.body).toContain("Rent");
  });

  it("P&L CSV returns text/csv with section structure", async () => {
    const res = await rawGet("/v1/reports/pnl?month=2026-06&format=csv");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/csv");
    expect(res.disposition).toContain("pnl-2026-06.csv");
    expect(res.body).toContain("Mrs. Samuel - P&L for 2026-06");
    expect(res.body).toContain("Revenue,Sales,");
    expect(res.body).toContain("Revenue,Refunds,");
    expect(res.body).toContain("Expenses,Total expenses,");
    expect(res.body).toContain("Net,Net (Revenue - Expenses),");
  });
});
