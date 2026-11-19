import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, inboxPhoneNumber, outboxEvent } from "@ms/db";
import { clearPageTokenCache } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import { clearPageDetailsCache, pageDetailsTimings } from "../../src/routes/channel-page-details.js";

/**
 * Suite spec 10: /v1/channels/:accountId/page. The Graph API is stubbed: the stub
 * holds one Page object in memory, applies POST bodies to it unless told to refuse,
 * ignore or time out, and answers me/accounts with configurable tasks. Nothing
 * reaches Meta. The tokens below are fake.
 */

const PAGE_TOKEN = "itest-page-token-must-never-leak";
const SYSTEM_TOKEN = "itest-system-user-token";
const PAGE_ID = "100200300";
const IG_ID = "17841400000000001";
const OFF_PAGE_ID = "100200400";

type Obj = Record<string, unknown>;
type Inject = { action: "refuse" | "ignore" | "timeout" | "timeout-applied"; code?: number; message?: string };

interface GraphCall {
  method: string;
  path: string;
  body: Obj | null;
  auth: string;
}

const INITIAL_PAGE = (): Obj => ({
  id: PAGE_ID,
  name: "Mrs Samuel fruit juice",
  username: "mrssamuelfruitjuice",
  about: "Fresh juice in Lagos",
  description: "We press every juice to order.",
  phone: "+234 800 000 0001",
  website: "https://www.mrssamuel.com",
  emails: ["hello@mrssamuel.com"],
  hours: {
    mon_1_open: "08:00",
    mon_1_close: "18:00",
    tue_1_open: "08:00",
    tue_1_close: "18:00",
  },
  is_always_open: false,
  location: { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "100271" },
  single_line_address: "1 Allen Avenue, Ikeja, Lagos",
  category: "Juice Bar",
  link: "https://www.facebook.com/mrssamuelfruitjuice",
  cover: { source: "https://img.example.com/cover.jpg" },
  is_published: true,
  verification_status: "not_verified",
  followers_count: 120,
});
const IG_PROFILE: Obj = {
  id: IG_ID,
  username: "mrs_samuelfruitjuice",
  name: "Mrs Samuel",
  biography: "Fresh juice",
  website: "https://www.mrssamuel.com",
  profile_picture_url: "https://img.example.com/ig.jpg",
  followers_count: 80,
  media_count: 12,
};

let page: Obj = INITIAL_PAGE();
let tasks: string[] | "error" = ["MANAGE", "MODERATE"];
let postInject: Inject | null = null;
let getInject: Inject | null = null;
let calls: GraphCall[] = [];
let graphHits = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function resetStub(): void {
  page = INITIAL_PAGE();
  tasks = ["MANAGE", "MODERATE"];
  postInject = null;
  getInject = null;
  calls = [];
  graphHits = 0;
}

const pagePosts = () => calls.filter((c) => c.method === "POST");

function applyPost(body: Obj | null): void {
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === "hours") page.hours = { ...(v as Obj) };
    else if (k === "location") page.location = { ...(v as Obj) };
    else page[k] = v;
  }
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    graphHits += 1;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Obj) : null;

    // The Page-token look-up is not part of what we assert on.
    if (url.searchParams.get("fields") === "access_token") return json({ id: PAGE_ID, access_token: PAGE_TOKEN });

    calls.push({ method, path: url.pathname, body, auth });

    if (url.pathname.endsWith("/me/accounts")) {
      if (auth !== `Bearer ${SYSTEM_TOKEN}`) return json({ error: { message: "bad token", code: 190 } }, 401);
      if (tasks === "error") return json({ error: { message: "Unsupported", code: 100 } }, 400);
      return json({ data: [{ id: PAGE_ID, tasks }] });
    }
    if (auth !== `Bearer ${PAGE_TOKEN}`) return json({ error: { message: "A Page token is needed", code: 190 } }, 401);

    if (url.pathname.endsWith(`/${IG_ID}`) && method === "GET") return json(IG_PROFILE);
    // The switched-off Page is served from the same in-memory object as the main one.
    const isPage = (tail = "") => [PAGE_ID, OFF_PAGE_ID].some((id) => url.pathname.endsWith(`/${id}${tail}`));
    if (isPage("/picture")) return json({ data: { url: "https://img.example.com/picture.jpg" } });

    if (isPage()) {
      if (method === "GET") {
        if (getInject) {
          const i = getInject;
          getInject = null;
          return json({ error: { message: i.message ?? "Busy", code: i.code ?? 4 } }, 400);
        }
        const wanted = (url.searchParams.get("fields") ?? "").split(",").filter(Boolean);
        const out: Obj = {};
        for (const f of wanted) if (page[f] !== undefined) out[f] = page[f];
        return json(out);
      }
      if (method === "POST") {
        if (postInject) {
          const i = postInject;
          postInject = null;
          if (i.action === "refuse") return json({ error: { message: i.message ?? "Invalid parameter", code: i.code ?? 100 } }, 400);
          if (i.action === "ignore") return json({ success: true });
          if (i.action === "timeout-applied") applyPost(body);
          throw new TypeError("fetch failed");
        }
        applyPost(body);
        return json({ success: true });
      }
    }
    return json({ error: { message: "Unsupported request", code: 100 } }, 400);
  }) as typeof fetch;
}

describe("suite spec 10 — /v1/channels/:accountId/page", () => {
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
  /** Every response body this file has seen, to prove no token leaves the server. */
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
  const url = (id: string, tail = "") => `/v1/channels/${id}/page${tail}`;
  const audits = (accountId: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "channels.page_update"), eq(auditLog.entityId, accountId)));
  const patch = (id: string, expected: unknown, changes: unknown, extra: Obj = { confirm: true }) =>
    call(owner, "PATCH", url(id), { ...extra, expected, changes });

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-key";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    pageDetailsTimings.readBackDelayMs = 0;
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
    clearPageDetailsCache();
    clearPageTokenCache();
    await db.delete(auditLog).where(eq(auditLog.action, "channels.page_update"));
    await db.delete(outboxEvent).where(eq(outboxEvent.eventType, "channels.page_config"));
  });

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("needs channels.manage; a phone account answers 404", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", url(fb)],
      ["PATCH", url(fb), { confirm: true, expected: { about: null }, changes: { about: "x" } }],
      ["GET", url(fb, "/history")],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(graphHits).toBe(0);

    for (const id of [phone, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await call(owner, "GET", url(id))).status, id).toBe(404);
      expect((await call(owner, "GET", url(id, "/history"))).status, id).toBe(404);
      expect((await patch(id, { about: null }, { about: "x" })).status, id).toBe(404);
    }
    expect(graphHits).toBe(0);
  });

  it("GET returns the Page's details and can_edit true when tasks include MANAGE", async () => {
    const res = await call(owner, "GET", url(fb));
    expect(res.status).toBe(200);
    const v = res.json.data;
    expect(v.account).toEqual({ id: fb, label: "Facebook Page", kind: "messenger", is_active: true });
    expect(v.can_edit).toBe(true);
    expect(v.cannot_edit_reason).toBeNull();
    expect(v.instagram).toBeNull();
    expect(v.limits).toMatchObject({ aboutMax: 100, emailsMax: 3 });
    expect(v.page).toMatchObject({
      name: "Mrs Samuel fruit juice",
      username: "mrssamuelfruitjuice",
      category: "Juice Bar",
      link: "https://www.facebook.com/mrssamuelfruitjuice",
      is_published: true,
      followers_count: 120,
      picture_url: "https://img.example.com/picture.jpg",
      cover_url: "https://img.example.com/cover.jpg",
    });
    expect(v.page.editable).toMatchObject({
      about: "Fresh juice in Lagos",
      phone: "+234 800 000 0001",
      website: "https://www.mrssamuel.com",
      emails: ["hello@mrssamuel.com"],
      always_open: false,
      address: { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "100271" },
    });
    expect(v.page.editable.hours.mon).toEqual([{ open: "08:00", close: "18:00" }]);
    expect(v.page.editable.hours.sun).toEqual([]);

    // The Page was read with the Page token, the task list with the system-user token.
    expect(calls.find((c) => c.path.endsWith(`/${PAGE_ID}`))!.auth).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(calls.find((c) => c.path.endsWith("/me/accounts"))!.auth).toBe(`Bearer ${SYSTEM_TOKEN}`);

    // A second GET inside a minute comes from the cache; ?fresh=1 skips it.
    const reads = () => calls.filter((c) => c.method === "GET" && c.path.endsWith(`/${PAGE_ID}`)).length;
    expect(reads()).toBe(1);
    await call(owner, "GET", url(fb));
    expect(reads()).toBe(1);
    await call(owner, "GET", url(fb) + "?fresh=1");
    expect(reads()).toBe(2);
  });

  it("GET sets cannot_edit_reason no_manage_task when MANAGE is missing, and allows editing when tasks are unknown", async () => {
    tasks = ["MESSAGING", "MODERATE"];
    const noManage = await call(owner, "GET", url(fb));
    expect(noManage.json.data).toMatchObject({ can_edit: false, cannot_edit_reason: "no_manage_task" });

    clearPageDetailsCache();
    tasks = "error";
    const unknown = await call(owner, "GET", url(fb));
    expect(unknown.json.data).toMatchObject({ can_edit: true, cannot_edit_reason: null });
  });

  it("GET on a switched-off Page still reads it, but cannot_edit_reason is inactive", async () => {
    const res = await call(owner, "GET", url(off));
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ can_edit: false, cannot_edit_reason: "inactive" });
    expect(res.json.data.account).toMatchObject({ id: off, is_active: false });
    expect(res.json.data.page.name).toBe("Mrs Samuel fruit juice");
  });

  it("GET answers 502 with a plain reason when Facebook cannot be read", async () => {
    getInject = { action: "refuse", code: 4, message: "Too many calls" };
    const res = await call(owner, "GET", url(fb));
    expect(res.status).toBe(502);
    expect(res.json.error.message).toBe(
      "We could not load the Page from Facebook. Facebook is busy. Nothing was changed. Try again in a few minutes.",
    );
  });

  it("GET for an instagram account returns the profile and can_edit false", async () => {
    const res = await call(owner, "GET", url(ig));
    expect(res.status).toBe(200);
    const v = res.json.data;
    expect(v.account).toMatchObject({ id: ig, kind: "instagram" });
    expect(v.page).toBeNull();
    expect(v.can_edit).toBe(false);
    expect(v.cannot_edit_reason).toBe("instagram");
    expect(v.instagram).toMatchObject({
      username: "mrs_samuelfruitjuice",
      name: "Mrs Samuel",
      biography: "Fresh juice",
      followers_count: 80,
      media_count: 12,
    });
  });

  it("PATCH without confirm:true → 400 and no Graph call", async () => {
    for (const extra of [{}, { confirm: false }, { confirm: "yes" }]) {
      const res = await patch(fb, { about: "Fresh juice in Lagos" }, { about: "New text" }, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(graphHits).toBe(0);
    expect(await audits(fb)).toHaveLength(0);
  });

  it("PATCH sends only the changed fields, reads back, returns saved, writes an audit row with before and after", async () => {
    const res = await patch(
      fb,
      { about: "Fresh juice in Lagos", phone: "+234 800 000 0001" },
      { about: "  Fresh juice, pressed today ", phone: "0801 234 5678" },
    );
    expect(res.status).toBe(200);
    expect(res.json.data.saved.sort()).toEqual(["about", "phone"]);
    expect(res.json.data.not_saved).toEqual([]);
    // The screen gets what Facebook now holds.
    expect(res.json.data.view.page.editable).toMatchObject({ about: "Fresh juice, pressed today", phone: "+2348012345678" });

    // Exactly one POST, with only the two changed fields, in the cleaned-up form, using the Page token.
    const posts = pagePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ about: "Fresh juice, pressed today", phone: "+2348012345678" });
    expect(posts[0]!.auth).toBe(`Bearer ${PAGE_TOKEN}`);

    const rows = await audits(fb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityType).toBe("facebook_page");
    expect(rows[0]!.beforeJson).toEqual({ about: "Fresh juice in Lagos", phone: "+234 800 000 0001" });
    expect(rows[0]!.afterJson).toMatchObject({
      about: "Fresh juice, pressed today",
      phone: "+2348012345678",
      result: "saved",
      not_saved: [],
    });

    const history = await call(owner, "GET", url(fb, "/history"));
    expect(history.status).toBe(200);
    expect(history.json.data).toHaveLength(1);
    expect(history.json.data[0]).toMatchObject({
      result: "saved",
      before: { about: "Fresh juice in Lagos" },
      after: { about: "Fresh juice, pressed today", phone: "+2348012345678" },
    });
    expect([...history.json.data[0].fields].sort()).toEqual(["about", "phone"]);
    expect(history.json.data[0]).toHaveProperty("by_name");
    expect(history.json.data[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("PATCH sends the whole week for hours and refuses a closing time after 6 am the next morning", async () => {
    const week = (mon: { open: string; close: string }[]) => ({
      mon,
      tue: [{ open: "08:00", close: "18:00" }],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    });
    const expected = week([{ open: "08:00", close: "18:00" }]);

    const bad = await patch(fb, { hours: expected }, { hours: week([{ open: "20:00", close: "07:00" }]) });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe("Monday: closing time must be after opening time (or by 6:00 am the next morning).");
    expect(pagePosts()).toHaveLength(0);

    const ok = await patch(
      fb,
      { hours: expected },
      {
        hours: week([
          { open: "08:00", close: "12:00" },
          { open: "14:00", close: "18:00" },
        ]),
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.json.data.saved).toEqual(["hours"]);
    expect(pagePosts()[0]!.body).toEqual({
      hours: {
        mon_1_open: "08:00",
        mon_1_close: "12:00",
        mon_2_open: "14:00",
        mon_2_close: "18:00",
        tue_1_open: "08:00",
        tue_1_close: "18:00",
      },
    });
  });

  it("PATCH with an unchanged value makes no POST and writes no audit row", async () => {
    const res = await patch(fb, { about: "Fresh juice in Lagos", phone: "+234 800 000 0001" }, { about: "Fresh juice in Lagos", phone: "+2348000000001" });
    expect(res.status).toBe(200);
    expect(res.json.data.saved).toEqual([]);
    expect(res.json.data.not_saved).toEqual([]);
    expect(pagePosts()).toHaveLength(0);
    expect(await audits(fb)).toHaveLength(0);
  });

  it("PATCH when the live value differs from expected → 409 stale and no POST", async () => {
    const res = await patch(fb, { website: "https://old.example.com" }, { website: "https://new.example.com" });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe(
      "These details were changed on Facebook since you opened this page. Check the new values and try again.",
    );
    expect(res.json.error.details.reason).toBe("stale");
    expect(res.json.error.details.view.page.editable.website).toBe("https://www.mrssamuel.com");
    expect(pagePosts()).toHaveLength(0);
    expect(await audits(fb)).toHaveLength(0);
  });

  it("PATCH when Meta says success but keeps the old value → the field is in not_saved", async () => {
    postInject = { action: "ignore" };
    const res = await patch(fb, { about: "Fresh juice in Lagos" }, { about: "Something new" });
    expect(res.status).toBe(200);
    expect(res.json.data.saved).toEqual([]);
    expect(res.json.data.not_saved).toEqual(["about"]);
    expect(res.json.data.view.page.editable.about).toBe("Fresh juice in Lagos");
    const rows = await audits(fb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.afterJson).toMatchObject({ result: "unknown", not_saved: ["about"] });
  });

  it("PATCH when Meta refuses → 409 with Meta's message and code, audit result refused", async () => {
    postInject = { action: "refuse", code: 100, message: "Invalid city" };
    const res = await patch(
      fb,
      { address: { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "100271" } },
      { address: { street: "1 Allen Avenue", city: "Nowhereville", state: "Lagos", country: "Nigeria", zip: "100271" } },
    );
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe("Facebook refused this: Invalid city (code 100).");
    expect(res.json.error.details.view.page.editable.address.city).toBe("Ikeja");
    const rows = await audits(fb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.afterJson).toMatchObject({ result: "refused", meta_code: "100", meta_message: "Invalid city", not_saved: ["address"] });
  });

  it("PATCH when Meta refuses for permission → configuration wording and one owner alert a day", async () => {
    for (let i = 0; i < 2; i++) {
      postInject = { action: "refuse", code: 200, message: "Requires pages_manage_metadata" };
      const res = await patch(fb, { about: "Fresh juice in Lagos" }, { about: `Try ${i}` });
      expect(res.status).toBe(409);
      expect(res.json.error.message).toBe(
        "The suite is not allowed to change this Page. Ask the owner to give the suite full control of the Page in Meta Business Settings.",
      );
    }
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "channels.page_config"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account_id: fb, label: "Facebook Page", code: "200", message: "Requires pages_manage_metadata" });
    expect(await audits(fb)).toHaveLength(2);
  });

  it("PATCH when Facebook is busy → 502, nothing changed, audit result refused", async () => {
    postInject = { action: "refuse", code: 4, message: "Too many calls" };
    const res = await patch(fb, { about: "Fresh juice in Lagos" }, { about: "Something new" });
    expect(res.status).toBe(502);
    expect(res.json.error.message).toBe("Facebook is busy. Nothing was changed. Try again in a few minutes.");
    expect((await audits(fb))[0]!.afterJson).toMatchObject({ result: "refused", meta_code: "4" });
  });

  it("PATCH on timeout with a matching read-back → 200 saved", async () => {
    postInject = { action: "timeout-applied" };
    const res = await patch(fb, { about: "Fresh juice in Lagos" }, { about: "Saved before the timeout" });
    expect(res.status).toBe(200);
    expect(res.json.data.saved).toEqual(["about"]);
    expect(res.json.data.not_saved).toEqual([]);
    expect((await audits(fb))[0]!.afterJson).toMatchObject({ result: "saved" });
  });

  it("PATCH on timeout with a read-back that does not match → 504 and the page's real values", async () => {
    postInject = { action: "timeout" };
    const res = await patch(fb, { about: "Fresh juice in Lagos" }, { about: "Lost in the timeout" });
    expect(res.status).toBe(504);
    expect(res.json.error.message).toBe(
      "No answer from Facebook. Some details may not have been saved. The page now shows what Facebook holds.",
    );
    expect(res.json.error.details.view.page.editable.about).toBe("Fresh juice in Lagos");
    expect((await audits(fb))[0]!.afterJson).toMatchObject({ result: "unknown", not_saved: ["about"] });
  });

  it("PATCH with name in changes → 400", async () => {
    for (const key of ["name", "username", "category_list", "cover", "is_published"]) {
      const res = await patch(fb, { [key]: "x" }, { [key]: "y" });
      expect(res.status, key).toBe(400);
    }
    const mixed = await patch(fb, { about: "Fresh juice in Lagos", name: "A" }, { about: "New", name: "B" });
    expect(mixed.status).toBe(400);
    expect(graphHits).toBe(0);
  });

  it("PATCH with different fields in changes and expected, or none at all → 400", async () => {
    expect((await patch(fb, { about: "a" }, { phone: "+2348012345678" })).status).toBe(400);
    expect((await patch(fb, {}, {})).status).toBe(400);
    expect(graphHits).toBe(0);
  });

  it("PATCH with a bad phone or a fourth email → 400 with the plain sentence", async () => {
    const phoneRes = await patch(fb, { phone: "+234 800 000 0001" }, { phone: "abc" });
    expect(phoneRes.status).toBe(400);
    expect(phoneRes.json.error.message).toBe(
      "That phone number doesn't look right. Include the country code, for example +234 801 234 5678.",
    );
    const emailRes = await patch(fb, { emails: ["hello@mrssamuel.com"] }, { emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"] });
    expect(emailRes.status).toBe(400);
    expect(emailRes.json.error.message).toBe("You can list up to 3 emails.");
    expect(graphHits).toBe(0);
  });

  it("PATCH on an instagram account → 409, and on a switched-off Page → 409", async () => {
    const igRes = await patch(ig, { about: null }, { about: "x" });
    expect(igRes.status).toBe(409);
    expect(igRes.json.error.message).toBe("These details can only be changed in the Instagram app.");
    const offRes = await patch(off, { about: null }, { about: "x" });
    expect(offRes.status).toBe(409);
    expect(offRes.json.error.message).toBe("This account is switched off in Channels.");
    expect(graphHits).toBe(0);
  });

  it("no response or audit row contains the token", async () => {
    await patch(fb, { about: "Fresh juice in Lagos" }, { about: "One more change" });
    await call(owner, "GET", url(fb) + "?fresh=1");
    await call(owner, "GET", url(fb, "/history"));
    const all = JSON.stringify(await db.select().from(auditLog)) + JSON.stringify(await db.select().from(outboxEvent));
    for (const token of [PAGE_TOKEN, SYSTEM_TOKEN]) {
      expect(all).not.toContain(token);
      for (const b of bodies) expect(b).not.toContain(token);
    }
  });
});
