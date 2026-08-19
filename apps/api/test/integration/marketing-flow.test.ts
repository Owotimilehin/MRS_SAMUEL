import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import { enquiryLead, contactMessage } from "@ms/db";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("marketing admin CRUD + leads", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let ownerCookie: string;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    // A user WITHOUT marketing.manage to prove the gate denies.
    await seedUser(tdb.db, {
      email: "staff@example.com",
      role: "branch_staff",
    });
    // Seed one lead of each kind so the inbox endpoints have data.
    await tdb.db.insert(enquiryLead).values({ name: "Ada", phone: "+2348025550111", enquiryType: "white_label" });
    await tdb.db.insert(contactMessage).values({ name: "Bola", email: "bola@example.com", subject: "Hi", message: "Question" });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  function authed(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { cookie: ownerCookie, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }

  it("denies access without marketing.manage", async () => {
    const cookie = await loginAs(baseUrl, "staff@example.com", "userpassword123");
    const res = await fetch(`${baseUrl}/v1/marketing/bundles`, { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("creates, updates and deletes a bundle", async () => {
    const create = await authed("/v1/marketing/bundles", {
      method: "POST",
      body: JSON.stringify({ slug: "gift-box", name: "Gift Box", price_ngn: 20000, contents_label: "8 × 330ml" }),
    });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { data: { id: string } }).data.id;

    const patch = await authed(`/v1/marketing/bundles/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ badge: "Limited" }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { data: { badge: string } }).data.badge).toBe("Limited");

    const del = await authed(`/v1/marketing/bundles/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("lists enquiry + contact leads", async () => {
    const subs = await authed("/v1/marketing/leads/enquiries");
    expect(subs.status).toBe(200);
    expect(((await subs.json()) as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);

    const contacts = await authed("/v1/marketing/leads/contact");
    expect(contacts.status).toBe(200);
    expect(((await contacts.json()) as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);
  });
});
