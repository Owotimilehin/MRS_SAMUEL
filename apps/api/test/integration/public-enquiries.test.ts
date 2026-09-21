import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { enquiryLead, outboxEvent } from "@ms/db";
import { setupTestDb, seedOwner } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * White-label / bulk-order enquiries. The visitor is handed to WhatsApp either
 * way; this endpoint exists so the owner still has a record of who asked, which
 * the old subscription_lead table never captured (it had no writer at all).
 */
describe("POST /v1/public/enquiries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let baseUrl: string;
  let server: ReturnType<typeof serve>;

  const post = (body: unknown) =>
    fetch(`${baseUrl}/v1/public/enquiries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const t = await setupTestDb();
    container = t.container;
    db = t.db;
    await seedOwner(db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("records a white-label enquiry and notifies the owner", async () => {
    const res = await post({ name: "Ada Okeke", phone: "0802 555 0111", enquiry_type: "white_label" });
    expect(res.status).toBe(201);

    const rows = await db.select().from(enquiryLead);
    const row = rows.find((r) => r.name === "Ada Okeke");
    expect(row).toBeDefined();
    expect(row?.enquiryType).toBe("white_label");
    // Phone is normalised so the owner can dial it straight from the inbox.
    expect(row?.phone).toBe("08025550111");

    const events = await db.select().from(outboxEvent);
    expect(events.some((e) => e.eventType === "enquiry.received")).toBe(true);
  });

  it("records a bulk-order enquiry", async () => {
    const res = await post({ name: "Bola Ade", phone: "08033330000", enquiry_type: "bulk_order" });
    expect(res.status).toBe(201);
    const rows = await db.select().from(enquiryLead);
    expect(rows.find((r) => r.name === "Bola Ade")?.enquiryType).toBe("bulk_order");
  });

  it("rejects an unknown enquiry type", async () => {
    const res = await post({ name: "X", phone: "08000000000", enquiry_type: "free_juice" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing name or phone", async () => {
    expect((await post({ name: "", phone: "08000000000", enquiry_type: "bulk_order" })).status).toBe(400);
    expect((await post({ name: "Ada", enquiry_type: "bulk_order" })).status).toBe(400);
  });
});
