import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, inboxPhoneNumber, outboxEvent } from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 05: /v1/whatsapp-profile. The Graph API is stubbed: the stub answers by
 * URL, keeps the business profile in memory, applies POST bodies to it unless told to
 * refuse, ignore or time out, and records every call. Nothing reaches Meta. The tokens
 * below are fake.
 */

const SYSTEM_TOKEN = "itest-system-user-token";
const APP_ID = "1234567890";
const PNID = "109876543210987";
const WABA = "104857600123456";
const AUDIT_ACTIONS = ["whatsapp_profile.update", "whatsapp_profile.update_unconfirmed", "whatsapp_profile.photo_update"];

type Obj = Record<string, unknown>;
type Inject = { action: "refuse" | "ignore" | "timeout"; code?: number; message?: string };

interface GraphCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Obj | null;
  /** Length of a raw (file) body. */
  rawBytes: number | null;
}

const INITIAL_PROFILE = (): Obj => ({
  about: "Fresh juice in Lagos",
  address: "1 Allen Avenue, Ikeja, Lagos",
  description: "We press every juice to order.\nOrder by message.",
  email: "hello@mrssamuel.com",
  websites: ["https://www.mrssamuel.com"],
  vertical: "RESTAURANT",
  profile_picture_url: "https://pps.example.com/original.jpg",
});
const STATUS_A: Obj = {
  id: PNID,
  display_phone_number: "+234 800 000 0000",
  verified_name: "Mrs Samuel",
  name_status: "APPROVED",
  quality_rating: "GREEN",
  status: "CONNECTED",
  code_verification_status: "VERIFIED",
  whatsapp_business_manager_messaging_limit: "TIER_250",
};

let profile: Obj = INITIAL_PROFILE();
let postInject: Inject | null = null;
let profileGetInject: Inject | null = null;
let callBRefused = false;
let uploadInject: Inject | null = null;
let calls: GraphCall[] = [];
let graphHits = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function resetStub(): void {
  profile = INITIAL_PROFILE();
  postInject = null;
  profileGetInject = null;
  callBRefused = false;
  uploadInject = null;
  calls = [];
  graphHits = 0;
}

const profilePosts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith(`/${PNID}/whatsapp_business_profile`));

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    graphHits += 1;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body instanceof Uint8Array ? init.body : null;
    const body = init?.body && !raw ? (JSON.parse(String(init.body)) as Obj) : null;
    calls.push({ method, path: url.pathname, query: url.searchParams, headers, body, rawBytes: raw ? raw.byteLength : null });

    const authBearer = `Bearer ${SYSTEM_TOKEN}`;

    // Resumable Upload API: step 1 opens a session, step 2 sends the bytes with the OAuth scheme.
    if (url.pathname.endsWith(`/${APP_ID}/uploads`) && method === "POST") {
      if (headers.authorization !== authBearer) return json({ error: { message: "bad token", code: 190 } }, 401);
      if (uploadInject) {
        const i = uploadInject;
        uploadInject = null;
        return json({ error: { message: i.message ?? "Invalid OAuth access token", code: i.code ?? 190 } }, 401);
      }
      return json({ id: "upload:SESSION1" });
    }
    if (url.pathname.endsWith("/upload:SESSION1") && method === "POST") {
      if (headers.authorization !== `OAuth ${SYSTEM_TOKEN}`) return json({ error: { message: "bad token", code: 190 } }, 401);
      return json({ h: "HANDLE-1" });
    }

    if (headers.authorization !== authBearer) return json({ error: { message: "bad token", code: 190 } }, 401);

    if (url.pathname.endsWith(`/${PNID}/whatsapp_business_profile`)) {
      if (method === "GET") {
        if (profileGetInject) {
          const i = profileGetInject;
          profileGetInject = null;
          return json({ error: { message: i.message ?? "Invalid OAuth access token", code: i.code ?? 190 } }, 400);
        }
        return json({ data: [{ ...profile, messaging_product: "whatsapp" }] });
      }
      if (method === "POST") {
        if (postInject) {
          const i = postInject;
          postInject = null;
          if (i.action === "refuse") return json({ error: { message: i.message ?? "Invalid parameter", code: i.code ?? 100 } }, 400);
          if (i.action === "ignore") return json({ success: true });
          throw new TypeError("fetch failed");
        }
        for (const [k, v] of Object.entries(body ?? {})) {
          if (k === "messaging_product") continue;
          if (k === "profile_picture_handle") profile.profile_picture_url = `https://pps.example.com/${String(v)}.jpg`;
          else profile[k] = v;
        }
        return json({ success: true });
      }
    }

    if (url.pathname.endsWith(`/${PNID}`) && method === "GET") {
      const fields = url.searchParams.get("fields") ?? "";
      if (fields.includes("is_pin_enabled")) {
        if (callBRefused) return json({ error: { message: "nonexisting field (is_pin_enabled)", code: 100 } }, 400);
        return json({ id: PNID, is_pin_enabled: false, is_official_business_account: false });
      }
      return json(STATUS_A);
    }
    return json({ error: { message: "Unsupported request", code: 100 } }, 400);
  }) as typeof fetch;
}

const PNG = (extra = 20) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(extra).fill(7)]);
const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

describe("suite spec 05 — /v1/whatsapp-profile", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let admin: string;
  let manager: string;
  let num: string;
  let second: string;
  let voiceOnly: string;
  let noWa: string;
  let messenger: string;
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
  async function callPhoto(
    cookie: string,
    id: string,
    bytes: Uint8Array,
    type: string,
    extra: Record<string, string> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads many response shapes
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/v1/whatsapp-profile/${id}/photo`, {
      method: "POST",
      headers: { cookie, "content-type": type, ...extra },
      body: bytes,
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const url = (id: string, tail = "") => `/v1/whatsapp-profile/${id}${tail}`;
  const audits = async () => db.select().from(auditLog).where(inArray(auditLog.action, AUDIT_ACTIONS));
  const fieldsOf = (p: Obj) => ({
    about: p.about,
    address: p.address,
    description: p.description,
    email: p.email,
    websites: p.websites,
    vertical: p.vertical,
  });
  const put = (profileBody: unknown, expected: unknown = fieldsOf(INITIAL_PROFILE())) =>
    call(admin, "PUT", url(num), { profile: profileBody, expected });
  const alerts = async () =>
    (await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "inbox.meta_config"))).filter(
      (r) => (r.payload as Obj).area === "whatsapp_profile",
    );

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-key";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.META_APP_ID = APP_ID;
    installGraphStub();
    await seedOwner(db);
    await seedUser(db, { email: "admin@example.com", role: "admin" });
    await seedUser(db, { email: "manager@example.com", role: "manager" });

    const inserted = await db
      .insert(inboxPhoneNumber)
      .values([
        { e164: "+2348000000000", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: PNID },
        { e164: "+2348000000003", label: "Second line", channels: "whatsapp", wabaId: WABA, waPhoneNumberId: "109876543210989" },
        { e164: "+2348000000001", label: "Calls only", channels: "voice" },
        { e164: "+2348000000002", label: "Voice with id", channels: "voice", wabaId: WABA, waPhoneNumberId: "109876543210988" },
        { e164: "+2348000000004", label: "No WhatsApp id", channels: "both" },
        {
          kind: "messenger",
          e164: null,
          externalId: "100200300",
          pageExternalId: "100200300",
          externalName: "Page",
          label: "Facebook Page",
          channels: "whatsapp",
        },
      ])
      .returning({ id: inboxPhoneNumber.id, label: inboxPhoneNumber.label });
    const idOf = (label: string) => inserted.find((r) => r.label === label)!.id;
    num = idOf("Main line");
    second = idOf("Second line");
    voiceOnly = idOf("Voice with id");
    noWa = idOf("No WhatsApp id");
    messenger = idOf("Facebook Page");

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    admin = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
  }, 120_000);

  beforeEach(async () => {
    resetStub();
    process.env.META_APP_ID = APP_ID;
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    await db.delete(auditLog).where(inArray(auditLog.action, AUDIT_ACTIONS));
    await db.delete(outboxEvent).where(eq(outboxEvent.eventType, "inbox.meta_config"));
    await db.update(inboxPhoneNumber).set({ waStatus: null, qualityRating: null, messagingLimit: null }).where(eq(inboxPhoneNumber.id, num));
  });

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("GET needs channels.manage (403 for a manager, 200 for an admin)", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", "/v1/whatsapp-profile"],
      ["GET", url(num)],
      ["PUT", url(num), { profile: fieldsOf(INITIAL_PROFILE()), expected: fieldsOf(INITIAL_PROFILE()) }],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await callPhoto(manager, num, PNG(), "image/png")).status).toBe(403);
    expect(graphHits).toBe(0);

    const list = await call(admin, "GET", "/v1/whatsapp-profile");
    expect(list.status).toBe(200);
    // Only phone rows with a WhatsApp number ID that are not voice-only, ordered by label.
    expect(list.json.data).toEqual([
      { id: num, label: "Main line", e164: "+2348000000000", is_active: true },
      { id: second, label: "Second line", e164: "+2348000000003", is_active: true },
    ]);
    expect(graphHits).toBe(0);
  });

  it("answers 404 for a bad or unknown id and a Page row, and 400 for a number with no WhatsApp", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", messenger]) {
      expect((await call(admin, "GET", url(id))).status, id).toBe(404);
      const both = { profile: fieldsOf(INITIAL_PROFILE()), expected: fieldsOf(INITIAL_PROFILE()) };
      expect((await call(admin, "PUT", url(id), both)).status, id).toBe(404);
      expect((await callPhoto(admin, id, PNG(), "image/png")).status, id).toBe(404);
    }
    for (const id of [voiceOnly, noWa]) {
      const res = await call(admin, "GET", url(id));
      expect(res.status, id).toBe(400);
      expect(res.json.error.message).toBe("This number has no WhatsApp.");
    }
    expect(graphHits).toBe(0);
  });

  it("GET returns profile and status and refreshes the number's quality columns", async () => {
    const res = await call(admin, "GET", url(num));
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.number).toEqual({ id: num, label: "Main line", e164: "+2348000000000", waba_id: WABA });
    expect(d.profile).toEqual({
      about: "Fresh juice in Lagos",
      address: "1 Allen Avenue, Ikeja, Lagos",
      description: "We press every juice to order.\nOrder by message.",
      email: "hello@mrssamuel.com",
      websites: ["https://www.mrssamuel.com"],
      vertical: "RESTAURANT",
      profile_picture_url: "https://pps.example.com/original.jpg",
    });
    expect(d.status).toEqual({
      display_phone_number: "+234 800 000 0000",
      display_name: "Mrs Samuel",
      name_status: "APPROVED",
      pending_name: null,
      pending_name_status: null,
      quality_rating: "GREEN",
      status: "CONNECTED",
      code_verification_status: "VERIFIED",
      messaging_limit: "TIER_250",
      pin_enabled: false,
      official_account: false,
    });
    expect(d.photo_upload_ready).toBe(true);
    expect(d.manager_url).toBe(`https://business.facebook.com/latest/whatsapp_manager/phone_numbers?waba_id=${WABA}`);

    // The Settings screen's columns were refreshed from what Meta said (a read: no write to Meta, no audit).
    const [row] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, num));
    expect(row).toMatchObject({ waStatus: "CONNECTED", qualityRating: "GREEN", messagingLimit: "TIER_250" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    // Every read used the system-user token and the right phone number ID.
    expect(calls.every((c) => c.path.includes(PNID))).toBe(true);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${SYSTEM_TOKEN}`)).toBe(true);
  });

  it("GET tolerates call B being refused (pin and badge become null) and reports photo upload not ready without META_APP_ID", async () => {
    callBRefused = true;
    delete process.env.META_APP_ID;
    const res = await call(admin, "GET", url(num));
    expect(res.status).toBe(200);
    expect(res.json.data.status).toMatchObject({ status: "CONNECTED", pin_enabled: null, official_account: null });
    expect(res.json.data.photo_upload_ready).toBe(false);
  });

  it("GET answers 503 with a plain sentence when WhatsApp is not set up", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const res = await call(admin, "GET", url(num));
    expect(res.status).toBe(503);
    expect(res.json.error.message).toBe("WhatsApp is not set up on this server.");
    expect(graphHits).toBe(0);
  });

  it("PUT validates and returns field problems", async () => {
    const res = await put({
      ...fieldsOf(INITIAL_PROFILE()),
      about: "a".repeat(140),
      email: "not-an-email",
      websites: ["mrssamuel.com"],
      vertical: "SPACESHIPS",
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
    expect(res.json.error.details.fields).toEqual({
      about: "Keep this to 139 characters or fewer.",
      email: "That does not look like an email address.",
      websites: "Start the website with https://",
      vertical: "Choose a type of business from the list.",
    });
    // The server counts UTF-16 units too: 138 letters plus one emoji is 140 units.
    const emoji = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "a".repeat(138) + "😀" });
    expect(emoji.status).toBe(400);
    expect(emoji.json.error.details.fields.about).toBe("Keep this to 139 characters or fewer.");
    // A body that is not the right shape is refused too.
    const shape = await call(admin, "PUT", url(num), { profile: { about: "x" } });
    expect(shape.status).toBe(400);
    expect(graphHits).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  it("PUT refuses to empty the about line", async () => {
    const res = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "" });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toBe("WhatsApp does not allow an empty 'about' line. Write a short line instead.");
    expect(res.json.error.details.fields.about).toBe(res.json.error.message);
    expect(profilePosts()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it("PUT with a stale expected returns 409 changed_elsewhere and writes nothing", async () => {
    profile.about = "Changed by someone else";
    const res = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "My new line" });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("conflict");
    expect(res.json.error.details.reason).toBe("changed_elsewhere");
    expect(res.json.error.details.current.about).toBe("Changed by someone else");
    expect(res.json.error.message).toBe(
      "This profile was changed somewhere else since you opened it. We have loaded the latest version. Check it and make your change again.",
    );
    expect(profilePosts()).toHaveLength(0);
    expect(profile.about).toBe("Changed by someone else");
    expect(await audits()).toHaveLength(0);
  });

  it("PUT writes, reads back and audits before and after", async () => {
    const wanted = {
      ...fieldsOf(INITIAL_PROFILE()),
      about: "  Fresh juice, made daily in Lagos ",
      websites: ["https://www.mrssamuel.com", "https://instagram.com/mrs_samuelfruitjuice"],
    };
    const res = await put(wanted);
    expect(res.status).toBe(200);
    expect(res.json.data.changed).toEqual(["about", "websites"]);
    expect(res.json.data.mismatch).toEqual([]);
    expect(res.json.data.profile).toMatchObject({
      about: "Fresh juice, made daily in Lagos",
      websites: ["https://www.mrssamuel.com", "https://instagram.com/mrs_samuelfruitjuice"],
    });

    // One POST: every text field, tidied, with about because it is not empty.
    const posts = profilePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      messaging_product: "whatsapp",
      about: "Fresh juice, made daily in Lagos",
      address: "1 Allen Avenue, Ikeja, Lagos",
      description: "We press every juice to order.\nOrder by message.",
      email: "hello@mrssamuel.com",
      websites: ["https://www.mrssamuel.com", "https://instagram.com/mrs_samuelfruitjuice"],
      vertical: "RESTAURANT",
    });
    // The read-back came after the write.
    const lastCall = calls[calls.length - 1]!;
    expect(lastCall.method).toBe("GET");
    expect(lastCall.path.endsWith("/whatsapp_business_profile")).toBe(true);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "whatsapp_profile.update", entityType: "inbox_phone_number", entityId: num });
    expect(rows[0]!.beforeJson).toEqual(fieldsOf(INITIAL_PROFILE()));
    expect(rows[0]!.afterJson).toEqual({
      about: "Fresh juice, made daily in Lagos",
      address: "1 Allen Avenue, Ikeja, Lagos",
      description: "We press every juice to order.\nOrder by message.",
      email: "hello@mrssamuel.com",
      websites: ["https://www.mrssamuel.com", "https://instagram.com/mrs_samuelfruitjuice"],
      vertical: "RESTAURANT",
    });
  });

  it("PUT reports a mismatch when WhatsApp says yes but shows something different", async () => {
    postInject = { action: "ignore" };
    const res = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "A line WhatsApp ignores" });
    expect(res.status).toBe(200);
    expect(res.json.data.changed).toEqual(["about"]);
    expect(res.json.data.mismatch).toEqual(["about"]);
    expect(res.json.data.profile.about).toBe("Fresh juice in Lagos");
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.afterJson as Obj).about).toBe("Fresh juice in Lagos");
  });

  it("PUT with no change makes no Meta write and no audit row", async () => {
    const res = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "  Fresh juice in Lagos  " });
    expect(res.status).toBe(200);
    expect(res.json.data.changed).toEqual([]);
    expect(res.json.data.mismatch).toEqual([]);
    expect(res.json.data.profile.about).toBe("Fresh juice in Lagos");
    expect(profilePosts()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it("PUT maps a Meta refusal to 409 with Meta's message and a timeout to 502", async () => {
    postInject = { action: "refuse", code: 100, message: "Invalid parameter: websites" };
    const refused = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "A new line" });
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe("WhatsApp refused this change: Invalid parameter: websites");
    expect(refused.json.error.details).toMatchObject({
      reason: "meta_refused",
      meta_code: "100",
      meta_message: "Invalid parameter: websites",
    });
    expect(await audits()).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);

    postInject = { action: "refuse", code: 4, message: "Application request limit reached" };
    const busy = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "A new line" });
    expect(busy.status).toBe(502);
    expect(busy.json.error.details.reason).toBe("meta_unavailable");

    postInject = { action: "timeout" };
    const timedOut = await put({ ...fieldsOf(INITIAL_PROFILE()), about: "A new line" });
    expect(timedOut.status).toBe(502);
    expect(timedOut.json.error.details.reason).toBe("meta_unavailable");
    expect(timedOut.json.error.message).toBe(
      "WhatsApp did not answer. Nothing was changed for certain. Wait a minute, reload this page and check before trying again.",
    );
    // A timeout may have gone through, so it leaves a trace of its own.
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(["whatsapp_profile.update_unconfirmed"]);
  });

  it("photo: refuses a non-image, a wrong signature, an empty or oversize body and a missing META_APP_ID", async () => {
    const gif = await callPhoto(admin, num, PNG(), "image/gif");
    expect(gif.status).toBe(400);
    expect(gif.json.error.message).toBe("Use a JPG or PNG picture.");

    const fake = await callPhoto(admin, num, new TextEncoder().encode("this is not a picture"), "image/png");
    expect(fake.status).toBe(400);
    expect(fake.json.error.message).toBe("Use a JPG or PNG picture.");

    const empty = await callPhoto(admin, num, new Uint8Array(0), "image/png");
    expect(empty.status).toBe(400);

    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    const tooBig = await callPhoto(admin, num, big, "image/png");
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.error.message).toBe("That picture is larger than 5 MB. Choose a smaller one.");

    delete process.env.META_APP_ID;
    const noApp = await callPhoto(admin, num, PNG(), "image/png");
    expect(noApp.status).toBe(503);
    expect(noApp.json.error.message).toBe(
      "Photo upload is not set up on this server yet. Change the photo in WhatsApp Manager for now.",
    );

    expect(graphHits).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  it("photo: uploads, sets the handle, audits, and the stored audit row holds no URL", async () => {
    const bytes = PNG(40);
    const res = await callPhoto(admin, num, bytes, "image/png", { "x-file-name": "logo.png" });
    expect(res.status).toBe(200);
    expect(res.json.data.profile_picture_url).toBe("https://pps.example.com/HANDLE-1.jpg");

    const open = calls.find((c) => c.path.endsWith(`/${APP_ID}/uploads`))!;
    expect(open.query.get("file_name")).toBe("logo.png");
    expect(open.query.get("file_length")).toBe(String(bytes.byteLength));
    expect(open.query.get("file_type")).toBe("image/png");
    expect(open.headers.authorization).toBe(`Bearer ${SYSTEM_TOKEN}`);
    const send = calls.find((c) => c.path.endsWith("/upload:SESSION1"))!;
    expect(send.headers.authorization).toBe(`OAuth ${SYSTEM_TOKEN}`);
    expect(send.headers.file_offset).toBe("0");
    expect(send.rawBytes).toBe(bytes.byteLength);
    const handlePost = profilePosts();
    expect(handlePost).toHaveLength(1);
    expect(handlePost[0]!.body).toEqual({ messaging_product: "whatsapp", profile_picture_handle: "HANDLE-1" });

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "whatsapp_profile.photo_update", entityType: "inbox_phone_number", entityId: num });
    expect(rows[0]!.beforeJson).toEqual({ profile_picture_url: "set" });
    expect(rows[0]!.afterJson).toEqual({ bytes: bytes.byteLength, mime: "image/png" });
    const stored = JSON.stringify([rows[0]!.beforeJson, rows[0]!.afterJson]);
    expect(stored).not.toContain("http");
    expect(stored).not.toContain("pps.example.com");

    // A JPEG sent under a PNG label is sent to Meta as what it really is.
    calls = [];
    const jpg = await callPhoto(admin, num, JPEG(), "image/png");
    expect(jpg.status).toBe(200);
    const reopened = calls.find((c) => c.path.endsWith(`/${APP_ID}/uploads`))!;
    expect(reopened.query.get("file_type")).toBe("image/jpeg");
    expect(reopened.query.get("file_name")).toBe("profile.jpg");
  });

  it("photo: Meta refusing the token for the upload answers 409 with the manager message and raises no alert", async () => {
    uploadInject = { action: "refuse", code: 190 };
    const res = await callPhoto(admin, num, PNG(), "image/png");
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe(
      "WhatsApp would not accept the photo from here. Change the photo in WhatsApp Manager for now.",
    );
    expect(await alerts()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(profilePosts()).toHaveLength(0);
  });

  it("a token error raises one owner alert, not two", async () => {
    profileGetInject = { action: "refuse", code: 190, message: "Invalid OAuth access token" };
    const first = await call(admin, "GET", url(num));
    expect(first.status).toBe(409);
    expect(first.json.error.details.reason).toBe("meta_config");
    expect(first.json.error.message).toBe(
      "WhatsApp would not let us in. The connection needs fixing by the technical lead. (Meta code 190)",
    );

    profileGetInject = { action: "refuse", code: 190, message: "Invalid OAuth access token" };
    const again = await call(admin, "GET", url(num));
    expect(again.status).toBe(409);

    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ area: "whatsapp_profile", code: "190" });
  });

  it("no response body ever carries the token", () => {
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain(SYSTEM_TOKEN);
  });
});
