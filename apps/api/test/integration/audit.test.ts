import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { desc, eq } from "drizzle-orm";
import { auditLog, bundle, outboxEvent } from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
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

  it("audit.logged carries actor name and before→after changes", async () => {
    // Log in as the owner (seeded with name=null so displayName returns the email prefix)
    const cookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    // Create a bundle with price 1800
    const createRes = await fetch(`${baseUrl}/v1/marketing/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        slug: "audit-test-bundle",
        name: "Audit Test Bundle",
        price_ngn: 1800,
        display_order: 99,
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    // Edit the price 1800 → 2000
    const patchRes = await fetch(`${baseUrl}/v1/marketing/bundles/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ price_ngn: 2000 }),
    });
    expect(patchRes.status).toBe(200);

    // Helper: most recent outbox_event of a given type
    async function latestOutbox(type: string) {
      const [ev] = await db
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.eventType, type))
        .orderBy(desc(outboxEvent.createdAt))
        .limit(1);
      return ev;
    }

    const ev = await latestOutbox("audit.logged");
    expect(ev).toBeDefined();
    const payload = ev!.payload;
    // actor_name: owner has no name set so displayName returns the email prefix "owner"
    expect(payload.actor_name).toBeTruthy();
    expect(payload.actor_role).toBeTruthy();
    expect(payload.changes).toEqual(
      expect.arrayContaining([{ label: "Price", from: "₦1,800", to: "₦2,000" }]),
    );
  });
});
