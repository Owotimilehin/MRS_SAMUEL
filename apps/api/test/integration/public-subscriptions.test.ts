import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner } from "./helpers.js";
import { subscriptionLead, outboxEvent } from "@ms/db";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public subscription leads", () => {
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
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("stores the lead and emits a subscription.requested outbox event", async () => {
    const res = await fetch(`${baseUrl}/v1/public/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "Ada", phone: "+2348012345678", plan_slug: "monthly-detox" }),
    });
    expect(res.status).toBe(201);
    const leads = await db
      .select()
      .from(subscriptionLead)
      .where(eq(subscriptionLead.planSlug, "monthly-detox"));
    expect(leads.length).toBe(1);
    const events = await db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, "subscription.requested"));
    expect(events.length).toBe(1);
  });

  it("rejects a too-short phone with 400", async () => {
    const res = await fetch(`${baseUrl}/v1/public/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "X", phone: "123", plan_slug: "weekly-juice-box" }),
    });
    expect(res.status).toBe(400);
  });
});
