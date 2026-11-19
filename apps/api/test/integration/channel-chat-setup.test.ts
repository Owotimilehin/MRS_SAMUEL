import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, channelChatSetup, inboxPhoneNumber, outboxEvent } from "@ms/db";
import { clearPageTokenCache } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import { clearChatSetupCache } from "../../src/routes/channel-chat-setup.js";

/**
 * Suite spec 04: /v1/channels/:accountId/chat-setup. The Graph API is stubbed:
 * the stub keeps one in-memory Messenger Profile per platform (messenger and
 * instagram), applies POST and DELETE to it, answers GET from it, and can be told to
 * refuse, time out, or time out after applying the next matching call.
 * Nothing reaches Meta. The tokens below are fake.
 */

const PAGE_SECRET = "itest-page-secret-must-never-leak";
const SYSTEM_SECRET = "itest-system-user-secret";
const PAGE_ID = "100200300";
const IG_ID = "17841400000000001";
const OFF_PAGE_ID = "100200400";

type Profile = Record<string, unknown>;
type Injected = {
  method: "GET" | "POST" | "DELETE";
  /** How many matching calls to let through first. */
  skip?: number;
  action: "refuse" | "timeout" | "timeout-applied";
  code?: number;
  message?: string;
};

interface GraphCall {
  method: string;
  path: string;
  platformQuery: string | null;
  body: Record<string, unknown> | null;
  auth: string;
}

const profiles = new Map<string, Profile>();
let injected: Injected[] = [];
let calls: GraphCall[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function resetStub(): void {
  profiles.clear();
  profiles.set("messenger", {});
  profiles.set("instagram", {});
  injected = [];
  calls = [];
}

const profileCalls = () => calls.filter((c) => c.path.endsWith("/me/messenger_profile"));

/**
 * Meta error 190 on a Page-token call makes the suite fetch a fresh Page token and try
 * once more, so a refusal that should stick has to be injected twice.
 */
function refuseTwice(method: Injected["method"], code: number, message: string): void {
  injected.push({ method, action: "refuse", code, message }, { method, action: "refuse", code, message });
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

    // The Page-token look-up (GET {page}?fields=access_token) is not part of what we assert on.
    if (url.searchParams.get("fields") === "access_token") return json({ id: PAGE_ID, access_token: PAGE_SECRET });

    calls.push({ method, path: url.pathname, platformQuery: url.searchParams.get("platform"), body, auth });
    if (!url.pathname.endsWith("/me/messenger_profile")) {
      return json({ error: { message: "Unsupported request", code: 100 } }, 400);
    }
    if (auth !== `Bearer ${PAGE_SECRET}`) return json({ error: { message: "A Page token is needed", code: 190 } }, 401);

    const platform = url.searchParams.get("platform") ?? (body?.platform as string | undefined) ?? "messenger";
    const store = profiles.get(platform)!;

    // A failure the test asked for on this call.
    const at = injected.findIndex((i) => i.method === method);
    if (at >= 0) {
      const item = injected[at]!;
      if (item.skip && item.skip > 0) {
        item.skip -= 1;
      } else {
        injected.splice(at, 1);
        if (item.action === "refuse") {
          return json({ error: { message: item.message ?? "Invalid parameter", code: item.code ?? 100 } }, 400);
        }
        if (item.action === "timeout-applied") applyWrite(store, method, body, platform);
        throw new TypeError("fetch failed");
      }
    }

    if (method === "GET") {
      const fields = (url.searchParams.get("fields") ?? "").split(",").filter(Boolean);
      const out: Profile = {};
      for (const f of fields) if (store[f] !== undefined) out[f] = store[f];
      return json({ data: Object.keys(out).length > 0 ? [out] : [] });
    }
    const refusal = applyWrite(store, method, body, platform);
    return refusal ?? json({ result: "success" });
  }) as typeof fetch;
}

/** Apply a POST or DELETE to a profile the way Meta does (including the menu-needs-Get-started rule, G10). */
function applyWrite(store: Profile, method: string, body: Record<string, unknown> | null, platform: string): Response | null {
  if (method === "POST") {
    const props = { ...(body ?? {}) };
    delete props.platform;
    if (props.persistent_menu && platform === "messenger" && !store.get_started && !props.get_started) {
      return json({ error: { message: "A persistent menu needs a Get Started button", code: 100 } }, 400);
    }
    Object.assign(store, props);
  } else if (method === "DELETE") {
    const fields = (body?.fields as string[] | undefined) ?? [];
    if (fields.includes("get_started") && store.persistent_menu && !fields.includes("persistent_menu")) {
      return json({ error: { message: "Remove the menu first", code: 100 } }, 400);
    }
    for (const f of fields) delete store[f];
  }
  return null;
}

const FULL = {
  greeting: "Hello {{user_first_name}}, welcome to Mrs. Samuel Fruit Juice.",
  getStarted: true,
  iceBreakers: ["What juices do you have today?", "Do you deliver to my area?"],
  menu: [
    { type: "postback", title: "Talk to us" },
    { type: "web_url", title: "Our shop", url: "https://www.mrssamuel.com" },
  ],
};
const QUESTIONS_ONLY = { greeting: null, getStarted: false, iceBreakers: ["Only one question?"], menu: [] };
const ONE_QUESTION_LIVE = {
  ice_breakers: [{ locale: "default", call_to_actions: [{ question: "Only one question?", payload: "ms:v1:ice:1" }] }],
};

describe("suite spec 04 — /v1/channels/:accountId/chat-setup", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let manager: string;
  let fb: string;
  let ig: string;
  let off: string;
  let phone: string;
  /** Every response body this file has seen, to prove no secret leaves the server. */
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
  const url = (id: string, tail = "") => `/v1/channels/${id}/chat-setup${tail}`;
  const rows = (accountId: string) => db.select().from(channelChatSetup).where(eq(channelChatSetup.accountId, accountId));

  async function saveDraft(id: string, config: unknown) {
    return call(owner, "PUT", url(id, "/draft"), { config });
  }
  async function publish(id: string, version: number) {
    return call(owner, "POST", url(id, "/publish"), { version, confirm: true });
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-secret";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_SECRET;
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    await seedOwner(db);
    await seedUser(db, { email: "manager@example.com", role: "manager" });

    const [p] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: "1098765432" })
      .returning();
    phone = p!.id;
    const inserted = await db
      .insert(inboxPhoneNumber)
      .values([
        { kind: "messenger", e164: null, externalId: PAGE_ID, pageExternalId: PAGE_ID, externalName: "Mrs Samuel fruit juice", label: "Facebook Page", channels: "whatsapp" },
        { kind: "instagram", e164: null, externalId: IG_ID, pageExternalId: PAGE_ID, externalName: "mrs_samuelfruitjuice", label: "Instagram", channels: "whatsapp" },
        { kind: "messenger", e164: null, externalId: OFF_PAGE_ID, pageExternalId: OFF_PAGE_ID, externalName: "Old Page", label: "Old Page", channels: "whatsapp", isActive: false },
      ])
      .returning({ id: inboxPhoneNumber.id, externalId: inboxPhoneNumber.externalId });
    fb = inserted.find((r) => r.externalId === PAGE_ID)!.id;
    ig = inserted.find((r) => r.externalId === IG_ID)!.id;
    off = inserted.find((r) => r.externalId === OFF_PAGE_ID)!.id;

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
  }, 120_000);

  beforeEach(async () => {
    resetStub();
    clearChatSetupCache();
    clearPageTokenCache();
    await db.delete(channelChatSetup);
  });

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("needs channels.manage; a phone account answers 404", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", url(fb)],
      ["PUT", url(fb, "/draft"), { config: FULL }],
      ["POST", url(fb, "/draft/from-live")],
      ["DELETE", url(fb, "/draft")],
      ["POST", url(fb, "/publish"), { version: 1, confirm: true }],
      ["POST", url(fb, "/refresh")],
      ["GET", url(fb, "/history")],
      ["POST", url(fb, "/history/1/restore")],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(calls).toHaveLength(0);
    expect(await rows(fb)).toHaveLength(0);

    for (const id of [phone, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await call(owner, "GET", url(id))).status, id).toBe(404);
      expect((await call(owner, "PUT", url(id, "/draft"), { config: FULL })).status, id).toBe(404);
    }
  });

  it("GET shows the live set-up read from Meta and no draft", async () => {
    profiles.set("messenger", {
      get_started: { payload: "ms:v1:start" },
      greeting: [{ locale: "default", text: "Hello from Meta" }],
      ice_breakers: [{ locale: "default", call_to_actions: [{ question: "Live question?", payload: "ms:v1:ice:1" }] }],
    });
    const res = await call(owner, "GET", url(fb));
    expect(res.status).toBe(200);
    const v = res.json.data;
    expect(v.account).toMatchObject({ id: fb, label: "Facebook Page", kind: "messenger", is_active: true });
    expect(v.supports).toEqual({ greeting: true, getStarted: true, iceBreakers: true, menu: true });
    expect(v.limits).toMatchObject({ greetingMax: 160, iceBreakerCount: 4, menuCount: 5 });
    expect(v.draft).toBeNull();
    expect(v.live.config).toEqual({ greeting: "Hello from Meta", getStarted: true, iceBreakers: ["Live question?"], menu: [] });
    expect(v.live).toMatchObject({ other_locales: [], foreign_payloads: false, composer_disabled: false });
    expect(v.live_error).toBeNull();
    expect(v.last_publish).toBeNull();
    expect(v.can_publish_at).toBeNull();
    // The read used the Page token.
    expect(profileCalls()[0]!.auth).toBe(`Bearer ${PAGE_SECRET}`);
    // A second GET inside five minutes comes from the cache.
    await call(owner, "GET", url(fb));
    expect(profileCalls()).toHaveLength(1);

    const insta = await call(owner, "GET", url(ig));
    expect(insta.json.data.supports).toEqual({ greeting: false, getStarted: false, iceBreakers: true, menu: true });
    expect(insta.json.data.live.config).toEqual({ greeting: null, getStarted: false, iceBreakers: [], menu: [] });
  });

  it("GET answers 200 with a plain reason when Meta cannot be read", async () => {
    refuseTwice("GET", 190, "Token expired");
    const res = await call(owner, "GET", url(fb));
    expect(res.status).toBe(200);
    expect(res.json.data.live).toBeNull();
    expect(res.json.data.live_error).toBe("The suite has lost its permission for this account. Ask the owner to check Channels.");
  });

  it("PUT /draft validates and stores one draft per account", async () => {
    const bad = await saveDraft(fb, { ...FULL, greeting: "x".repeat(161) });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe("The welcome text is too long. Keep it to 160 characters.");
    expect(await rows(fb)).toHaveLength(0);

    const first = await saveDraft(fb, FULL);
    expect(first.status).toBe(200);
    expect(first.json.data.draft).toMatchObject({ version: 1, config: FULL });
    const second = await saveDraft(fb, { ...FULL, iceBreakers: ["Changed?"] });
    expect(second.json.data.draft).toMatchObject({ version: 1 });
    expect(second.json.data.draft.config.iceBreakers).toEqual(["Changed?"]);
    expect(await rows(fb)).toHaveLength(1);

    // Instagram: greeting and Get started are cleared by the server even if a client sends them (R1).
    const insta = await saveDraft(ig, FULL);
    expect(insta.status).toBe(200);
    expect(insta.json.data.draft.config).toMatchObject({ greeting: null, getStarted: false });
    expect(insta.json.data.draft.config.iceBreakers).toHaveLength(2);
    expect(await rows(ig)).toHaveLength(1);

    // A menu forces Get started on for Messenger (R2).
    const forced = await saveDraft(fb, { ...FULL, getStarted: false });
    expect(forced.json.data.draft.config.getStarted).toBe(true);

    const dup = await saveDraft(fb, { ...FULL, iceBreakers: ["Same?", "same?"] });
    expect(dup.status).toBe(400);
    expect(dup.json.error.message).toBe("Starter questions 1 and 2 are the same.");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "channels.chat_setup_draft"));
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it("DELETE /draft removes the draft; a draft holds no history", async () => {
    await saveDraft(fb, FULL);
    const res = await call(owner, "DELETE", url(fb, "/draft"));
    expect(res.status).toBe(200);
    expect(res.json.data.draft).toBeNull();
    expect(await rows(fb)).toHaveLength(0);
  });

  it("POST /draft/from-live copies what Meta shows into the draft; 409 when Meta cannot be read", async () => {
    profiles.set("messenger", { ice_breakers: [{ locale: "default", call_to_actions: [{ question: "From Meta?", payload: "ms:v1:ice:1" }] }] });
    const ok = await call(owner, "POST", url(fb, "/draft/from-live"));
    expect(ok.status).toBe(200);
    expect(ok.json.data.draft.config.iceBreakers).toEqual(["From Meta?"]);

    clearChatSetupCache();
    injected.push({ method: "GET", action: "timeout" });
    const bad = await call(owner, "POST", url(fb, "/draft/from-live"));
    expect(bad.status).toBe(409);
    expect(bad.json.error.message).toBe("We could not read the live set-up from Meta. Try again in a few minutes.");
  });

  it("publish: sends delete then set, reads back, marks the row live and the previous live row superseded, writes an audit row", async () => {
    // Version 1: nothing live. Set A (welcome text, Get started, questions), then set B (menu), between two reads.
    await saveDraft(fb, FULL);
    calls = []; // saving a draft reads Meta once for the screen; count only the publish
    const first = await publish(fb, 1);
    expect(first.status).toBe(200);
    expect(first.json.data.last_publish).toMatchObject({ version: 1, status: "live", error_code: null });
    expect(profileCalls().map((c) => c.method)).toEqual(["GET", "POST", "POST", "GET"]);
    expect(Object.keys(profileCalls()[1]!.body!)).toEqual(["greeting", "get_started", "ice_breakers"]);
    expect(Object.keys(profileCalls()[2]!.body!)).toEqual(["persistent_menu"]);
    expect(profiles.get("messenger")!.get_started).toEqual({ payload: "ms:v1:start" });
    expect(first.json.data.live.config).toEqual(FULL);
    expect(first.json.data.draft).toBeNull();

    // Version 2: questions only. The old welcome text, Get started and menu go in one delete.
    await saveDraft(fb, QUESTIONS_ONLY);
    calls = [];
    const second = await publish(fb, 2);
    expect(second.status).toBe(200);
    expect(profileCalls().map((c) => c.method)).toEqual(["GET", "DELETE", "POST", "GET"]);
    expect(profileCalls()[1]!.body).toEqual({ fields: ["get_started", "greeting", "persistent_menu"] });
    expect(Object.keys(profileCalls()[2]!.body!)).toEqual(["ice_breakers"]);
    expect(Object.keys(profiles.get("messenger")!)).toEqual(["ice_breakers"]);

    const all = await rows(fb);
    expect(all.find((r) => r.version === 1)!.status).toBe("superseded");
    const v2 = all.find((r) => r.version === 2)!;
    expect(v2.status).toBe("live");
    expect(v2.pushedByUserId).not.toBeNull();
    expect(v2.pushedAt).not.toBeNull();
    expect(v2.liveBefore).toMatchObject({ get_started: { payload: "ms:v1:start" } });
    expect(v2.liveAfter).toHaveProperty("ice_breakers");
    expect((v2.steps as { op: string; ok: boolean }[]).map((s) => `${s.op}:${s.ok}`)).toEqual([
      "read:true",
      "delete:true",
      "set:true",
      "read:true",
    ]);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "channels.chat_setup_publish"));
    expect(audits).toHaveLength(2);
    const a2 = audits.find((a) => a.entityId === v2.id)!;
    expect(a2.entityType).toBe("channel_chat_setup");
    expect(a2.beforeJson).toMatchObject({ greeting: FULL.greeting });
    expect(a2.afterJson).toMatchObject({ status: "live", config: { iceBreakers: ["Only one question?"] } });
  });

  it("publish with nothing to change makes no set or delete call and ends live (R6)", async () => {
    profiles.set("messenger", { ...ONE_QUESTION_LIVE });
    await saveDraft(fb, QUESTIONS_ONLY);
    calls = [];
    const res = await publish(fb, 1);
    expect(res.status).toBe(200);
    expect(profileCalls().map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(res.json.data.last_publish.status).toBe("live");
  });

  it("publish: instagram calls carry platform=instagram and never greeting or get_started", async () => {
    await saveDraft(ig, FULL);
    calls = [];
    const res = await publish(ig, 1);
    expect(res.status).toBe(200);
    const pc = profileCalls();
    expect(pc.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    for (const c of pc) expect(c.platformQuery, c.method).toBe("instagram");
    expect(pc[1]!.body).toMatchObject({ platform: "instagram" });
    expect(Object.keys(pc[1]!.body!).sort()).toEqual(["ice_breakers", "persistent_menu", "platform"]);
    const text = JSON.stringify(pc.map((c) => c.body));
    expect(text).not.toContain("greeting");
    expect(text).not.toContain("get_started");
    expect(text).not.toContain("composer_input_disabled");
    expect(text).not.toContain("webview_height_ratio");
    // The Messenger profile was left alone.
    expect(profiles.get("messenger")).toEqual({});
    expect(res.json.data.live.config.iceBreakers).toEqual(FULL.iceBreakers);
  });

  it("publish: Meta refusal → 502, row failed with Meta's code, draft content unchanged", async () => {
    await saveDraft(fb, FULL);
    injected.push({ method: "POST", action: "refuse", code: 100, message: "Invalid parameter" });
    const res = await publish(fb, 1);
    expect(res.status).toBe(502);
    expect(res.json.data.last_publish).toMatchObject({
      version: 1,
      status: "failed",
      error_code: "100",
      error_message: "Meta refused this: Invalid parameter (code 100).",
    });
    const [row] = await rows(fb);
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("100");
    expect(row!.config).toEqual(FULL);
    // Nothing was applied; the steps say where it stopped.
    expect((row!.steps as { op: string; ok: boolean }[]).map((s) => `${s.op}:${s.ok}`)).toEqual([
      "read:true",
      "set:false",
      "read:true",
    ]);
    // Try again: the same version publishes (R10).
    const again = await publish(fb, 1);
    expect(again.status).toBe(200);
    expect((await rows(fb))[0]!.status).toBe("live");
  });

  it("publish: a permission refusal raises one owner alert per account per day", async () => {
    await db.delete(outboxEvent).where(eq(outboxEvent.eventType, "channels.chat_setup_config"));
    await saveDraft(fb, QUESTIONS_ONLY);
    refuseTwice("POST", 190, "Session expired");
    const res = await publish(fb, 1);
    expect(res.status).toBe(502);
    expect(res.json.data.last_publish.error_message).toBe(
      "The suite has lost its permission for this account. Ask the owner to check Channels.",
    );
    refuseTwice("POST", 190, "Session expired");
    expect((await publish(fb, 1)).status).toBe(502);
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "channels.chat_setup_config"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account_id: fb, label: "Facebook Page", code: "190" });
  });

  it("publish: timeout then matching read-back → live", async () => {
    await saveDraft(fb, { ...QUESTIONS_ONLY, greeting: "Hello" });
    injected.push({ method: "POST", action: "timeout-applied" });
    const res = await publish(fb, 1);
    expect(res.status).toBe(200);
    expect(res.json.data.last_publish.status).toBe("live");
    const [row] = await rows(fb);
    expect((row!.steps as { op: string; ok: boolean }[]).map((s) => `${s.op}:${s.ok}`)).toEqual([
      "read:true",
      "set:false",
      "read:true",
    ]);
  });

  it("publish: timeout then failing read-back → unknown", async () => {
    await saveDraft(fb, QUESTIONS_ONLY);
    injected.push({ method: "POST", action: "timeout" });
    injected.push({ method: "GET", skip: 1, action: "timeout" });
    const res = await publish(fb, 1);
    expect(res.status).toBe(502);
    expect(res.json.data.last_publish.status).toBe("unknown");
    expect(res.json.data.last_publish.error_message).toBe(
      "No answer from Meta, so we can't tell what is live. Press Check now in a minute.",
    );
    expect((await rows(fb))[0]!.status).toBe("unknown");
    // "Unknown" can be published again.
    expect((await publish(fb, 1)).status).toBe(200);
  });

  it("publish: Meta says yes but the read-back differs → failed, and a later read that matches settles it live (R9)", async () => {
    await saveDraft(fb, QUESTIONS_ONLY);
    // The POST is accepted but not applied: wipe the profile right after it.
    const stub = globalThis.fetch;
    let wiped = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await stub(input, init);
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!wiped && href.includes("/me/messenger_profile") && (init?.method ?? "GET") === "POST") {
        wiped = true;
        profiles.set("messenger", {});
      }
      return res;
    }) as typeof fetch;
    try {
      const res = await publish(fb, 1);
      expect(res.status).toBe(502);
      expect(res.json.data.last_publish).toMatchObject({
        status: "failed",
        error_message: "Meta accepted the change but is not showing it yet",
      });
    } finally {
      globalThis.fetch = stub;
    }
    // A minute later Meta shows it.
    profiles.set("messenger", { ...ONE_QUESTION_LIVE });
    clearChatSetupCache();
    const after = await call(owner, "GET", url(fb));
    expect(after.json.data.last_publish.status).toBe("live");
    expect((await rows(fb))[0]!.status).toBe("live");
  });

  it("publish: third publish within 10 minutes → 429 and no Graph call (Messenger and Instagram count together)", async () => {
    await saveDraft(fb, FULL);
    expect((await publish(fb, 1)).status).toBe(200);
    await saveDraft(ig, FULL);
    expect((await publish(ig, 1)).status).toBe(200);

    const view = await call(owner, "GET", url(fb));
    expect(view.json.data.can_publish_at).not.toBeNull();

    await saveDraft(fb, QUESTIONS_ONLY);
    calls = [];
    const third = await publish(fb, 2);
    expect(third.status).toBe(429);
    expect(third.json.error.message).toMatch(
      /^Meta allows only a few set-up changes every 10 minutes\. You can publish again at \d\d:\d\d\.$/,
    );
    expect(calls).toHaveLength(0);
    // The draft is still there.
    expect((await rows(fb)).find((r) => r.version === 2)!.status).toBe("draft");
  });

  it("M6: every try of the same version counts towards the 10-minute limit, so a third \"Try again\" is refused", async () => {
    await saveDraft(fb, FULL);
    injected.push({ method: "POST", action: "refuse", code: 100, message: "Invalid parameter" });
    expect((await publish(fb, 1)).status).toBe(502);
    injected.push({ method: "POST", action: "refuse", code: 100, message: "Invalid parameter" });
    expect((await publish(fb, 1)).status).toBe(502);
    expect((await rows(fb))[0]!.status).toBe("failed");

    calls = [];
    const third = await publish(fb, 1);
    expect(third.status).toBe(429);
    expect(third.json.error.message).toMatch(/^Meta allows only a few set-up changes every 10 minutes\./);
    expect(calls).toHaveLength(0);
    expect((await call(owner, "GET", url(fb))).json.data.can_publish_at).not.toBeNull();
  });

  it("publish without confirm:true → 400 and nothing reaches Meta", async () => {
    await saveDraft(fb, FULL);
    calls = [];
    for (const body of [{ version: 1 }, { version: 1, confirm: false }, { version: 1, confirm: "true" }, { confirm: true }]) {
      expect((await call(owner, "POST", url(fb, "/publish"), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect((await rows(fb))[0]!.status).toBe("draft");
  });

  it("publish: a version that does not exist is 404; a live one cannot be published again (409)", async () => {
    expect((await publish(fb, 9)).status).toBe(404);
    await saveDraft(fb, QUESTIONS_ONLY);
    expect((await publish(fb, 1)).status).toBe(200);
    expect((await publish(fb, 1)).status).toBe(409);
  });

  it("refresh re-reads Meta, but not within three minutes of a read (429)", async () => {
    const first = await call(owner, "POST", url(fb, "/refresh"));
    expect(first.status).toBe(200);
    const second = await call(owner, "POST", url(fb, "/refresh"));
    expect(second.status).toBe(429);
    expect(second.json.error.message).toBe("Checked a moment ago. Try again in a few minutes.");
    expect(profileCalls()).toHaveLength(1);
  });

  it("history lists versions newest first; restore copies an old version into the draft", async () => {
    await saveDraft(fb, FULL);
    expect((await publish(fb, 1)).status).toBe(200);
    await saveDraft(fb, QUESTIONS_ONLY);
    expect((await call(owner, "GET", url(fb))).json.data.draft.version).toBe(2);

    const history = await call(owner, "GET", url(fb, "/history"));
    expect(history.status).toBe(200);
    expect(history.json.data).toHaveLength(1);
    expect(history.json.data[0]).toMatchObject({ version: 1, status: "live", config: FULL });

    const restored = await call(owner, "POST", url(fb, "/history/1/restore"));
    expect(restored.status).toBe(200);
    expect(restored.json.data.draft).toMatchObject({ version: 2, config: FULL });
    expect((await rows(fb)).filter((r) => r.status === "draft")).toHaveLength(1);

    expect((await call(owner, "POST", url(fb, "/history/7/restore"))).status).toBe(404);
    // The draft row itself is not history.
    expect((await call(owner, "POST", url(fb, "/history/2/restore"))).status).toBe(404);
  });

  it("a publish stuck in pushing for over two minutes becomes unknown on the next GET; a fresh one is left alone", async () => {
    await db.insert(channelChatSetup).values({
      accountId: fb,
      version: 1,
      status: "pushing",
      config: QUESTIONS_ONLY,
      pushedAt: new Date(Date.now() - 5 * 60_000),
    });
    const res = await call(owner, "GET", url(fb));
    expect(res.json.data.last_publish).toMatchObject({
      status: "unknown",
      error_message: "The publish was interrupted. Check what is live, then publish again.",
    });
    await db.update(channelChatSetup).set({ status: "pushing", pushedAt: new Date() }).where(eq(channelChatSetup.accountId, fb));
    expect((await call(owner, "GET", url(fb))).json.data.last_publish.status).toBe("pushing");
  });

  it("a switched-off account can be read but not changed (R17)", async () => {
    const res = await call(owner, "GET", url(off));
    expect(res.status).toBe(200);
    expect(res.json.data.account.is_active).toBe(false);
    const attempts: [string, string, unknown?][] = [
      ["PUT", url(off, "/draft"), { config: QUESTIONS_ONLY }],
      ["DELETE", url(off, "/draft")],
      ["POST", url(off, "/draft/from-live")],
      ["POST", url(off, "/publish"), { version: 1, confirm: true }],
      ["POST", url(off, "/history/1/restore")],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(owner, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(409);
      expect(r.json.error.message).toBe("This account is switched off in Channels.");
    }
  });

  it("a publish never sends or deletes anything but the four properties (R5)", async () => {
    const outside = { whitelisted_domains: ["https://example.com"], commands: [{ locale: "default", commands: [] }] };
    profiles.set("messenger", { ...outside });
    await saveDraft(fb, FULL);
    expect((await publish(fb, 1)).status).toBe(200);
    await saveDraft(fb, { greeting: null, getStarted: false, iceBreakers: [], menu: [] });
    expect((await publish(fb, 2)).status).toBe(200);
    const allowed = new Set(["get_started", "greeting", "ice_breakers", "persistent_menu"]);
    for (const c of profileCalls().filter((x) => x.method !== "GET")) {
      const keys = c.method === "DELETE" ? (c.body!.fields as string[]) : Object.keys(c.body!);
      for (const k of keys) expect(allowed.has(k), `${c.method} ${k}`).toBe(true);
    }
    expect(profiles.get("messenger")).toEqual(outside);
  });

  it("no response body, step, saved version or audit row contains a token", async () => {
    await saveDraft(fb, FULL);
    await publish(fb, 1);
    await call(owner, "GET", url(fb));
    await call(owner, "GET", url(fb, "/history"));
    const everything = [
      ...bodies,
      JSON.stringify(await db.select().from(channelChatSetup)),
      JSON.stringify(await db.select().from(auditLog).where(sql`${auditLog.action} like 'channels.chat_setup%'`)),
      JSON.stringify(await db.select().from(outboxEvent)),
    ].join("\n");
    expect(everything).not.toContain(PAGE_SECRET);
    expect(everything).not.toContain(SYSTEM_SECRET);
  });
});
