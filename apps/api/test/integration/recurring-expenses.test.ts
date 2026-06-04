import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("recurring expenses CRUD", () => {
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

  it("creates a recurring schedule", async () => {
    const res = await call<{ data: { id: string; day_of_month: number; amount_ngn: number } }>(
      "POST",
      "/v1/expenses/recurring",
      {
        category_code: "rent",
        amount_ngn: 120000,
        vendor_name: "Landlord",
        day_of_month: 1,
        starts_on: "2026-01-01",
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.day_of_month).toBe(1);
    expect(res.body.data.amount_ngn).toBe(120000);
    createdId = res.body.data.id;
  });

  it("day_of_month outside 1..31 is rejected", async () => {
    const res = await call("POST", "/v1/expenses/recurring", {
      category_code: "rent",
      amount_ngn: 1000,
      day_of_month: 0,
      starts_on: "2026-01-01",
    });
    expect(res.status).toBe(400);
  });

  it("other_with_note without note is rejected", async () => {
    const res = await call("POST", "/v1/expenses/recurring", {
      category_code: "other_with_note",
      amount_ngn: 1000,
      day_of_month: 15,
      starts_on: "2026-01-01",
    });
    expect(res.status).toBe(400);
  });

  it("lists the schedule", async () => {
    const res = await call<{ data: Array<{ id: string }> }>("GET", "/v1/expenses/recurring");
    expect(res.status).toBe(200);
    expect(res.body.data.some((r) => r.id === createdId)).toBe(true);
  });

  it("patches active=false", async () => {
    const res = await call<{ data: { active: boolean } }>(
      "PATCH",
      `/v1/expenses/recurring/${createdId}`,
      { active: false },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
  });

  it("deletes the schedule", async () => {
    const del = await call("DELETE", `/v1/expenses/recurring/${createdId}`);
    expect(del.status).toBe(200);
    const list = await call<{ data: Array<{ id: string }> }>("GET", "/v1/expenses/recurring");
    expect(list.body.data.some((r) => r.id === createdId)).toBe(false);
  });

  it("unauthenticated cannot list or write", async () => {
    const list = await fetch(`${baseUrl}/v1/expenses/recurring`);
    expect([401, 403]).toContain(list.status);
    const create = await fetch(`${baseUrl}/v1/expenses/recurring`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        category_code: "rent",
        amount_ngn: 1,
        day_of_month: 1,
        starts_on: "2026-01-01",
      }),
    });
    expect([401, 403]).toContain(create.status);
  });
});
