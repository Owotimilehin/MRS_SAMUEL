import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("admin_user name field", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let ownerCookie: string;
  let server: ReturnType<typeof serve>;

  const idem = () => ({ "idempotency-key": uuid() });

  async function api(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: { cookie: ownerCookie },
    });
  }

  async function invite(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/v1/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
        ...idem(),
      },
      body: JSON.stringify(body),
    });
  }

  async function patch(id: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
      },
      body: JSON.stringify(body),
    });
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

  it("stores and returns the staff name", async () => {
    const res = await invite({
      email: "aisha@example.com",
      name: "Aisha Bello",
      role: "branch_staff",
      branch_id: null,
      password: "password12345",
    });
    expect(res.status).toBe(201);
    const list = await api("/v1/admin/users");
    const row = (await list.json()).data.find((u: any) => u.email === "aisha@example.com");
    expect(row.name).toBe("Aisha Bello");
  });

  it("PATCH name updates the stored name", async () => {
    const inviteRes = await invite({
      email: "patch-name@example.com",
      name: "Original Name",
      role: "branch_staff",
      branch_id: null,
      password: "password12345",
    });
    expect(inviteRes.status).toBe(201);
    const { data: created } = await inviteRes.json();
    const userId = created.id;

    const patchRes = await patch(userId, { name: "Updated Name" });
    expect(patchRes.status).toBe(200);

    const list = await api("/v1/admin/users");
    const row = (await list.json()).data.find((u: any) => u.id === userId);
    expect(row.name).toBe("Updated Name");
  });

  it("PATCH name: null clears the stored name", async () => {
    const inviteRes = await invite({
      email: "clear-name@example.com",
      name: "Some Name",
      role: "branch_staff",
      branch_id: null,
      password: "password12345",
    });
    expect(inviteRes.status).toBe(201);
    const { data: created } = await inviteRes.json();
    const userId = created.id;

    const patchRes = await patch(userId, { name: null });
    expect(patchRes.status).toBe(200);

    const list = await api("/v1/admin/users");
    const row = (await list.json()).data.find((u: any) => u.id === userId);
    expect(row.name).toBeNull();
  });
});
