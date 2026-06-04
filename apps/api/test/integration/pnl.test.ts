import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("reports/pnl", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

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

  it("month with no expenses returns zeros for the expense side", async () => {
    const res = await call<{
      data: {
        expenses_total_ngn: number;
        expenses_by_category: unknown[];
        net_ngn: number;
        net_revenue_ngn: number;
      };
    }>("GET", "/v1/reports/pnl?month=2026-06");
    expect(res.status).toBe(200);
    expect(res.body.data.expenses_total_ngn).toBe(0);
    expect(res.body.data.expenses_by_category).toEqual([]);
    expect(res.body.data.net_ngn).toBe(res.body.data.net_revenue_ngn);
  });

  it("expense totals roll up correctly and exclude soft-deleted rows", async () => {
    const a = await call<{ data: { id: string } }>("POST", "/v1/expenses", {
      expense_date: "2026-07-05",
      category_code: "raw_materials",
      amount_ngn: 14500,
    });
    await call("POST", "/v1/expenses", {
      expense_date: "2026-07-06",
      category_code: "rent",
      amount_ngn: 120000,
    });
    const c = await call<{ data: { id: string } }>("POST", "/v1/expenses", {
      expense_date: "2026-07-07",
      category_code: "utilities",
      amount_ngn: 5000,
    });
    await call("DELETE", `/v1/expenses/${c.body.data.id}`);

    const res = await call<{
      data: {
        expenses_total_ngn: number;
        expenses_by_category: Array<{ category_code: string; amount_ngn: number }>;
      };
    }>("GET", "/v1/reports/pnl?month=2026-07");
    expect(res.status).toBe(200);
    expect(res.body.data.expenses_total_ngn).toBe(14500 + 120000);
    const codes = res.body.data.expenses_by_category.map((r) => r.category_code).sort();
    expect(codes).toEqual(["raw_materials", "rent"]);
    expect(
      res.body.data.expenses_by_category.find((r) => r.category_code === "raw_materials")?.amount_ngn,
    ).toBe(14500);

    // Avoid unused-var warning on `a`.
    expect(a.status).toBe(201);
  });

  it("bad month format returns 400", async () => {
    const res = await call("GET", "/v1/reports/pnl?month=June-2026");
    expect(res.status).toBe(400);
  });
});
