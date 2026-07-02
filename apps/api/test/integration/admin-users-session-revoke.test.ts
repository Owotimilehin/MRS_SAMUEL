import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * A branch worker gets bounced to login when an owner edits their profile,
 * because the owner's edit form replays role + permission_overrides on every
 * save and the server revoked all sessions whenever those fields were merely
 * PRESENT. Revocation must fire only when the role or effective capabilities
 * actually change (or the user is deactivated) — a name/branch edit must leave
 * a signed-in till alone.
 */
describe("admin_user edit — session revocation only on real capability change", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let ownerCookie: string;
  let server: ReturnType<typeof serve>;

  const idem = () => ({ "idempotency-key": uuid() });

  async function invite(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/v1/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie, ...idem() },
      body: JSON.stringify(body),
    });
  }

  async function patch(id: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify(body),
    });
  }

  // Invite a branch worker and sign them in so there is a live session to
  // (not) revoke. Returns the new user's id and their password.
  async function seedSignedInStaff(email: string): Promise<string> {
    const password = "staffpassword123";
    const res = await invite({
      email,
      name: "Original Name",
      role: "branch_staff",
      branch_id: null,
      password,
      permission_overrides: { granted: [], revoked: [] },
    });
    expect(res.status).toBe(201);
    const { data: created } = await res.json();
    await loginAs(baseUrl, email, password); // creates a live session row
    return created.id;
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
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("a name edit that replays the same role & permissions does NOT revoke sessions", async () => {
    const id = await seedSignedInStaff("benign-edit@example.com");
    // Exactly what the owner's edit form sends on every save.
    const res = await patch(id, {
      name: "New Name",
      role: "branch_staff",
      branch_id: null,
      permission_overrides: { granted: [], revoked: [] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.sessionsRevoked).toBe(0);
  });

  it("granting a new capability revokes sessions", async () => {
    const id = await seedSignedInStaff("grant-cap@example.com");
    const res = await patch(id, {
      name: "Original Name",
      role: "branch_staff",
      branch_id: null,
      permission_overrides: { granted: ["reports.view"], revoked: [] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.sessionsRevoked).toBeGreaterThanOrEqual(1);
  });

  it("changing the role revokes sessions", async () => {
    const id = await seedSignedInStaff("role-change@example.com");
    const res = await patch(id, {
      name: "Original Name",
      role: "manager",
      branch_id: null,
      permission_overrides: { granted: [], revoked: [] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.sessionsRevoked).toBeGreaterThanOrEqual(1);
  });

  it("deactivating the user revokes sessions", async () => {
    const id = await seedSignedInStaff("deactivate@example.com");
    const res = await patch(id, { is_active: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.sessionsRevoked).toBeGreaterThanOrEqual(1);
  });
});
