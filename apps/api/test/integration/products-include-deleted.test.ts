import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * A deactivated flavour must stay visible to the admin catalogue.
 *
 * Deactivating is a soft delete (deleted_at + is_active=false, cascading to
 * every size) so sales history survives — but the list endpoint filtered those
 * rows out unconditionally, so a flavour the owner switched off simply vanished
 * with no way to see, count or restore it. `?include_deleted=1` brings it back
 * for the admin while every other reader keeps the default behaviour.
 */
describe("GET /v1/products include_deleted", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let productId: string;

  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const created = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Retire Me",
        slug: "retire-me",
        category: "regular",
        initial_price_ngn: 2500,
      }),
    });
    expect(created.status).toBe(201);
    productId = ((await created.json()) as { data: { id: string } }).data.id;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("lists the flavour while it is live", async () => {
    const rows = (await (await get("/v1/products")).json()) as { data: Array<{ id: string }> };
    expect(rows.data.some((r) => r.id === productId)).toBe(true);
  });

  it("hides it from the default list once deactivated", async () => {
    const del = await fetch(`${baseUrl}/v1/products/${productId}`, {
      method: "DELETE",
      headers: { cookie: cookies },
    });
    expect(del.status).toBe(200);

    const rows = (await (await get("/v1/products")).json()) as { data: Array<{ id: string }> };
    expect(rows.data.some((r) => r.id === productId)).toBe(false);
  });

  it("returns it with include_deleted=1, stamped with deleted_at", async () => {
    const rows = (await (await get("/v1/products?include_deleted=1")).json()) as {
      data: Array<{ id: string; deletedAt: string | null; isActive: boolean }>;
    };
    const row = rows.data.find((r) => r.id === productId);
    expect(row).toBeDefined();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.isActive).toBe(false);
  });

  it("still resolves the detail route so the card can be opened", async () => {
    const res = await get(`/v1/products/${productId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deletedAt: string | null; variants: Array<{ is_active: boolean }> } };
    expect(body.data.deletedAt).not.toBeNull();
    // Deactivating cascades to every size, which is what the "sizes retired"
    // count on the catalogue page reads.
    expect(body.data.variants.every((v) => !v.is_active)).toBe(true);
  });
});
