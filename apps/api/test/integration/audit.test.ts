import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { auditLog } from "@ms/db";
import { setupTestDb, seedOwner } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("audit log on login", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
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

  it("writes an audit row on successful login", async () => {
    await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "ownerpassword123" }),
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "auth.login_success"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.entityType).toBe("admin_user");
    expect(rows[0]!.afterJson).toMatchObject({ email: "owner@example.com" });
  });
});
