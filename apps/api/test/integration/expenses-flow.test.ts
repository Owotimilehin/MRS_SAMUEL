import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("business expenses CRUD", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let createdId: string;

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

  it("owner creates an expense", async () => {
    const res = await call<{ data: { id: string; amount_ngn: number; category_code: string } }>(
      "POST",
      "/v1/expenses",
      {
        expense_date: "2026-06-03",
        category_code: "raw_materials",
        amount_ngn: 14500,
        vendor_name: "Adebayo",
        description: "20 baskets of oranges",
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.amount_ngn).toBe(14500);
    expect(res.body.data.category_code).toBe("raw_materials");
    createdId = res.body.data.id;
  });

  it("empty body is rejected", async () => {
    const res = await call("POST", "/v1/expenses", {});
    expect(res.status).toBe(400);
  });

  it("other_with_note without reason_note is rejected", async () => {
    const res = await call("POST", "/v1/expenses", {
      expense_date: "2026-06-03",
      category_code: "other_with_note",
      amount_ngn: 5000,
    });
    expect(res.status).toBe(400);
  });

  it("other_with_note with whitespace-only reason_note is rejected", async () => {
    const res = await call("POST", "/v1/expenses", {
      expense_date: "2026-06-03",
      category_code: "other_with_note",
      reason_note: "   ",
      amount_ngn: 5000,
    });
    expect(res.status).toBe(400);
  });

  it("list returns the created row with default filters", async () => {
    const res = await call<{ data: Array<{ id: string }>; pagination: { total: number } }>(
      "GET",
      "/v1/expenses?from=2026-06-01&to=2026-06-30",
    );
    expect(res.status).toBe(200);
    expect(res.body.data.some((r) => r.id === createdId)).toBe(true);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it("list q substring filters on vendor and description", async () => {
    const hit = await call<{ data: Array<{ id: string }> }>(
      "GET",
      "/v1/expenses?from=2026-06-01&to=2026-06-30&q=adebayo",
    );
    expect(hit.body.data.some((r) => r.id === createdId)).toBe(true);

    const miss = await call<{ data: Array<{ id: string }> }>(
      "GET",
      "/v1/expenses?from=2026-06-01&to=2026-06-30&q=zzz-no-such-vendor",
    );
    expect(miss.body.data.length).toBe(0);
  });

  it("edit updates the row", async () => {
    const res = await call<{ data: { amount_ngn: number; description: string | null } }>(
      "PATCH",
      `/v1/expenses/${createdId}`,
      { amount_ngn: 15000, description: "21 baskets - late delivery surcharge" },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.amount_ngn).toBe(15000);
    expect(res.body.data.description).toContain("late delivery");
  });

  it("delete soft-deletes; row drops out of list but GET /:id still returns it", async () => {
    const del = await call("DELETE", `/v1/expenses/${createdId}`);
    expect(del.status).toBe(200);

    const list = await call<{ data: Array<{ id: string }> }>(
      "GET",
      "/v1/expenses?from=2026-06-01&to=2026-06-30",
    );
    expect(list.body.data.some((r) => r.id === createdId)).toBe(false);

    const one = await call<{ data: { deleted_at: string | null } }>("GET", `/v1/expenses/${createdId}`);
    expect(one.status).toBe(200);
    expect(one.body.data.deleted_at).not.toBeNull();
  });

  it("unauthenticated caller cannot list, read, create, or presign", async () => {
    const list = await fetch(`${baseUrl}/v1/expenses`);
    expect([401, 403]).toContain(list.status);
    const create = await fetch(`${baseUrl}/v1/expenses`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ expense_date: "2026-06-03", category_code: "rent", amount_ngn: 1 }),
    });
    expect([401, 403]).toContain(create.status);
    const presign = await fetch(`${baseUrl}/v1/expenses/presign-upload`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ filename: "x.jpg", content_type: "image/jpeg", size_bytes: 1024 }),
    });
    expect([401, 403]).toContain(presign.status);
  });

  it("presign rejects bad content_type or oversize", async () => {
    const badType = await call("POST", "/v1/expenses/presign-upload", {
      filename: "x.txt",
      content_type: "text/plain",
      size_bytes: 1024,
    });
    expect(badType.status).toBe(400);

    const tooBig = await call("POST", "/v1/expenses/presign-upload", {
      filename: "x.jpg",
      content_type: "image/jpeg",
      size_bytes: 100 * 1024 * 1024,
    });
    expect(tooBig.status).toBe(400);
  });

  it("presign returns 503 when R2 not configured (or 200 if it happens to be set)", async () => {
    const res = await call("POST", "/v1/expenses/presign-upload", {
      filename: "x.jpg",
      content_type: "image/jpeg",
      size_bytes: 1024,
    });
    expect([503, 200]).toContain(res.status);
  });
});
