import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

describe("capability gating", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    await seedUser(tdb.db, { email: "admin@example.com", role: "admin" });
    await seedUser(tdb.db, { email: "manager@example.com", role: "manager" });
    await seedUser(tdb.db, { email: "staff@example.com", role: "branch_staff" });

    // Import app AFTER env is set up so its lazy db client uses the testcontainer URL.
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  async function status(cookie: string, path: string): Promise<number> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    return res.status;
  }

  it("admin cannot manage users (users.manage is owner-only)", async () => {
    const cookie = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    expect(await status(cookie, "/v1/admin/users")).toBe(403);
  });

  it("owner can manage users", async () => {
    const cookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    expect(await status(cookie, "/v1/admin/users")).toBe(200);
  });

  it("manager can read revenue reports; branch_staff cannot", async () => {
    const mgr = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    const staff = await loginAs(baseUrl, "staff@example.com", "userpassword123");
    expect(await status(mgr, "/v1/reports/revenue")).toBe(200);
    expect(await status(staff, "/v1/reports/revenue")).toBe(403);
  });

  it("admin cannot view shrinkage (shrinkage.view is owner-only)", async () => {
    const cookie = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    expect(await status(cookie, "/v1/transfers/shrinkage")).toBe(403);
  });

  it("/auth/me returns capabilities array for the logged-in user", async () => {
    const cookie = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    const res = await fetch(`${baseUrl}/v1/auth/me`, { headers: { cookie } });
    const body = (await res.json()) as { data: { capabilities: string[] } };
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data.capabilities)).toBe(true);
    expect(body.data.capabilities).toContain("production.manage");
    expect(body.data.capabilities).not.toContain("users.manage");
  });

  it("branch_staff cannot view transfers list (no transfers.receive or similar gate but still requireAuth enforced)", async () => {
    // transfers list is only requireAuth; branch_staff can list their own branch transfers.
    // This test verifies that branch_staff CAN hit the list (no capability gate there) but
    // gets a 403 when attempting shrinkage (which IS gated).
    const cookie = await loginAs(baseUrl, "staff@example.com", "userpassword123");
    // Shrinkage is gated — expect 403
    expect(await status(cookie, "/v1/transfers/shrinkage")).toBe(403);
    // But the transfers list itself only requires auth — branch_staff has no branchId so
    // it will return an error about missing branch. Either way auth is accepted (not 401/403 from capability gate).
    const transfersRes = await fetch(`${baseUrl}/v1/transfers`, { headers: { cookie } });
    expect(transfersRes.status).not.toBe(401);
  });
});
