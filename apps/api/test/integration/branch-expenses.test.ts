import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { lagosDate, shiftDays } from "@ms/shared";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("branch expenses (shop spending from the till)", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let owner: string;
  let staffA: string;
  let staffNoCap: string;
  let branchA: string;
  let branchB: string;

  async function call<T>(
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        ...(method !== "GET" ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
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
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const a = await call<{ data: { id: string } }>(owner, "POST", "/v1/branches", { name: "Lekki Shop", code: "LEKKI" });
    const b = await call<{ data: { id: string } }>(owner, "POST", "/v1/branches", { name: "Ikeja Shop", code: "IKEJA" });
    branchA = a.body.data.id;
    branchB = b.body.data.id;

    await seedUser(tdb.db, { email: "staff-a@example.com", role: "branch_staff", branchId: branchA });
    await seedUser(tdb.db, {
      email: "staff-nocap@example.com",
      role: "branch_staff",
      branchId: branchA,
      revoked: ["expenses.branch_write"],
    });
    staffA = await loginAs(baseUrl, "staff-a@example.com", "userpassword123");
    staffNoCap = await loginAs(baseUrl, "staff-nocap@example.com", "userpassword123");
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("staff can log spending for their own branch (date defaults to Lagos today)", async () => {
    const res = await call<{ data: { id: string; branch_id: string; expense_date: string; amount_ngn: number } }>(
      staffA,
      "POST",
      `/v1/branches/${branchA}/expenses`,
      { amount_ngn: 3500, category_code: "raw_materials", description: "2 bags of ice" },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.branch_id).toBe(branchA);
    expect(res.body.data.expense_date).toBe(lagosDate());
    expect(res.body.data.amount_ngn).toBe(3500);
  });

  it("staff can list their branch's spending with a total", async () => {
    const res = await call<{ data: Array<{ amount_ngn: number }>; total_ngn: number }>(
      staffA,
      "GET",
      `/v1/branches/${branchA}/expenses`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total_ngn).toBe(3500);
  });

  it("staff get 403 for another branch (write and read)", async () => {
    const post = await call(staffA, "POST", `/v1/branches/${branchB}/expenses`, {
      amount_ngn: 1000,
      category_code: "transport",
      description: "rider",
    });
    expect(post.status).toBe(403);
    const get = await call(staffA, "GET", `/v1/branches/${branchB}/expenses`);
    expect(get.status).toBe(403);
  });

  it("staff without expenses.branch_write get 403", async () => {
    const res = await call(staffNoCap, "POST", `/v1/branches/${branchA}/expenses`, {
      amount_ngn: 1000,
      category_code: "transport",
      description: "rider",
    });
    expect(res.status).toBe(403);
  });

  it("staff still cannot open owner Bookkeeping", async () => {
    const res = await call(staffA, "GET", "/v1/expenses");
    expect(res.status).toBe(403);
  });

  it.each([
    ["zero amount", { amount_ngn: 0, category_code: "transport", description: "rider" }],
    ["amount over the cap", { amount_ngn: 500_001, category_code: "transport", description: "rider" }],
    ["fractional amount", { amount_ngn: 10.5, category_code: "transport", description: "rider" }],
    ["head-office category", { amount_ngn: 1000, category_code: "salaries", description: "wages" }],
    ["packaging category", { amount_ngn: 1000, category_code: "packaging", description: "bags" }],
    ["short description", { amount_ngn: 1000, category_code: "transport", description: "ab" }],
    ["missing description", { amount_ngn: 1000, category_code: "transport" }],
    ["future date", { amount_ngn: 1000, category_code: "transport", description: "rider", expense_date: shiftDays(lagosDate(), 1) }],
    ["older than 7 days", { amount_ngn: 1000, category_code: "transport", description: "rider", expense_date: shiftDays(lagosDate(), -8) }],
    ["bad date", { amount_ngn: 1000, category_code: "transport", description: "rider", expense_date: "2026-02-30" }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await call(staffA, "POST", `/v1/branches/${branchA}/expenses`, body);
    expect(res.status).toBe(400);
  });

  it("accepts a date up to 7 days back", async () => {
    const res = await call(staffA, "POST", `/v1/branches/${branchA}/expenses`, {
      amount_ngn: 2000,
      category_code: "other_with_note",
      description: "Cleaning soap and sponge",
      expense_date: shiftDays(lagosDate(), -7),
    });
    expect(res.status).toBe(201);
  });

  it("owner list shows which branch each spend was at; owner entries stay head office", async () => {
    const own = await call<{ data: { id: string; branch_id: string | null } }>(owner, "POST", "/v1/expenses", {
      expense_date: lagosDate(),
      category_code: "rent",
      amount_ngn: 100_000,
      description: "Shop rent",
    });
    expect(own.status).toBe(201);
    expect(own.body.data.branch_id).toBeNull();

    const from = shiftDays(lagosDate(), -10);
    const all = await call<{ data: Array<{ description: string; branch_id: string | null; branch_name: string | null }> }>(
      owner,
      "GET",
      `/v1/expenses?from=${from}&to=${lagosDate()}`,
    );
    expect(all.status).toBe(200);
    const ice = all.body.data.find((r) => r.description === "2 bags of ice");
    expect(ice?.branch_id).toBe(branchA);
    expect(ice?.branch_name).toBe("Lekki Shop");
    const rent = all.body.data.find((r) => r.description === "Shop rent");
    expect(rent?.branch_id).toBeNull();
    expect(rent?.branch_name).toBeNull();

    const onlyA = await call<{ data: Array<{ branch_id: string | null }> }>(
      owner,
      "GET",
      `/v1/expenses?from=${from}&to=${lagosDate()}&branch=${branchA}`,
    );
    expect(onlyA.body.data.length).toBe(2);
    expect(onlyA.body.data.every((r) => r.branch_id === branchA)).toBe(true);

    const head = await call<{ data: Array<{ branch_id: string | null }> }>(
      owner,
      "GET",
      `/v1/expenses?from=${from}&to=${lagosDate()}&branch=head_office`,
    );
    expect(head.body.data.length).toBe(1);
    expect(head.body.data[0]?.branch_id).toBeNull();
  });

  it("owner can log for any branch via the branch route", async () => {
    const res = await call(owner, "POST", `/v1/branches/${branchB}/expenses`, {
      amount_ngn: 1500,
      category_code: "utilities",
      description: "Generator fuel",
    });
    expect(res.status).toBe(201);
  });
});
