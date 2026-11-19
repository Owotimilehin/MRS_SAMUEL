import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, inboxHoursProfile, inboxPhoneNumber, inboxTeam } from "@ms/db";
import { clearPageTokenCache } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 01: /v1/channels (connect a Facebook Page and its Instagram
 * account) and the phone-only rules on /v1/inbox/settings/numbers. Graph API
 * calls are stubbed; nothing reaches Meta. The Page token below is fake.
 */

const PAGE_TOKEN = "itest-page-token-must-never-leak";

type GraphPage = { id: string; name: string; tasks: string[]; instagram_business_account?: { id: string; username: string } };

/** What the stubbed Meta knows. Tests change these between steps. */
const pages = new Map<string, GraphPage>([
  [
    "100001",
    {
      id: "100001",
      name: "Mrs Samuel fruit juice",
      tasks: ["ANALYZE", "MESSAGING", "MODERATE"],
      instagram_business_account: { id: "17840000001", username: "mrs_samuelfruitjuice" },
    },
  ],
  [
    "100002",
    { id: "100002", name: "Second Page", tasks: ["ANALYZE"], instagram_business_account: { id: "17840000002", username: "second_ig" } },
  ],
  ["100003", { id: "100003", name: "No Instagram Page", tasks: ["MESSAGING"] }],
  ["100004", { id: "100004", name: "Refused Page", tasks: ["MESSAGING"] }],
]);
/** Pages that appear in me/accounts. */
const listed = ["100001", "100002"];
/** Pages whose token Meta refuses. */
const tokenRefused = new Set(["100004"]);

const graphCalls: string[] = [];
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    graphCalls.push(href);
    const url = new URL(href);
    const node = url.pathname.split("/").filter(Boolean)[1] ?? "";
    const fields = url.searchParams.get("fields") ?? "";
    if (node === "me" && url.pathname.endsWith("/accounts")) {
      return json({ data: listed.map((id) => pages.get(id)!), paging: {} });
    }
    const page = pages.get(node);
    if (!page) return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
    if (fields === "access_token") {
      if (tokenRefused.has(node)) return json({ error: { message: "Permissions error", code: 200 } }, 403);
      return json({ id: page.id, access_token: PAGE_TOKEN });
    }
    return json({
      id: page.id,
      name: page.name,
      ...(page.instagram_business_account ? { instagram_business_account: page.instagram_business_account } : {}),
    });
  }) as typeof fetch;
}

type ChannelRow = {
  id: string;
  kind: string;
  label: string;
  e164: string | null;
  external_id: string | null;
  page_external_id: string | null;
  external_name: string | null;
  channels: string;
  default_team_id: string | null;
  hours_profile_id: string | null;
  is_active: boolean;
  open_conversations: number;
};

describe("suite spec 01 — /v1/channels", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let manager: string;
  let phoneId: string;
  let teamId: string;
  let hoursId: string;
  /** Every response body this file has seen, to prove the Page token never leaves the server. */
  const bodies: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads many response shapes
  async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function rowOf(kind: string, externalId: string) {
    return db
      .select()
      .from(inboxPhoneNumber)
      .where(and(eq(inboxPhoneNumber.kind, kind), eq(inboxPhoneNumber.externalId, externalId)));
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-secret";
    process.env.META_SYSTEM_USER_TOKEN = "itest-system-user-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    clearPageTokenCache();
    await seedOwner(db);
    await seedUser(db, { email: "manager@example.com", role: "manager" });

    const [team] = await db.insert(inboxTeam).values({ name: "Social" }).returning();
    teamId = team!.id;
    const [hours] = await db.insert(inboxHoursProfile).values({ name: "Shop hours" }).returning();
    hoursId = hours!.id;
    const [phone] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: "1098765432" })
      .returning();
    phoneId = phone!.id;
    // Page 100002: its Instagram account is connected and on; its Messenger row is switched off.
    await db.insert(inboxPhoneNumber).values([
      { kind: "instagram", e164: null, externalId: "17840000002", pageExternalId: "100002", externalName: "second_ig", label: "Second IG", channels: "whatsapp" },
      {
        kind: "messenger",
        e164: null,
        externalId: "100002",
        pageExternalId: "100002",
        externalName: "Second Page",
        label: "Second FB",
        channels: "whatsapp",
        isActive: false,
      },
    ]);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("every /v1/channels route answers 403 without channels.manage", async () => {
    const someId = "00000000-0000-4000-8000-000000000000";
    const attempts: [string, string, unknown?][] = [
      ["GET", "/v1/channels"],
      ["GET", "/v1/channels/available"],
      ["GET", "/v1/channels/available/100001"],
      ["POST", "/v1/channels/connect", { page_id: "100001", messenger: true, instagram: false }],
      ["PATCH", `/v1/channels/${someId}`, { label: "x" }],
      ["POST", `/v1/channels/${someId}/check`],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(await rowOf("messenger", "100001")).toHaveLength(0);
  });

  it("GET /available answers 503 in plain words when Meta is not configured", async () => {
    const saved = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;
    try {
      const res = await call(owner, "GET", "/v1/channels/available");
      expect(res.status).toBe(503);
      expect(res.json.error).toMatchObject({ code: "service_unavailable", message: "Meta is not connected on this server." });
    } finally {
      process.env.META_SYSTEM_USER_TOKEN = saved;
    }
  });

  it("GET /available lists the Page and its Instagram account and marks connected ones", async () => {
    const res = await call(owner, "GET", "/v1/channels/available");
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual([
      {
        page_id: "100001",
        name: "Mrs Samuel fruit juice",
        can_message: true,
        messenger_connected: false,
        instagram: { id: "17840000001", username: "mrs_samuelfruitjuice", connected: false },
      },
      {
        page_id: "100002",
        name: "Second Page",
        can_message: false,
        messenger_connected: false, // switched off counts as not connected
        instagram: { id: "17840000002", username: "second_ig", connected: true },
      },
    ]);

    const one = await call(owner, "GET", "/v1/channels/available/100003");
    expect(one.status).toBe(200);
    expect(one.json.data).toEqual({ page_id: "100003", name: "No Instagram Page", can_message: true, messenger_connected: false, instagram: null });
    expect((await call(owner, "GET", "/v1/channels/available/12ab")).status).toBe(400);
  });

  it("POST /connect creates a messenger row and an instagram row with ids taken from Meta, not from the request", async () => {
    const res = await call(owner, "POST", "/v1/channels/connect", {
      page_id: "100001",
      messenger: true,
      instagram: true,
      label_messenger: "Facebook",
      label_instagram: "Instagram",
      default_team_id: teamId,
      hours_profile_id: hoursId,
      // Ignored: the browser never decides these.
      instagram_id: "99999999",
      external_name: "Not what Meta says",
    });
    expect(res.status).toBe(201);
    const rows = res.json.data as ChannelRow[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "messenger")).toMatchObject({
      label: "Facebook",
      e164: null,
      external_id: "100001",
      page_external_id: "100001",
      external_name: "Mrs Samuel fruit juice",
      channels: "whatsapp",
      default_team_id: teamId,
      hours_profile_id: hoursId,
      is_active: true,
      open_conversations: 0,
    });
    expect(rows.find((r) => r.kind === "instagram")).toMatchObject({
      label: "Instagram",
      external_id: "17840000001",
      page_external_id: "100001",
      external_name: "mrs_samuelfruitjuice",
    });
    expect(await rowOf("instagram", "99999999")).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "channels.connect"));
    expect(audits).toHaveLength(2);

    const after = await call(owner, "GET", "/v1/channels/available");
    expect(after.json.data[0]).toMatchObject({ messenger_connected: true, instagram: { connected: true } });

    const list = await call(owner, "GET", "/v1/channels");
    expect(list.status).toBe(200);
    expect((list.json.data as ChannelRow[]).map((r) => r.kind)).toEqual(["instagram", "instagram", "messenger", "messenger", "phone"]);
    expect(list.json.teams).toEqual([{ id: teamId, name: "Social" }]);
    expect(list.json.hours_profiles).toEqual([{ id: hoursId, name: "Shop hours" }]);
  });

  it("POST /connect twice does not duplicate; a switched-off row is switched back on", async () => {
    const [fb] = await rowOf("messenger", "100001");
    const again = await call(owner, "POST", "/v1/channels/connect", { page_id: "100001", messenger: true, instagram: false });
    expect(again.status).toBe(201);
    expect(await rowOf("messenger", "100001")).toHaveLength(1);
    expect(again.json.data[0]).toMatchObject({ id: fb!.id, label: "Facebook", default_team_id: teamId }); // kept

    expect((await call(owner, "PATCH", `/v1/channels/${fb!.id}`, { is_active: false })).status).toBe(200);
    const back = await call(owner, "POST", "/v1/channels/connect", { page_id: "100001", messenger: true, instagram: false });
    expect(back.json.data[0]).toMatchObject({ id: fb!.id, is_active: true });

    const [second] = await rowOf("messenger", "100002");
    expect(second!.isActive).toBe(false);
    const on = await call(owner, "POST", "/v1/channels/connect", { page_id: "100002", messenger: true, instagram: false });
    expect(on.status).toBe(201);
    expect(on.json.data[0]).toMatchObject({ id: second!.id, is_active: true, label: "Second FB" });
    expect(await rowOf("messenger", "100002")).toHaveLength(1);
  });

  it("POST /connect refuses instagram when the Page has none (400)", async () => {
    const res = await call(owner, "POST", "/v1/channels/connect", { page_id: "100003", messenger: true, instagram: true });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toBe("This Page has no Instagram account linked to it.");
    expect(await rowOf("messenger", "100003")).toHaveLength(0);
    // Neither box ticked is a validation error.
    expect((await call(owner, "POST", "/v1/channels/connect", { page_id: "100003", messenger: false, instagram: false })).status).toBe(400);
  });

  it("POST /connect returns 409 with a plain sentence when Meta refuses the Page token", async () => {
    const res = await call(owner, "POST", "/v1/channels/connect", { page_id: "100004", messenger: true, instagram: false });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe(
      "Meta would not give us access to this Page. Check it is assigned to our system user with messaging rights.",
    );
    expect(res.json.error.details.meta_code).toBe("200");
    expect(await rowOf("messenger", "100004")).toHaveLength(0);
  });

  it("PATCH refuses a phone row (400) and updates label, team, hours and is_active on others, with an audit row", async () => {
    const phone = await call(owner, "PATCH", `/v1/channels/${phoneId}`, { label: "Nope" });
    expect(phone.status).toBe(400);
    expect(phone.json.error.message).toBe("Phone lines are changed under Settings, Numbers.");

    const [ig] = await rowOf("instagram", "17840000001");
    const upd = await call(owner, "PATCH", `/v1/channels/${ig!.id}`, { label: "Insta DMs", default_team_id: null, hours_profile_id: null });
    expect(upd.status).toBe(200);
    expect(upd.json.data).toMatchObject({ label: "Insta DMs", default_team_id: null, hours_profile_id: null, is_active: true });
    const off = await call(owner, "PATCH", `/v1/channels/${ig!.id}`, { is_active: false });
    expect(off.json.data.is_active).toBe(false);
    const on = await call(owner, "PATCH", `/v1/channels/${ig!.id}`, { is_active: true });
    expect(on.json.data.is_active).toBe(true);

    const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, ig!.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["channels.update", "channels.switch_off", "channels.switch_on"]));
    expect((await call(owner, "PATCH", `/v1/channels/${ig!.id}`, { kind: "phone" })).status).toBe(400); // strict body
    expect((await call(owner, "PATCH", "/v1/channels/00000000-0000-4000-8000-000000000000", { label: "x" })).status).toBe(404);
  });

  it("POST /:id/check reports a problem when the Instagram account is no longer linked", async () => {
    const [fb] = await rowOf("messenger", "100001");
    const [ig] = await rowOf("instagram", "17840000001");
    const ok = await call(owner, "POST", `/v1/channels/${fb!.id}/check`);
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ ok: true, problem: null, external_name: "Mrs Samuel fruit juice" });

    pages.set("100001", { ...pages.get("100001")!, instagram_business_account: { id: "17840000999", username: "someone_else" } });
    const bad = await call(owner, "POST", `/v1/channels/${ig!.id}/check`);
    expect(bad.status).toBe(200);
    expect(bad.json.data).toMatchObject({ ok: false, problem: "This Instagram account is no longer linked to the Facebook Page." });

    // A refused token is reported in plain words, still 200.
    tokenRefused.add("100001");
    const refused = await call(owner, "POST", `/v1/channels/${fb!.id}/check`);
    expect(refused.status).toBe(200);
    expect(refused.json.data).toMatchObject({
      ok: false,
      problem: "Meta says we are not allowed to see this Page. Ask the technical lead to check the Page is assigned to our system user.",
    });
    tokenRefused.delete("100001");
    expect((await call(owner, "POST", `/v1/channels/${phoneId}/check`)).status).toBe(400);
  });

  it("no response body ever contains the stubbed page token string", async () => {
    expect(bodies.length).toBeGreaterThan(10);
    expect(bodies.some((b) => b.includes(PAGE_TOKEN))).toBe(false);
    // The token was really fetched (so the check above means something).
    expect(graphCalls.some((u) => u.includes("fields=access_token"))).toBe(true);
  });

  it("GET /inbox/settings/numbers returns phones only; ?kind=all returns everything", async () => {
    const phones = await call(owner, "GET", "/v1/inbox/settings/numbers");
    expect(phones.status).toBe(200);
    expect((phones.json.data as { kind: string }[]).map((n) => n.kind)).toEqual(["phone"]);
    const all = await call(owner, "GET", "/v1/inbox/settings/numbers?kind=all");
    expect((all.json.data as { kind: string }[]).map((n) => n.kind).sort()).toEqual(["instagram", "instagram", "messenger", "messenger", "phone"]);
  });

  it("PATCH /inbox/settings/numbers/:id answers 404 for a messenger row", async () => {
    const [fb] = await rowOf("messenger", "100001");
    const res = await call(owner, "PATCH", `/v1/inbox/settings/numbers/${fb!.id}`, { label: "Changed here" });
    expect(res.status).toBe(404);
    expect((await call(owner, "POST", `/v1/inbox/settings/numbers/${fb!.id}/refresh`)).status).toBe(404);
    expect((await call(owner, "PATCH", `/v1/inbox/settings/numbers/${phoneId}`, { label: "Main line" })).status).toBe(200);
  });
});
