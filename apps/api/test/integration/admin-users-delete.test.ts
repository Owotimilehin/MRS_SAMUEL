import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { product, stockLedger, adminUser, type createDbClient } from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("admin user edit + delete", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let ownerCookie: string;
  let server: ReturnType<typeof serve>;
  let ownerId: string;

  const idem = () => ({ "idempotency-key": uuid() });

  async function call<T>(
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? idem() : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  // Give a user a foreign-keyed history row so a hard delete is blocked.
  async function recordStockFor(userId: string): Promise<void> {
    const [p] = await db
      .insert(product)
      .values({ name: `Hist ${userId.slice(0, 6)}`, slug: `hist-${userId}`, category: "regular" })
      .returning();
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: uuid(),
      productId: p!.id,
      delta: 5,
      sourceType: "opening_balance",
      sourceId: uuid(),
      recordedByUserId: userId,
    });
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    ownerId = (await seedOwner(tdb.db)).id;
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("hard-deletes a user with no history and drops them from the list", async () => {
    const u = await seedUser(db, { email: "clean@example.com", role: "branch_staff" });
    const del = await call<{ data: { id: string; mode: string } }>(
      "DELETE",
      `/v1/admin/users/${u.id}`,
      ownerCookie,
    );
    expect(del.status).toBe(200);
    expect(del.body.data.mode).toBe("hard");

    const list = await call<{ data: Array<{ id: string }> }>("GET", "/v1/admin/users", ownerCookie);
    expect(list.body.data.some((r) => r.id === u.id)).toBe(false);
  });

  it("soft-deletes a user that has activity history, preserving the row", async () => {
    const u = await seedUser(db, { email: "worked@example.com", role: "manager" });
    await recordStockFor(u.id);

    const del = await call<{ data: { id: string; mode: string } }>(
      "DELETE",
      `/v1/admin/users/${u.id}`,
      ownerCookie,
    );
    expect(del.status).toBe(200);
    expect(del.body.data.mode).toBe("soft");

    // Hidden from the list…
    const list = await call<{ data: Array<{ id: string }> }>("GET", "/v1/admin/users", ownerCookie);
    expect(list.body.data.some((r) => r.id === u.id)).toBe(false);
    // …but the row still exists (soft delete), and the email was released.
    const rows = await db.select().from(adminUser);
    const still = rows.find((r) => r.id === u.id);
    expect(still).toBeDefined();
    expect(still!.deletedAt).not.toBeNull();
    expect(still!.isActive).toBe(false);
    expect(still!.email).not.toBe("worked@example.com");
  });

  it("refuses to delete your own account", async () => {
    const del = await call<{ error?: unknown }>("DELETE", `/v1/admin/users/${ownerId}`, ownerCookie);
    expect(del.status).toBe(409);
  });

  it("refuses to demote the last active owner", async () => {
    const patch = await call<{ error?: unknown }>("PATCH", `/v1/admin/users/${ownerId}`, ownerCookie, {
      role: "admin",
    });
    expect(patch.status).toBe(409);
  });

  it("revokes the user's sessions when their permissions change", async () => {
    const u = await seedUser(db, { email: "grant@example.com", role: "branch_staff" });
    // A fresh login gives this user a live session (refresh token).
    const userCookie = await loginAs(baseUrl, "grant@example.com", "userpassword123");

    const patch = await call<{ meta: { sessionsRevoked: number } }>(
      "PATCH",
      `/v1/admin/users/${u.id}`,
      ownerCookie,
      { permission_overrides: { granted: ["production.manage"], revoked: [] } },
    );
    expect(patch.status).toBe(200);
    expect(patch.body.meta.sessionsRevoked).toBeGreaterThanOrEqual(1);

    // The original session can no longer refresh — forcing a fresh sign-in that
    // mints a token carrying the new capability.
    const after = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { cookie: userCookie },
    });
    expect(after.status).toBe(401);
  });
});
