import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  auditLog,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTeam,
  inboxTeamMember,
  inboxTemplate,
  inboxUserNumberAccess,
  inboxWebhookEvent,
  lead,
  leadForm,
  outboxEvent,
} from "@ms/db";
import { backfillLeadsPage, clearPageTokenCache, metaConfigFromEnv, processLead, type MetaConfig } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 13: leads from Meta lead forms. A Facebook Page (messenger line)
 * and one WhatsApp number are inserted directly. Every Graph API call is
 * stubbed; nothing reaches Meta. No person here is real.
 *
 * Every ID satisfies the routes' validators and the database CHECKs: Page, form
 * and lead IDs are digits (12 long); the messenger row has external_id and
 * page_external_id; the phone row has e164. Nothing depends on the wall clock:
 * the worker functions get NOW, a fixed moment in the past, and every date
 * filter is given explicitly.
 */

const APP_SECRET = "itest-meta-app-secret";
const SYSTEM_TOKEN = "itest-system-user-token";
const PAGE_TOKEN = "itest-page-token-LEADS";
const OUR_APP_ID = "900800700600";
const PAGE_ID = "100200300400";
const WA_NUMBER_ID = "1098765413";
const WABA_ID = "WABA13";
const FORM_A = "777000111222";
const FORM_OFF = "777000111333";
const FORM_NEW = "777000111444";
const FORM_BACKFILL = "777000111555";
const FORM_MIXED = "777000111666";
const NOW = new Date("2026-06-01T09:00:00.000Z");
/** created_time in every webhook fixture (Unix seconds). */
const WEBHOOK_TIME = 1795000000;

type Obj = Record<string, unknown>;
type MetaErr = { status: number; error: Obj };

// ── Graph stub ───────────────────────────────────────────────────────────────

type GraphCall = { method: string; url: string; path: string; auth: string | null; body: Obj | null };
const graphCalls: GraphCall[] = [];
/** GET /{leadgen-id}: the lead, by ID. */
const metaLeads = new Map<string, Obj>();
/** GET /{leadgen-id}?fields=ad_name,…: the advert names, by lead ID. */
const metaExtras = new Map<string, Obj>();
/** GET /{leadgen-id} answers with this error instead. */
const leadErrors = new Map<string, MetaErr>();
/** GET /{form-id}?fields=id,name,questions */
const metaForms = new Map<string, Obj>();
/** GET /{form-id}?fields=status,locale,privacy_policy_url,legal_content */
const metaFormWording = new Map<string, Obj>();
/** GET /{page-id}/leadgen_forms */
let formsList: { id: string; name: string }[] = [];
/** GET /{form-id}/leads, keyed "<form id>|<after cursor or empty>". */
const leadPages = new Map<string, Obj>();
/** What GET {page}/subscribed_apps answers for our app. */
let subscribedFields: string[] = ["messages", "message_echoes"];
let wamidCounter = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    const body = init?.body ? (JSON.parse(String(init.body)) as Obj) : null;
    const path = url.pathname.replace(/^\/v[\d.]+\//, "");
    const fields = url.searchParams.get("fields") ?? "";
    graphCalls.push({ method, url: href, path, auth, body });

    if (fields === "access_token") return json({ id: path, access_token: PAGE_TOKEN });
    if (path.endsWith("/subscribed_apps")) {
      if (method === "POST") {
        subscribedFields = (url.searchParams.get("subscribed_fields") ?? "").split(",").filter(Boolean);
        return json({ success: true });
      }
      return json({ data: [{ id: OUR_APP_ID, subscribed_fields: subscribedFields }] });
    }
    // WhatsApp send.
    if (path === `${WA_NUMBER_ID}/messages` && method === "POST") {
      return json({ messages: [{ id: `wamid.lead.${++wamidCounter}` }] }); // unique for the whole file: wa_message_id is UNIQUE
    }
    // Everything else here needs the Page token.
    if (auth !== `Bearer ${PAGE_TOKEN}`) return json({ error: { message: "A Page token is needed", code: 190 } }, 401);
    if (path.endsWith("/leadgen_forms")) return json({ data: formsList });
    if (path.endsWith("/leads")) {
      const formId = path.split("/")[0] ?? "";
      const page = leadPages.get(`${formId}|${url.searchParams.get("after") ?? ""}`);
      return json(page ?? { data: [] });
    }
    const failure = leadErrors.get(path);
    if (failure) return json({ error: failure.error }, failure.status);
    if (metaLeads.has(path)) {
      if (fields.includes("ad_name")) return json(metaExtras.get(path) ?? {});
      return json(metaLeads.get(path));
    }
    if (metaForms.has(path)) {
      if (fields.includes("questions")) return json(metaForms.get(path));
      const wording = metaFormWording.get(path);
      return wording ? json(wording) : json({ error: { message: "(#100) Tried accessing nonexisting field (legal_content)", code: 100 } }, 400);
    }
    return json({ error: { message: `Unsupported get request. Object with ID '${path}' does not exist`, code: 100, error_subcode: 33 } }, 400);
  }) as typeof fetch;
}

function sign(raw: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const QUESTIONS = [
  { key: "full_name", label: "Full name", type: "FULL_NAME" },
  { key: "email", label: "Email", type: "EMAIL" },
  { key: "phone_number", label: "Phone number", type: "PHONE" },
  { key: "which_juice", label: "Which juice do you want?", type: "CUSTOM" },
];

function leadgenPayload(changes: { leadgen_id: string; form_id: string; ad_id?: string }[]) {
  return {
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: WEBHOOK_TIME,
        changes: changes.map((v) => ({ field: "leadgen", value: { ...v, page_id: PAGE_ID, created_time: WEBHOOK_TIME } })),
      },
    ],
  };
}

function metaLead(id: string, formId: string, o: { name?: string; phone?: string; email?: string; juice?: string; ticked?: boolean | string; adId?: string } = {}): Obj {
  const field = (name: string, value: string | undefined) => (value === undefined ? [] : [{ name, values: [value] }]);
  return {
    id,
    created_time: "2026-11-18T10:00:00+0000",
    form_id: formId,
    ...(o.adId ? { ad_id: o.adId } : {}),
    field_data: [...field("full_name", o.name), ...field("phone_number", o.phone), ...field("email", o.email), ...field("which_juice", o.juice)],
    ...(o.ticked === undefined ? {} : { custom_disclaimer_responses: [{ checkbox_key: "wa_ok", is_checked: o.ticked }] }),
  };
}

describe("suite spec 13 — leads from lead forms", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let cfg: MetaConfig;
  let teamId: string;
  let waLineId: string;
  let ownerId: string;
  let repId: string;
  let noLeadsId: string;
  let ownerCookie: string;
  let agentCookie: string;
  let noLeadsCookie: string;

  async function postWebhook(payload: unknown): Promise<Response> {
    const raw = JSON.stringify(payload);
    return fetch(`${baseUrl}/v1/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    });
  }

  async function call<T = Obj>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; error: { code: string; message: string; details?: Obj } | undefined }> {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json()) as { data?: T; error?: { code: string; message: string; details?: Obj } };
    return { status: res.status, data: parsed.data as T, error: parsed.error };
  }

  const leadByMetaId = async (leadgenId: string) => (await db.select().from(lead).where(eq(lead.leadgenId, leadgenId)))[0]!;
  const leadById = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]!;

  /** A lead arrives by webhook and the worker reads it. */
  async function arriveAndProcess(leadgenId: string, formId: string, o: Parameters<typeof metaLead>[2] = {}) {
    metaLeads.set(leadgenId, metaLead(leadgenId, formId, o));
    expect((await postWebhook(leadgenPayload([{ leadgen_id: leadgenId, form_id: formId, ...(o.adId ? { ad_id: o.adId } : {}) }]))).status).toBe(200);
    const stored = await leadByMetaId(leadgenId);
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("fetched");
    return leadByMetaId(leadgenId);
  }

  /** A lead written straight to the table, already read. */
  async function seedLead(values: Partial<typeof lead.$inferInsert> & { leadgenId: string }) {
    const [row] = await db
      .insert(lead)
      .values({ formId: FORM_A, pageId: PAGE_ID, fetchState: "fetched", ...values })
      .returning();
    return row!;
  }

  const sends = () => graphCalls.filter((g) => g.method === "POST" && g.path === `${WA_NUMBER_ID}/messages`);

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.META_APP_ID = OUR_APP_ID;
    delete process.env.INBOX_TEMPLATE_LANGUAGE;
    delete process.env.META_GRAPH_BASE_URL;
    installGraphStub();
    clearPageTokenCache();
    cfg = metaConfigFromEnv()!;
    ownerId = (await seedOwner(db)).id;

    const [team] = await db.insert(inboxTeam).values({ name: "Customer care" }).returning();
    teamId = team!.id;
    await db.insert(inboxPhoneNumber).values({
      kind: "messenger",
      e164: null,
      externalId: PAGE_ID,
      pageExternalId: PAGE_ID,
      externalName: "Mrs Samuel fruit juice",
      label: "Facebook Page",
      channels: "whatsapp",
      defaultTeamId: teamId,
    });
    const [wa] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000013", label: "Main line", channels: "both", wabaId: WABA_ID, waPhoneNumberId: WA_NUMBER_ID, defaultTeamId: teamId })
      .returning();
    waLineId = wa!.id;

    // "agent": may see leads and has inbox access, but is on no team and no number, so sees no conversation.
    await seedUser(db, { email: "agent@example.com", role: "branch_staff", granted: ["leads.view", "inbox.view", "inbox.reply"] });
    // "rep": may see leads and works the WhatsApp number in the team.
    const rep = await seedUser(db, { email: "rep@example.com", role: "branch_staff", granted: ["leads.view", "inbox.view", "inbox.reply"] });
    repId = rep.id;
    await db.insert(inboxTeamMember).values({ teamId, userId: repId });
    await db.insert(inboxUserNumberAccess).values({ userId: repId, phoneNumberId: waLineId });
    // No leads permission at all.
    noLeadsId = (await seedUser(db, { email: "till@example.com", role: "branch_staff" })).id;

    // The form most tests use, as Meta describes it.
    metaForms.set(FORM_A, { id: FORM_A, name: "Bulk orders", questions: QUESTIONS });
    metaFormWording.set(FORM_A, {
      status: "ACTIVE",
      locale: "en_GB",
      legal_content: {
        privacy_policy: { url: "https://www.example.com/privacy" },
        custom_disclaimer: { checkboxes: [{ key: "wa_ok", text: "I agree to be contacted on WhatsApp about my enquiry.", is_required: false }] },
      },
    });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    agentCookie = await loginAs(baseUrl, "agent@example.com", "userpassword123");
    noLeadsCookie = await loginAs(baseUrl, "till@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  // ── Arrival ────────────────────────────────────────────────────────────────

  it("a leadgen webhook stores one pending lead; replaying it stores nothing more", async () => {
    const payload = leadgenPayload([{ leadgen_id: "555000111001", form_id: FORM_A, ad_id: "666000111001" }]);
    graphCalls.length = 0;
    expect((await postWebhook(payload)).status).toBe(200);
    expect((await postWebhook(payload)).status).toBe(200); // Meta retry
    const rows = await db.select().from(lead).where(eq(lead.leadgenId, "555000111001"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fetchState: "pending", formId: FORM_A, pageId: PAGE_ID, adId: "666000111001", isBackfill: false, status: "new" });
    expect(rows[0]!.metaCreatedAt?.toISOString()).toBe(new Date(WEBHOOK_TIME * 1000).toISOString());
    // Stored first, processed, and no call to Meta on the webhook path.
    const events = await db.select().from(inboxWebhookEvent).where(eq(inboxWebhookEvent.kind, "page.leadgen"));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.processedAt !== null && e.lastError === null && e.source === "meta")).toBe(true);
    expect(graphCalls).toHaveLength(0);
  });

  it("one webhook with two leadgen changes stores two leads", async () => {
    const payload = leadgenPayload([
      { leadgen_id: "555000111002", form_id: FORM_A },
      { leadgen_id: "555000111003", form_id: FORM_A },
    ]);
    expect((await postWebhook(payload)).status).toBe(200);
    const rows = await db.select().from(lead).where(sql`${lead.leadgenId} in ('555000111002','555000111003')`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.fetchState === "pending")).toBe(true);
  });

  // ── Reading ────────────────────────────────────────────────────────────────

  it("processLead fetches the lead with the Page token, stores answers and marks it fetched", async () => {
    metaLeads.set(
      "555000111001",
      metaLead("555000111001", FORM_A, { name: "Test Person One", phone: "+2348030000101", email: "One@Example.com", juice: "Pineapple", ticked: "true" }),
    );
    const stored = await leadByMetaId("555000111001");
    graphCalls.length = 0;
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("fetched");
    const read = graphCalls.find((g) => g.path === "555000111001" && g.url.includes("fields=id,created_time"));
    expect(read?.auth).toBe(`Bearer ${PAGE_TOKEN}`);

    const row = await leadById(stored.id);
    expect(row).toMatchObject({
      fetchState: "fetched",
      fullName: "Test Person One",
      phoneRaw: "+2348030000101",
      phoneE164: "+2348030000101",
      email: "one@example.com",
      whatsappConsent: false, // no consent rule has been chosen for the form yet
    });
    expect(row.answers).toEqual([
      { key: "full_name", label: "Full name", values: ["Test Person One"] },
      { key: "email", label: "Email", values: ["One@Example.com"] },
      { key: "phone_number", label: "Phone number", values: ["+2348030000101"] },
      { key: "which_juice", label: "Which juice do you want?", values: ["Pineapple"] },
    ]);
    expect(row.metaCreatedAt?.toISOString()).toBe("2026-11-18T10:00:00.000Z");
    expect(row.consent).toMatchObject({
      form_name: "Bulk orders",
      privacy_policy_url: "https://www.example.com/privacy",
      disclaimers: [{ key: "wa_ok", text: "I agree to be contacted on WhatsApp about my enquiry.", is_checked: true }],
      captured_at: NOW.toISOString(),
    });
    // The form was read on the way and is now known.
    const [form] = await db.select().from(leadForm).where(eq(leadForm.formId, FORM_A));
    expect(form).toMatchObject({ name: "Bulk orders", pageId: PAGE_ID, status: "ACTIVE", isEnabled: true });
    expect(form!.questions).toHaveLength(4);
    expect(form!.disclaimers).toEqual([{ key: "wa_ok", text: "I agree to be contacted on WhatsApp about my enquiry.", is_required: false }]);
    // Processing it again changes nothing.
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("fetched");
  });

  it("processLead creates a customer with phone, name and email when none matches", async () => {
    const row = await arriveAndProcess("555000111004", FORM_A, { name: "Test Person Four", phone: "08030000104", email: "four@example.com" });
    expect(row.customerId).not.toBeNull();
    const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId!));
    expect(cust).toMatchObject({ phone: "+2348030000104", name: "Test Person Four", email: "four@example.com", source: "online" });
  });

  it("processLead links an existing customer matched by phone and changes none of their fields", async () => {
    const [existing] = await db
      .insert(customer)
      .values({ name: "Shop Name", phone: "08030000105", email: null, defaultAddress: "12 Test Road", notes: "likes ginger", source: "walkup_anonymous" })
      .returning();
    const row = await arriveAndProcess("555000111005", FORM_A, { name: "Form Name", phone: "+2348030000105", email: "form105@example.com" });
    expect(row.customerId).toBe(existing!.id);
    const [after] = await db.select().from(customer).where(eq(customer.id, existing!.id));
    expect(after).toEqual(existing); // not the name, not the email, not updated_at
    // The form's own answers stay on the lead.
    expect(row).toMatchObject({ fullName: "Form Name", email: "form105@example.com" });
    expect(await db.select().from(customer).where(eq(customer.email, "form105@example.com"))).toHaveLength(0);
  });

  it("processLead with only an email links the customer with that email, or creates one with no phone", async () => {
    const [known] = await db.insert(customer).values({ name: "Known Person", phone: null, email: "Known@Example.com", source: "online" }).returning();
    const linked = await arriveAndProcess("555000111006", FORM_A, { name: "Someone Else", email: "known@example.com" });
    expect(linked.customerId).toBe(known!.id);
    expect((await db.select().from(customer).where(eq(customer.id, known!.id)))[0]).toEqual(known);
    expect(linked.conversationId).toBeNull(); // no phone, no conversation

    const fresh = await arriveAndProcess("555000111007", FORM_A, { name: "Email Only", email: "only.email@example.com" });
    const [made] = await db.select().from(customer).where(eq(customer.id, fresh.customerId!));
    expect(made).toMatchObject({ name: "Email Only", email: "only.email@example.com", phone: null, source: "online" });
    expect(fresh.conversationId).toBeNull();

    // Neither phone nor email: the lead lives on the Leads page only.
    const nobody = await arriveAndProcess("555000111008", FORM_A, { name: "No Contact" });
    expect(nobody.customerId).toBeNull();
    expect(nobody.conversationId).toBeNull();
  });

  it("processLead opens a conversation, adds an inbound lead message, raises unread, adds the label lead, and does not set last_inbound_wa_at", async () => {
    metaExtras.set("555000111009", { ad_name: "Juice advert", campaign_name: "November", platform: "ig", is_organic: false });
    const row = await arriveAndProcess("555000111009", FORM_A, { name: "Test Person Nine", phone: "+2348030000109", juice: "Orange", adId: "666000111009" });
    expect(row).toMatchObject({ adName: "Juice advert", campaignName: "November", platform: "ig", isOrganic: false, adId: "666000111009" });
    expect(row.conversationId).not.toBeNull();
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, row.conversationId!));
    expect(conv).toMatchObject({
      customerId: row.customerId,
      phoneNumberId: waLineId,
      channel: "whatsapp",
      teamId,
      status: "open",
      unreadCount: 1,
      lastPreview: "New lead: Bulk orders",
      assigneeId: null,
    });
    expect(conv!.labels).toContain("lead");
    // A lead is not a WhatsApp message from the customer: the 24-hour window stays closed.
    expect(conv!.lastInboundWaAt).toBeNull();
    const msgs = await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, conv!.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "in", type: "lead", status: "received", waMessageId: null, channel: "whatsapp", notifiedAt: null });
    expect(msgs[0]!.payload).toEqual({ lead_id: row.id });
    expect(msgs[0]!.body).toBe(
      "Filled in the form “Bulk orders” on Instagram.\nName: Test Person Nine\nPhone: +2348030000109\nWhich juice do you want?: Orange",
    );
    // Nothing was sent to anyone.
    expect(sends()).toHaveLength(0);
  });

  it("processLead for a form that is switched off stores the lead but opens no conversation", async () => {
    await db.insert(leadForm).values({ formId: FORM_OFF, pageId: PAGE_ID, name: "Old form", questions: QUESTIONS, isEnabled: false });
    const row = await arriveAndProcess("555000111010", FORM_OFF, { name: "Test Person Ten", phone: "+2348030000110" });
    expect(row).toMatchObject({ fetchState: "fetched", fullName: "Test Person Ten", conversationId: null });
    expect(row.customerId).not.toBeNull();
    expect(await db.select().from(inboxConversation).where(eq(inboxConversation.customerId, row.customerId!))).toHaveLength(0);
    expect(await db.select().from(inboxMessage).where(sql`${inboxMessage.payload} ->> 'lead_id' = ${row.id}`)).toHaveLength(0);
  });

  it("a temporary Meta error schedules a retry with backoff; the eighth failure marks the lead failed", async () => {
    expect((await postWebhook(leadgenPayload([{ leadgen_id: "555000111011", form_id: FORM_A }]))).status).toBe(200);
    leadErrors.set("555000111011", { status: 400, error: { message: "(#80005) There have been too many leadgen api calls to this Page account.", code: 80005 } });
    const stored = await leadByMetaId("555000111011");
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("retry");
    let row = await leadById(stored.id);
    expect(row).toMatchObject({ fetchState: "pending", fetchAttempts: 1, fetchErrorCode: "80005" });
    expect(row.nextFetchAt.toISOString()).toBe(new Date(NOW.getTime() + 30_000).toISOString());
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("retry");
    row = await leadById(stored.id);
    expect(row.fetchAttempts).toBe(2);
    expect(row.nextFetchAt.toISOString()).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    for (let attempt = 3; attempt <= 7; attempt++) expect(await processLead(db, cfg, stored.id, NOW)).toBe("retry");
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("failed");
    row = await leadById(stored.id);
    expect(row).toMatchObject({ fetchState: "failed", fetchAttempts: 8, fetchErrorCode: "80005" });
    // A temporary problem never alerts the owner.
    expect(await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "lead.fetch_blocked"))).toHaveLength(0);
    leadErrors.delete("555000111011");
  });

  it("error 200 marks the lead failed and queues one lead.fetch_blocked alert per day", async () => {
    const refused: MetaErr = { status: 403, error: { message: "(#200) Requires leads_retrieval permission", code: 200 } };
    leadErrors.set("555000111012", refused);
    leadErrors.set("555000111013", refused);
    expect(
      (await postWebhook(leadgenPayload([{ leadgen_id: "555000111012", form_id: FORM_A }, { leadgen_id: "555000111013", form_id: FORM_A }]))).status,
    ).toBe(200);
    const first = await leadByMetaId("555000111012");
    const second = await leadByMetaId("555000111013");
    expect(await processLead(db, cfg, first.id, NOW)).toBe("failed");
    expect(await processLead(db, cfg, second.id, NOW)).toBe("failed");
    expect(await leadById(first.id)).toMatchObject({ fetchState: "failed", fetchErrorCode: "200", fetchAttempts: 0 });
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "lead.fetch_blocked"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account: PAGE_ID, code: "200", message: "(#200) Requires leads_retrieval permission" });

    // The list says how many could not be read; "Try again" puts them back in the queue.
    const list = await call<{ problems: { failed: number } }>(ownerCookie, "GET", "/leads?q=nobody-matches-this");
    expect(list.status).toBe(200);
    expect(list.data.problems.failed).toBeGreaterThanOrEqual(2);
    expect((await call(agentCookie, "POST", "/leads/retry-failed")).status).toBe(403); // needs channels.manage
    leadErrors.delete("555000111012");
    leadErrors.delete("555000111013");
    metaLeads.set("555000111012", metaLead("555000111012", FORM_A, { name: "Back Again" }));
    const retry = await call<{ requeued: number }>(ownerCookie, "POST", "/leads/retry-failed");
    expect(retry.status).toBe(200);
    expect(retry.data.requeued).toBeGreaterThanOrEqual(2);
    expect(await leadById(first.id)).toMatchObject({ fetchState: "pending", fetchAttempts: 0 });
    expect(await processLead(db, cfg, first.id, NOW)).toBe("fetched");
  });

  it('error 100 "does not exist" marks the lead gone and it is not listed', async () => {
    // No such lead at Meta: the stub answers code 100 "does not exist".
    expect((await postWebhook(leadgenPayload([{ leadgen_id: "555000111014", form_id: FORM_A }]))).status).toBe(200);
    const stored = await leadByMetaId("555000111014");
    expect(await processLead(db, cfg, stored.id, NOW)).toBe("gone");
    expect(await leadById(stored.id)).toMatchObject({ fetchState: "gone", fetchErrorCode: "100/33" });
    const list = await call<{ leads: { id: string }[] }>(ownerCookie, "GET", "/leads?status=all&include_tests=true&limit=200");
    expect(list.status).toBe(200);
    expect(list.data.leads.some((l) => l.id === stored.id)).toBe(false);
    expect((await call(ownerCookie, "GET", `/leads/${stored.id}`)).status).toBe(404);
  });

  // ── Working leads ──────────────────────────────────────────────────────────

  it("GET /v1/leads needs leads.view; filters by status, form, owner and search; hides test leads by default", async () => {
    const F1 = "888000111001";
    const F2 = "888000111002";
    const at = (hour: number) => new Date(`2026-05-10T${String(hour).padStart(2, "0")}:00:00.000Z`);
    const s1 = await seedLead({ leadgenId: "888100000001", formId: F1, status: "new", fullName: "Zainab Filter", phoneRaw: "08030000201", phoneE164: "+2348030000201", assigneeId: ownerId, metaCreatedAt: at(15) });
    const s2 = await seedLead({ leadgenId: "888100000002", formId: F1, status: "contacted", fullName: "Yusuf Filter", email: "yusuf.filter@example.com", firstContactedAt: at(16), metaCreatedAt: at(14) });
    const s3 = await seedLead({ leadgenId: "888100000003", formId: F2, status: "won", fullName: "Xena Filter", metaCreatedAt: at(13) });
    const s4 = await seedLead({ leadgenId: "888100000004", formId: F1, status: "lost", lostReason: "test", fullName: "Trial Filter", metaCreatedAt: at(12) });
    const s5 = await seedLead({ leadgenId: "888100000005", formId: F1, status: "lost", lostReason: "no_answer", fullName: "Wale Filter", metaCreatedAt: at(11) });

    expect((await call(noLeadsCookie, "GET", "/leads")).status).toBe(403);

    type List = { leads: { id: string; form_id: string; status: string }[]; counts: { new: number; contacted: number; won: number; lost: number } };
    const ids = (r: { data: List }) => r.data.leads.map((l) => l.id);

    const form = await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}`);
    expect(form.status).toBe(200);
    expect(ids(form)).toEqual([s1.id, s2.id, s5.id]); // newest first; the test lead is hidden
    expect(form.data.counts).toEqual({ new: 1, contacted: 1, won: 0, lost: 1 });

    const withTests = await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&include_tests=true`);
    expect(ids(withTests)).toEqual([s1.id, s2.id, s4.id, s5.id]);
    expect(withTests.data.counts.lost).toBe(2);

    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&status=new`))).toEqual([s1.id]);
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&status=open`))).toEqual([s1.id, s2.id]);
    expect(ids(await call<List>(ownerCookie, "GET", "/leads?q=Filter&status=won"))).toEqual([s3.id]);
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&assignee=me`))).toEqual([s1.id]);
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&assignee=none`))).toEqual([s2.id, s5.id]);
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&assignee=${ownerId}`))).toEqual([s1.id]);
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?q=${encodeURIComponent("yusuf.filter@")}`))).toEqual([s2.id]);
    expect(ids(await call<List>(ownerCookie, "GET", "/leads?q=8030000201"))).toEqual([s1.id]);
    // Lagos days: 2026-05-10 holds all five; the day before holds none.
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&from=2026-05-10&to=2026-05-10`))).toEqual([s1.id, s2.id, s5.id]);
    expect(ids(await call<List>(ownerCookie, "GET", `/leads?form_id=${F1}&from=2026-05-09&to=2026-05-09`))).toEqual([]);
    expect((await call(ownerCookie, "GET", "/leads?status=nonsense")).status).toBe(400);

    // The download uses the same filters and needs inbox.export as well.
    const csv = await fetch(`${baseUrl}/v1/leads/export.csv?form_id=${F1}`, { headers: { cookie: ownerCookie } });
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("Received,Name,Phone,Email,Form,Advert,Campaign,Status,Lost reason,Owner,First contacted");
    expect(text).toContain("Zainab Filter");
    expect(text).not.toContain("Trial Filter");
    expect((await fetch(`${baseUrl}/v1/leads/export.csv`, { headers: { cookie: agentCookie } })).status).toBe(403);
  });

  it("GET /v1/leads returns conversation_id null to a viewer who cannot see that conversation", async () => {
    const row = await arriveAndProcess("555000111015", FORM_A, { name: "Hidden Thread", phone: "+2348030000115" });
    expect(row.conversationId).not.toBeNull();
    type List = { leads: { id: string; conversation_id: string | null }[] };
    const asOwner = await call<List>(ownerCookie, "GET", `/leads?q=${encodeURIComponent("Hidden Thread")}`);
    expect(asOwner.data.leads).toHaveLength(1);
    expect(asOwner.data.leads[0]!.conversation_id).toBe(row.conversationId);
    // The agent sees the lead itself, but not the conversation behind it (one visibility rule).
    const asAgent = await call<List>(agentCookie, "GET", `/leads?q=${encodeURIComponent("Hidden Thread")}`);
    expect(asAgent.status).toBe(200);
    expect(asAgent.data.leads).toHaveLength(1);
    expect(asAgent.data.leads[0]!.conversation_id).toBeNull();
    const detail = await call<{ conversation_id: string | null; can_open_conversation: boolean }>(agentCookie, "GET", `/leads/${row.id}`);
    expect(detail.data).toMatchObject({ conversation_id: null, can_open_conversation: false });
    expect((await call(agentCookie, "POST", `/leads/${row.id}/conversation`)).status).toBe(403);
    // The owner opens it: the same conversation, no second announcing message, no extra unread.
    const open = await call<{ conversation_id: string }>(ownerCookie, "POST", `/leads/${row.id}/conversation`);
    expect(open.status).toBe(200);
    expect(open.data.conversation_id).toBe(row.conversationId);
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, row.conversationId!))).toHaveLength(1);
    expect((await db.select().from(inboxConversation).where(eq(inboxConversation.id, row.conversationId!)))[0]!.unreadCount).toBe(1);
  });

  it("PATCH status to lost without a reason is refused; with a reason sets closed_at; back to new clears both", async () => {
    const l = await seedLead({ leadgenId: "888100000010", fullName: "Status Person" });
    const refused = await call(ownerCookie, "PATCH", `/leads/${l.id}`, { status: "lost" });
    expect(refused.status).toBe(422);
    expect(refused.error?.details?.reason).toBe("reason_required");
    expect(await leadById(l.id)).toMatchObject({ status: "new", closedAt: null });

    const lost = await call<{ status: string; lost_reason: string | null }>(ownerCookie, "PATCH", `/leads/${l.id}`, { status: "lost", lost_reason: "no_answer" });
    expect(lost.status).toBe(200);
    expect(lost.data).toMatchObject({ status: "lost", lost_reason: "no_answer" });
    let row = await leadById(l.id);
    expect(row.closedAt).not.toBeNull();
    expect(row.firstContactedAt).not.toBeNull(); // the first move away from "new"

    const back = await call<{ status: string; lost_reason: string | null }>(ownerCookie, "PATCH", `/leads/${l.id}`, { status: "new" });
    expect(back.status).toBe(200);
    expect(back.data).toMatchObject({ status: "new", lost_reason: null });
    row = await leadById(l.id);
    expect(row).toMatchObject({ status: "new", lostReason: null, closedAt: null });

    // A note is saved and audited; an unknown key is refused.
    expect((await call(ownerCookie, "PATCH", `/leads/${l.id}`, { note: "Call after 4pm" })).status).toBe(200);
    expect((await leadById(l.id)).note).toBe("Call after 4pm");
    expect((await call(ownerCookie, "PATCH", `/leads/${l.id}`, { full_name: "Changed" })).status).toBe(400);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "lead.update"), eq(auditLog.entityId, l.id)));
    expect(audits).toHaveLength(3);
  });

  it("PATCH assignee also assigns an unassigned conversation", async () => {
    const row = await arriveAndProcess("555000111016", FORM_A, { name: "Owned Lead", phone: "+2348030000116" });
    // Someone without leads.view cannot own a lead.
    expect((await call(ownerCookie, "PATCH", `/leads/${row.id}`, { assignee_id: noLeadsId })).status).toBe(422);
    const res = await call<{ assignee: { id: string; name: string } | null }>(ownerCookie, "PATCH", `/leads/${row.id}`, { assignee_id: repId });
    expect(res.status).toBe(200);
    expect(res.data.assignee).toEqual({ id: repId, name: "rep@example.com" });
    expect((await leadById(row.id)).assigneeId).toBe(repId);
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, row.conversationId!));
    expect(conv!.assigneeId).toBe(repId);
  });

  // ── Follow-up ──────────────────────────────────────────────────────────────

  it("POST follow-up is refused with no_consent, no_template and no_phone in turn", async () => {
    const noConsent = await seedLead({ leadgenId: "888100000020", fullName: "No Consent", phoneRaw: "08030000140", phoneE164: "+2348030000140", whatsappConsent: false });
    const noTemplate = await seedLead({ leadgenId: "888100000021", fullName: "No Template", phoneRaw: "08030000141", phoneE164: "+2348030000141", whatsappConsent: true });
    const noPhone = await seedLead({ leadgenId: "888100000022", fullName: "No Phone", email: "nophone@example.com", whatsappConsent: true });
    graphCalls.length = 0;
    const reason = async (id: string) => {
      const res = await call(ownerCookie, "POST", `/leads/${id}/follow-up`, { confirm: true });
      expect(res.status).toBe(409);
      return res.error?.details?.reason;
    };
    expect(await reason(noConsent.id)).toBe("no_consent");
    expect(await reason(noTemplate.id)).toBe("no_template"); // no approved lead_followup template exists yet
    expect(await reason(noPhone.id)).toBe("no_phone");
    // Without the confirmation nothing is even considered.
    expect((await call(ownerCookie, "POST", `/leads/${noTemplate.id}/follow-up`, {})).status).toBe(400);
    // The agent has no inbox.templates.
    expect((await call(agentCookie, "POST", `/leads/${noTemplate.id}/follow-up`, { confirm: true })).status).toBe(403);
    // Nothing was sent and no conversation was opened for any of them.
    expect(sends()).toHaveLength(0);
    expect((await leadById(noTemplate.id)).conversationId).toBeNull();
    const detail = await call<{ can_follow_up: boolean; follow_up_blocked_reason: string | null }>(ownerCookie, "GET", `/leads/${noConsent.id}`);
    expect(detail.data).toMatchObject({ can_follow_up: false, follow_up_blocked_reason: "no_consent" });
  });

  it("POST follow-up sends the lead_followup template, sets followup_sent_at and moves new to contacted", async () => {
    await db.insert(inboxTemplate).values({
      wabaId: WABA_ID,
      name: "lead_followup",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hello {{1}}, this is Mrs. Samuel Fruit Juice. Thank you for filling in our form. How can we help you today?" }],
    });
    const l = await seedLead({ leadgenId: "888100000030", fullName: "Ngozi Sample", phoneRaw: "08030000130", phoneE164: "+2348030000130", whatsappConsent: true });
    const detail = await call<{ can_follow_up: boolean; follow_up_preview: { phone: string; line_label: string; text: string } | null }>(ownerCookie, "GET", `/leads/${l.id}`);
    expect(detail.data.can_follow_up).toBe(true);
    expect(detail.data.follow_up_preview).toEqual({
      phone: "+2348030000130",
      line_label: "Main line",
      text: "Hello Ngozi, this is Mrs. Samuel Fruit Juice. Thank you for filling in our form. How can we help you today?",
    });

    graphCalls.length = 0;
    const res = await call<{ message_id: string; status: string }>(ownerCookie, "POST", `/leads/${l.id}/follow-up`, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("sent");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.body).toMatchObject({
      to: "2348030000130",
      type: "template",
      template: { name: "lead_followup", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ngozi" }] }] },
    });

    const row = await leadById(l.id);
    expect(row.followupSentAt).not.toBeNull();
    expect(row.firstContactedAt).not.toBeNull();
    expect(row).toMatchObject({ status: "contacted" });
    expect(row.conversationId).not.toBeNull();
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, row.conversationId!));
    expect(conv!.lastInboundWaAt).toBeNull(); // still no message from the customer
    expect(conv!.unreadCount).toBe(0); // opened by the button, not announced
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, res.data.message_id));
    expect(msg).toMatchObject({ direction: "out", type: "template", templateName: "lead_followup", status: "sent", senderUserId: ownerId });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "lead.follow_up"), eq(auditLog.entityId, l.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(ownerId);
  });

  it("POST follow-up twice is refused with already_sent unless again is true", async () => {
    const l = await seedLead({ leadgenId: "888100000031", fullName: "Twice Sample", phoneRaw: "08030000131", phoneE164: "+2348030000131", whatsappConsent: true });
    graphCalls.length = 0;
    expect((await call(ownerCookie, "POST", `/leads/${l.id}/follow-up`, { confirm: true })).status).toBe(200);
    const second = await call(ownerCookie, "POST", `/leads/${l.id}/follow-up`, { confirm: true });
    expect(second.status).toBe(409);
    expect(second.error?.details?.reason).toBe("already_sent");
    expect(sends()).toHaveLength(1);
    const again = await call(ownerCookie, "POST", `/leads/${l.id}/follow-up`, { confirm: true, again: true });
    expect(again.status).toBe(200);
    expect(sends()).toHaveLength(2);
  });

  // ── Forms ──────────────────────────────────────────────────────────────────

  it("POST forms/sync upserts forms and reads their questions", async () => {
    formsList = [
      { id: FORM_A, name: "Bulk orders" },
      { id: FORM_NEW, name: "Events" },
    ];
    metaForms.set(FORM_NEW, { id: FORM_NEW, name: "Events", questions: QUESTIONS.slice(0, 3) });
    expect((await call(agentCookie, "POST", "/leads/forms/sync")).status).toBe(403); // needs channels.manage
    const res = await call<{ forms: number }>(ownerCookie, "POST", "/leads/forms/sync");
    expect(res.status).toBe(200);
    expect(res.data.forms).toBe(2);
    const [made] = await db.select().from(leadForm).where(eq(leadForm.formId, FORM_NEW));
    expect(made).toMatchObject({ name: "Events", pageId: PAGE_ID, isEnabled: true, disclaimers: [] });
    expect(made!.questions).toHaveLength(3);
    expect(made!.syncedAt).not.toBeNull();

    type FormRow = { form_id: string; name: string; questions_count: number; is_enabled: boolean };
    const list = await call<FormRow[]>(agentCookie, "GET", "/leads/forms"); // reading needs leads.view only
    expect(list.status).toBe(200);
    expect(list.data.find((f) => f.form_id === FORM_NEW)).toMatchObject({ name: "Events", questions_count: 3, is_enabled: true });
    expect(list.data.find((f) => f.form_id === FORM_A)).toMatchObject({ name: "Bulk orders", questions_count: 4 });
  });

  it("PATCH forms/:id refuses a consent key the form does not have", async () => {
    const [form] = await db.select().from(leadForm).where(eq(leadForm.formId, FORM_A));
    expect(form!.disclaimers.map((d) => d.key)).toEqual(["wa_ok"]);
    const bad = await call(ownerCookie, "PATCH", `/leads/forms/${form!.id}`, { whatsapp_consent_key: "not_on_this_form" });
    expect(bad.status).toBe(422);
    expect((await db.select().from(leadForm).where(eq(leadForm.id, form!.id)))[0]!.whatsappConsentKey).toBeNull();
    expect((await call(agentCookie, "PATCH", `/leads/forms/${form!.id}`, { is_enabled: false })).status).toBe(403);

    // The lead from the third test ticked "wa_ok" but had no consent while no rule was chosen.
    const ticked = await leadByMetaId("555000111001");
    expect(ticked.whatsappConsent).toBe(false);
    const ok = await call<{ whatsapp_consent_key: string | null }>(ownerCookie, "PATCH", `/leads/forms/${form!.id}`, { whatsapp_consent_key: "wa_ok" });
    expect(ok.status).toBe(200);
    expect(ok.data.whatsapp_consent_key).toBe("wa_ok");
    expect((await leadById(ticked.id)).whatsappConsent).toBe(true);
    // A lead on the same form that did not tick it stays without consent.
    expect((await leadByMetaId("555000111004")).whatsappConsent).toBe(false);

    // A new lead that ticks the box now has consent from the start; one that does not, has none.
    const yes = await arriveAndProcess("555000111017", FORM_A, { name: "Ticked Box", phone: "+2348030000117", ticked: true });
    expect(yes.whatsappConsent).toBe(true);
    const no = await arriveAndProcess("555000111018", FORM_A, { name: "Left Blank", phone: "+2348030000118", ticked: false });
    expect(no.whatsappConsent).toBe(false);
  });

  // ── Back-fill ──────────────────────────────────────────────────────────────

  it("back-fill stores earlier leads as is_backfill with no conversation and no unread, follows the cursor and finishes", async () => {
    const [form] = await db.insert(leadForm).values({ formId: FORM_BACKFILL, pageId: PAGE_ID, name: "Earlier form", questions: QUESTIONS }).returning();
    leadPages.set(`${FORM_BACKFILL}|`, {
      data: [
        metaLead("555000222001", FORM_BACKFILL, { name: "Earlier One", phone: "+2348030000301" }),
        metaLead("555000222002", FORM_BACKFILL, { name: "Earlier Two", phone: "+2348030000302" }),
      ],
      paging: { cursors: { after: "CURSOR1" }, next: "https://graph.facebook.com/v23.0/next-page" },
    });
    leadPages.set(`${FORM_BACKFILL}|CURSOR1`, {
      data: [metaLead("555000222003", FORM_BACKFILL, { name: "Earlier Three", email: "earlier3@example.com" })],
      paging: { cursors: { after: "CURSOR2" } },
    });

    expect((await call(agentCookie, "POST", `/leads/forms/${form!.id}/backfill`, { confirm: true })).status).toBe(403);
    expect((await call(ownerCookie, "POST", `/leads/forms/${form!.id}/backfill`, {})).status).toBe(400);
    const start = await call<{ queued: boolean }>(ownerCookie, "POST", `/leads/forms/${form!.id}/backfill`, { confirm: true });
    expect(start.status).toBe(202);
    expect(start.data).toEqual({ queued: true });
    const running = await call(ownerCookie, "POST", `/leads/forms/${form!.id}/backfill`, { confirm: true });
    expect(running.status).toBe(409);
    expect(running.error?.details?.reason).toBe("backfill_running");

    graphCalls.length = 0;
    expect(await backfillLeadsPage(db, cfg, NOW)).toEqual({ formId: FORM_BACKFILL, stored: 2, done: false, stopped: false });
    let f = (await db.select().from(leadForm).where(eq(leadForm.id, form!.id)))[0]!;
    expect(f).toMatchObject({ backfillCursor: "CURSOR1", backfillCount: 2, backfillDoneAt: null });
    const firstPage = graphCalls.find((g) => g.path === `${FORM_BACKFILL}/leads`)!;
    const filtering = JSON.parse(new URL(firstPage.url).searchParams.get("filtering")!) as { field: string; operator: string; value: number }[];
    expect(filtering[0]).toMatchObject({ field: "time_created", operator: "GREATER_THAN" });
    expect(firstPage.auth).toBe(`Bearer ${PAGE_TOKEN}`);

    expect(await backfillLeadsPage(db, cfg, NOW)).toEqual({ formId: FORM_BACKFILL, stored: 1, done: true, stopped: false });
    f = (await db.select().from(leadForm).where(eq(leadForm.id, form!.id)))[0]!;
    expect(f.backfillCount).toBe(3);
    expect(f.backfillDoneAt?.toISOString()).toBe(NOW.toISOString());
    expect(await backfillLeadsPage(db, cfg, NOW)).toBeNull(); // nothing is waiting any more

    const rows = await db.select().from(lead).where(eq(lead.formId, FORM_BACKFILL));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isBackfill && r.fetchState === "fetched" && r.conversationId === null)).toBe(true);
    // The leads were finished from the page's own data: no call per lead.
    expect(graphCalls.some((g) => g.path.startsWith("555000222"))).toBe(false);
    const one = rows.find((r) => r.leadgenId === "555000222001")!;
    expect(one).toMatchObject({ fullName: "Earlier One", phoneE164: "+2348030000301" });
    expect(one.customerId).not.toBeNull();
    // Nobody is alerted: no conversation, no message, nothing unread.
    expect(await db.select().from(inboxConversation).where(eq(inboxConversation.customerId, one.customerId!))).toHaveLength(0);
    expect(await db.select().from(inboxMessage).where(sql`${inboxMessage.payload} ->> 'lead_id' = ${one.id}`)).toHaveLength(0);
    expect(sends().length).toBe(0);
  });

  it("back-fill skips a lead already stored from the webhook", async () => {
    const [form] = await db.insert(leadForm).values({ formId: FORM_MIXED, pageId: PAGE_ID, name: "Mixed form", questions: QUESTIONS }).returning();
    expect((await postWebhook(leadgenPayload([{ leadgen_id: "555000333001", form_id: FORM_MIXED }]))).status).toBe(200);
    leadPages.set(`${FORM_MIXED}|`, {
      data: [
        metaLead("555000333001", FORM_MIXED, { name: "From Webhook", phone: "+2348030000401" }),
        metaLead("555000333002", FORM_MIXED, { name: "Only Earlier", phone: "+2348030000402" }),
      ],
      paging: { cursors: { after: "END" } },
    });
    expect((await call(ownerCookie, "POST", `/leads/forms/${form!.id}/backfill`, { confirm: true })).status).toBe(202);
    expect(await backfillLeadsPage(db, cfg, NOW)).toEqual({ formId: FORM_MIXED, stored: 1, done: true, stopped: false });
    const fromWebhook = await db.select().from(lead).where(eq(lead.leadgenId, "555000333001"));
    expect(fromWebhook).toHaveLength(1);
    expect(fromWebhook[0]).toMatchObject({ isBackfill: false, fetchState: "pending" }); // untouched: the worker reads it the normal way
    expect(await leadByMetaId("555000333002")).toMatchObject({ isBackfill: true, fetchState: "fetched" });
    expect((await db.select().from(leadForm).where(eq(leadForm.id, form!.id)))[0]!.backfillCount).toBe(1);
  });

  // ── Connection ─────────────────────────────────────────────────────────────

  it("health/subscribe posts the union of existing fields and leadgen, and does nothing when leadgen is already there", async () => {
    subscribedFields = ["messages", "message_echoes"];
    const before = await call<{ subscribed: boolean; token_ok: boolean }>(ownerCookie, "GET", "/leads/health");
    expect(before.data).toMatchObject({ token_ok: true, subscribed: false });
    expect((await call(ownerCookie, "POST", "/leads/health/subscribe", {})).status).toBe(400); // needs the confirmation
    expect((await call(agentCookie, "POST", "/leads/health/subscribe", { confirm: true })).status).toBe(403);

    graphCalls.length = 0;
    const first = await call<{ subscribed: boolean; changed: boolean; fields: string[] }>(ownerCookie, "POST", "/leads/health/subscribe", { confirm: true });
    expect(first.status).toBe(200);
    expect(first.data).toEqual({ subscribed: true, changed: true, fields: ["messages", "message_echoes", "leadgen"] });
    const posts = () => graphCalls.filter((g) => g.method === "POST" && g.path === `${PAGE_ID}/subscribed_apps`);
    expect(posts()).toHaveLength(1);
    expect(new URL(posts()[0]!.url).searchParams.get("subscribed_fields")).toBe("messages,message_echoes,leadgen");
    expect(posts()[0]!.auth).toBe(`Bearer ${PAGE_TOKEN}`);

    const second = await call<{ changed: boolean }>(ownerCookie, "POST", "/leads/health/subscribe", { confirm: true });
    expect(second.status).toBe(200);
    expect(second.data.changed).toBe(false);
    expect(posts()).toHaveLength(1); // nothing more was posted

    const health = await call<Obj>(ownerCookie, "GET", "/leads/health");
    expect(health.data).toEqual({
      page: { id: PAGE_ID, name: "Mrs Samuel fruit juice" },
      token_ok: true,
      subscribed: true,
      can_list_forms: true,
      problems: [],
    });
    // No token of any kind comes back.
    expect(JSON.stringify(health.data)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(health.data)).not.toContain(SYSTEM_TOKEN);
  });

  // ── Erase and merge ────────────────────────────────────────────────────────

  it("erasing a customer blanks their leads' answers and contact fields and keeps the rows", async () => {
    const row = await arriveAndProcess("555000111019", FORM_A, { name: "Erase Me", phone: "+2348030000119", email: "erase@example.com", juice: "Mango", ticked: true });
    expect((await call(ownerCookie, "PATCH", `/leads/${row.id}`, { note: "private note" })).status).toBe(200);
    expect(row.conversationId).not.toBeNull();
    const res = await call<{ leads: number; conversations: number }>(ownerCookie, "POST", `/inbox/contacts/${row.customerId}/erase`, { confirm: "08030000119" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ leads: 1, conversations: 1 });
    const after = await leadById(row.id);
    expect(after).toMatchObject({
      answers: [],
      fullName: null,
      phoneRaw: null,
      phoneE164: null,
      email: null,
      consent: null,
      note: null,
      whatsappConsent: false,
      conversationId: null,
      customerId: row.customerId, // the customer record is the shop's own and stays
      fetchState: "fetched",
      status: "new",
    });
    expect(after.erasedAt).not.toBeNull();
    const detail = await call<{ erased: boolean; can_follow_up: boolean; follow_up_blocked_reason: string | null }>(ownerCookie, "GET", `/leads/${row.id}`);
    expect(detail.data).toMatchObject({ erased: true, can_follow_up: false, follow_up_blocked_reason: "no_phone" });
  });

  it("merging contacts moves leads to the kept customer", async () => {
    const row = await arriveAndProcess("555000111020", FORM_A, { name: "Duplicate Person", phone: "+2348030000120" });
    const [kept] = await db.insert(customer).values({ name: "Kept Person", phone: null, source: "online" }).returning();
    const res = await call<{ moved_conversations: number }>(ownerCookie, "POST", `/inbox/contacts/${row.customerId}/merge`, { into_customer_id: kept!.id });
    expect(res.status).toBe(200);
    expect(res.data.moved_conversations).toBe(1);
    const after = await leadById(row.id);
    expect(after.customerId).toBe(kept!.id);
    expect(after.conversationId).toBe(row.conversationId); // the thread moved with them
    expect((await db.select().from(inboxConversation).where(eq(inboxConversation.id, row.conversationId!)))[0]!.customerId).toBe(kept!.id);
  });

  // ── Report ─────────────────────────────────────────────────────────────────

  it("GET /report counts by form and advert, leaves out test leads, and computes win rate and the median", async () => {
    const R1 = "999000111001";
    const R2 = "999000111002";
    const t = (iso: string) => new Date(iso);
    const plus = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000);
    const ad1 = { adId: "666000999001", adName: "Ad one", campaignName: "March push" };
    const ad2 = { adId: "666000999002", adName: "Ad two", campaignName: "March push" };
    await seedLead({ leadgenId: "999100000001", formId: R1, ...ad1, status: "won", metaCreatedAt: t("2026-03-10T08:00:00Z"), firstContactedAt: plus("2026-03-10T08:00:00Z", 10), closedAt: t("2026-03-10T12:00:00Z") });
    await seedLead({ leadgenId: "999100000002", formId: R1, ...ad1, status: "lost", lostReason: "no_answer", metaCreatedAt: t("2026-03-10T09:00:00Z"), firstContactedAt: plus("2026-03-10T09:00:00Z", 30), closedAt: t("2026-03-10T12:00:00Z") });
    await seedLead({ leadgenId: "999100000003", formId: R1, status: "new", isOrganic: true, metaCreatedAt: t("2026-03-11T09:00:00Z") });
    await seedLead({ leadgenId: "999100000004", formId: R2, ...ad2, status: "contacted", metaCreatedAt: t("2026-03-11T10:00:00Z"), firstContactedAt: plus("2026-03-11T10:00:00Z", 20) });
    // Left out: a test lead, a lead not read yet, and one that belongs to the next Lagos day (00:30 on the 13th).
    await seedLead({ leadgenId: "999100000005", formId: R2, status: "lost", lostReason: "test", metaCreatedAt: t("2026-03-12T09:00:00Z") });
    await seedLead({ leadgenId: "999100000006", formId: R2, fetchState: "pending", metaCreatedAt: t("2026-03-12T09:00:00Z") });
    await seedLead({ leadgenId: "999100000007", formId: R1, status: "won", metaCreatedAt: t("2026-03-12T23:30:00Z") });

    expect((await call(noLeadsCookie, "GET", "/leads/report?from=2026-03-10&to=2026-03-12")).status).toBe(403);
    type Row = { leads: number; contacted: number; won: number; lost: number; win_rate: number | null };
    type Report = {
      range: { from: string; to: string };
      totals: Row & { new: number; median_minutes_to_first_contact: number | null };
      by_form: (Row & { form_id: string; form_name: string })[];
      by_ad: (Row & { ad_id: string; ad_name: string | null; campaign_name: string | null })[];
      by_day: { day: string; leads: number }[];
    };
    const res = await call<Report>(ownerCookie, "GET", "/leads/report?from=2026-03-10&to=2026-03-12");
    expect(res.status).toBe(200);
    expect(res.data.range).toEqual({ from: "2026-03-10", to: "2026-03-12" });
    expect(res.data.totals).toMatchObject({ leads: 4, new: 1, contacted: 3, won: 1, lost: 1, win_rate: 0.5 });
    expect(res.data.totals.median_minutes_to_first_contact).toBeCloseTo(20, 5);
    expect(res.data.by_form).toEqual([
      { form_id: R1, form_name: "Lead form", leads: 3, contacted: 2, won: 1, lost: 1, win_rate: 0.5 },
      { form_id: R2, form_name: "Lead form", leads: 1, contacted: 1, won: 0, lost: 0, win_rate: null },
    ]);
    expect(res.data.by_ad).toEqual([
      { ad_id: "666000999001", ad_name: "Ad one", campaign_name: "March push", leads: 2, contacted: 2, won: 1, lost: 1, win_rate: 0.5 },
      { ad_id: "666000999002", ad_name: "Ad two", campaign_name: "March push", leads: 1, contacted: 1, won: 0, lost: 0, win_rate: null },
    ]);
    expect(res.data.by_day).toEqual([
      { day: "2026-03-10", leads: 2 },
      { day: "2026-03-11", leads: 2 },
    ]);
    expect((await call(ownerCookie, "GET", "/leads/report?from=2026-03-12&to=2026-03-10")).status).toBe(400);
  });
});
