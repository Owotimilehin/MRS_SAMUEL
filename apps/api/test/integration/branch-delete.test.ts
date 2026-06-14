import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { product, stockLedger, type createDbClient } from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("branch soft-delete", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
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

  async function createBranch(code: string): Promise<string> {
    const res = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: `Branch ${code}`,
      code,
    });
    expect(res.status).toBe(201);
    return res.body.data.id;
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
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("soft-deletes a branch and drops it from the list", async () => {
    const id = await createBranch("DEL_OK");

    const del = await call<{ data: { id: string; deletedAt: string | null; isActive: boolean } }>(
      "DELETE",
      `/v1/branches/${id}`,
    );
    expect(del.status).toBe(200);
    expect(del.body.data.deletedAt).not.toBeNull();
    expect(del.body.data.isActive).toBe(false);

    const list = await call<{ data: Array<{ id: string }> }>("GET", "/v1/branches");
    expect(list.body.data.some((b) => b.id === id)).toBe(false);
  });

  it("returns 409 when deleting an already-deleted branch", async () => {
    const id = await createBranch("DEL_TWICE");
    const first = await call("DELETE", `/v1/branches/${id}`);
    expect(first.status).toBe(200);
    const second = await call<{ error?: unknown }>("DELETE", `/v1/branches/${id}`);
    expect(second.status).toBe(409);
  });

  it("refuses to delete a branch that still holds on-hand stock", async () => {
    const id = await createBranch("DEL_STOCK");

    // Seed a product + a positive opening-balance ledger row at the branch.
    const [p] = await db
      .insert(product)
      .values({ name: "Guard Juice", slug: `guard-${id}`, category: "regular" })
      .returning();
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: id,
      productId: p!.id,
      delta: 12,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });

    const del = await call<{ details?: { on_hand?: number } }>("DELETE", `/v1/branches/${id}`);
    expect(del.status).toBe(409);

    // Branch must still be live after a refused delete.
    const list = await call<{ data: Array<{ id: string }> }>("GET", "/v1/branches");
    expect(list.body.data.some((b) => b.id === id)).toBe(true);
  });

  it("rejects an unauthenticated delete", async () => {
    const id = await createBranch("DEL_AUTH");
    const res = await fetch(`${baseUrl}/v1/branches/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
    });
    expect([401, 403]).toContain(res.status);
  });
});
