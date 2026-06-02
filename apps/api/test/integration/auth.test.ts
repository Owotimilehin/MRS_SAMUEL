import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("auth integration", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    // Import app AFTER env is set up so its lazy db client uses the testcontainer URL.
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("logs in with correct credentials and sets cookies", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "ownerpassword123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user: { role: string } } };
    expect(body.data.user.role).toBe("owner");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/ms_session=/);
    expect(setCookie).toMatch(/ms_refresh=/);
  });

  it("rejects wrong password", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "wrongwrongwrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_credentials");
  });

  it("locks the account after 5 failures", async () => {
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "wrongwrongwrong" }),
      });
    }
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "ownerpassword123" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("account_locked");
  });
});
