import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner } from "./helpers.js";
import { contactMessage, outboxEvent } from "@ms/db";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public contact", () => {
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

  it("stores the message and emits a contact.message_received outbox event", async () => {
    const res = await fetch(`${baseUrl}/v1/public/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "Ada",
        email: "ada@example.com",
        phone: "+2348012345678",
        subject: "Wholesale / B2B",
        message: "Need 200 bottles",
      }),
    });
    expect(res.status).toBe(201);
    const stored = await db
      .select()
      .from(contactMessage)
      .where(eq(contactMessage.email, "ada@example.com"));
    expect(stored.length).toBe(1);
    const events = await db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, "contact.message_received"));
    expect(events.length).toBe(1);
  });

  it("rejects an invalid email with 400", async () => {
    const res = await fetch(`${baseUrl}/v1/public/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ name: "X", email: "not-an-email", subject: "Press / partnership", message: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});
