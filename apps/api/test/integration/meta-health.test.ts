import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { appSetting } from "@ms/db";
import { META_HEALTH_KEY, type MetaHealthValue } from "@ms/shared";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Watchdog (blueprint stage 1): GET /v1/meta-health returns what the worker's
 * hourly check stored. Meta is never called. Needs Docker (testcontainers).
 */
describe("GET /v1/meta-health", () => {
  let container: StartedPostgreSqlContainer;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let manager: string;
  let staff: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads the JSON shape
  async function get(cookie: string): Promise<{ status: number; json: any; text: string }> {
    const res = await fetch(`${baseUrl}/v1/meta-health`, { headers: { cookie } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_SYSTEM_USER_TOKEN = "itest-system-user-token-never-returned";
    await seedOwner(db);
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    await seedUser(db, { email: "staff@example.com", role: "branch_staff" });
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    staff = await loginAs(baseUrl, "staff@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("answers an empty, stale record before the first check", async () => {
    const r = await get(owner);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ checked_at: null, stale: true, overall: "ok", items: [] });
  });

  it("returns the items worst first, without alerted_at or the token; inbox.view is enough", async () => {
    const now = new Date().toISOString();
    const value: MetaHealthValue = {
      checked_at: now,
      items: {
        token: {
          key: "token", kind: "token", label: "Meta access key", line_ids: [], status: "ok",
          reason: "Meta accepts the suite's access key.", impact: "Customers are getting replies", since: now, checked_at: now, alerted_at: null,
        },
        "line:x": {
          key: "line:x", kind: "whatsapp_number", label: "WhatsApp Main line", line_ids: ["x"], status: "broken",
          reason: "Meta has banned this number from WhatsApp.", impact: "Customers on WhatsApp (Main line) are not getting replies",
          since: now, checked_at: now, alerted_at: now,
        },
      },
    };
    await db.insert(appSetting).values({ key: META_HEALTH_KEY, value });
    const r = await get(manager);
    expect(r.status).toBe(200);
    expect(r.json.data.stale).toBe(false);
    expect(r.json.data.overall).toBe("broken");
    expect(r.json.data.items.map((i: { key: string }) => i.key)).toEqual(["line:x", "token"]);
    expect(r.text).not.toContain("alerted_at");
    expect(r.text).not.toContain("itest-system-user-token");
  });

  it("is refused without inbox.view or channels.manage", async () => {
    expect((await get(staff)).status).toBe(403);
  });
});
