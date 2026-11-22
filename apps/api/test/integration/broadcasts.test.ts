import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  appSetting,
  broadcast,
  broadcastEvent,
  broadcastRecipient,
  contactConsent,
  contactList,
  contactListMember,
  customer,
  inboxPhoneNumber,
  inboxTemplate,
  saleOrder,
} from "@ms/db";
import { refreshContactSummary } from "@ms/domain";
import { BROADCAST_SETTINGS_KEY, DEFAULT_BROADCAST_SETTINGS } from "@ms/shared";
import { loginAs, seedOnlineOrder, seedOwner, seedUser, setupTestDb } from "./helpers.js";

/**
 * Suite spec 14, Phase B: the broadcast routes against a real Postgres. Meta is a stub: no
 * request leaves this machine. Phone numbers are in the made-up range 0700 555 6xxx. The
 * clock is fixed at 12:00 Lagos time, inside the default sending hours.
 */

const WA_NUMBER_ID = "5550006000";
const NOW = new Date("2026-11-20T11:00:00Z");

const graphCalls: { url: string; method: string; body: unknown }[] = [];
let seq = 0;
function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
      graphCalls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/media")) return new Response(JSON.stringify({ id: `media-${++seq}` }), { status: 200 });
      if (url.includes("marketing_messages_onboarding_status")) return new Response(JSON.stringify({ marketing_messages_onboarding_status: "ELIGIBLE" }), { status: 200 });
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ quality_rating: "GREEN", status: "CONNECTED", whatsapp_business_manager_messaging_limit: "TIER_250" }), { status: 200 });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.bc.${++seq}` }] }), { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
}
const sends = () => graphCalls.filter((c) => c.method === "POST" && /\/(messages|marketing_messages)$/.test(c.url));

const PROMO = {
  name: "november_promo",
  category: "MARKETING",
  components: [
    { type: "BODY", text: "Hi {{1}}, fresh juice is 10% off this week." },
    { type: "FOOTER", text: "Reply STOP to stop these messages" },
  ],
};
const PROMO_NO_STOP = { name: "promo_no_stop", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{1}}, big sale!" }] };
const UPDATE = { name: "shop_update", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, our opening hours changed." }] };

describe("broadcasts routes (suite spec 14, Phase B)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let owner: string;
  let admin: string;
  let manager: string;
  let lineId: string;
  let promoId: string;
  let updateId: string;
  let listId: string;
  const people: Record<string, string> = {};

  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}/v1/broadcasts${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: { data?: Record<string, unknown> & unknown; error?: { message?: string; details?: Record<string, unknown> } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* csv */
    }
    return { status: res.status, json, text };
  };
  const setSettings = async (patch: Partial<typeof DEFAULT_BROADCAST_SETTINGS>) => {
    const value = { ...DEFAULT_BROADCAST_SETTINGS, ...patch };
    await db.insert(appSetting).values({ key: BROADCAST_SETTINGS_KEY, value }).onConflictDoUpdate({ target: appSetting.key, set: { value } });
  };
  async function person(key: string, o: { phone: string | null; name?: string; consent?: "granted" | "withdrawn" | null; createdAt?: Date }) {
    const [c] = await db
      .insert(customer)
      .values({ name: o.name ?? key, phone: o.phone, source: "online", createdAt: o.createdAt ?? new Date(NOW.getTime() - (100 - Object.keys(people).length) * 60_000) })
      .returning();
    people[key] = c!.id;
    if (o.consent) {
      await db.insert(contactConsent).values({ customerId: c!.id, channel: "whatsapp", purpose: "marketing", state: o.consent, method: "staff", wording: "Yes at the counter" });
    }
    await refreshContactSummary(db, [c!.id]);
    await db.insert(contactListMember).values({ listId, customerId: c!.id });
    return c!.id;
  }
  async function draft(templateId = promoId, name = "November promo") {
    const res = await call(owner, "POST", "", { name, phone_number_id: lineId, list_id: listId, template_id: templateId });
    expect(res.status).toBe(201);
    return (res.json.data as { id: string }).id;
  }
  async function audienceOf(id: string) {
    const res = await call(owner, "GET", `/${id}/audience`);
    expect(res.status).toBe(200);
    return res.json.data as unknown as { counts: { list: number; will_send: number; skipped: Record<string, number> } };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-secret";
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token-not-real";
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.R2_ACCOUNT_ID = "itestaccount";
    process.env.R2_ACCESS_KEY_ID = "itest-access-key-id";
    process.env.R2_SECRET_ACCESS_KEY = "itest-secret-access-key";
    process.env.R2_BUCKET = "itest-bucket";
    installGraphStub();
    const own = await seedOwner(db);
    await seedUser(db, { email: "admin@example.com", role: "admin" });
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000006000", label: "Main line", channels: "whatsapp", wabaId: "WABA6", waPhoneNumberId: WA_NUMBER_ID, messagingLimit: "TIER_250" })
      .returning();
    lineId = line!.id;
    const tpls = await db
      .insert(inboxTemplate)
      .values([PROMO, PROMO_NO_STOP, UPDATE].map((t) => ({ wabaId: "WABA6", language: "en", status: "APPROVED", ...t })))
      .returning();
    promoId = tpls.find((t) => t.name === PROMO.name)!.id;
    updateId = tpls.find((t) => t.name === UPDATE.name)!.id;
    const [l] = await db.insert(contactList).values({ name: "VIPs", nameKey: "vips", kind: "static", createdBy: own.id }).returning();
    listId = l!.id;

    await person("ada", { phone: "07005556001", name: "Ada Obi", consent: "granted" });
    await person("bola", { phone: "07005556002", name: "Bola", consent: "granted" });
    await person("chi", { phone: "07005556003", name: "Chi", consent: null });
    await person("dayo", { phone: "07005556004", name: "Dayo", consent: "withdrawn" });
    await person("efe", { phone: null, name: "Efe", consent: "granted" });
    // Same number as Ada, newer record.
    await person("ada2", { phone: "+234 700 555 6001", name: "Ada again", consent: "granted", createdAt: new Date(NOW.getTime() - 1000) });

    const { buildApp } = await import("../../src/test-app.js");
    const { broadcastRouteDeps } = await import("../../src/routes/broadcasts.js");
    broadcastRouteDeps.now = () => NOW;
    broadcastRouteDeps.loadHeader = async () => new Uint8Array([0xff, 0xd8, 0xff]);
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    admin = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
  }, 180_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  it("every write route needs broadcasts.send; an admin gets 403; contacts.view can read results", async () => {
    const id = await draft();
    for (const [method, path, body] of [
      ["POST", "", { name: "x", phone_number_id: lineId, list_id: listId, template_id: promoId }],
      ["PATCH", `/${id}`, { name: "y" }],
      ["POST", `/${id}/test`, { to: "07005556999" }],
      ["POST", `/${id}/confirm`, { confirm_count: 1, when: "now" }],
      ["POST", `/${id}/resume`, { confirm_count: 1 }],
      ["POST", `/${id}/cancel`, { confirm: true }],
      ["DELETE", `/${id}`, undefined],
      ["PUT", "/settings", { ...DEFAULT_BROADCAST_SETTINGS, enabled: true, confirm_enable: true }],
      ["GET", "/options", undefined],
      ["GET", `/${id}/audience`, undefined],
    ] as const) {
      expect((await call(admin, method, path, body)).status, `${method} ${path}`).toBe(403);
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await call(manager, "GET", "")).status).toBe(200);
    expect((await call(manager, "GET", `/${id}`)).status).toBe(200);
    expect((await call(manager, "GET", `/${id}/results`)).status).toBe(200);
    expect((await call(manager, "GET", `/${id}/recipients`)).status).toBe(200);
    // Nothing was sent to anyone.
    expect(sends()).toHaveLength(0);
  });

  it("the owner switch is off by default, and confirm is refused while it is off", async () => {
    const settings = await call(owner, "GET", "/settings");
    expect((settings.json.data as { enabled: boolean }).enabled).toBe(false);
    const id = await draft();
    const test = await call(owner, "POST", `/${id}/test`, { to: "07005556999" });
    expect(test.status).toBe(200);
    const res = await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "now" });
    expect(res.status).toBe(409);
    expect(res.json.error?.message).toBe("Broadcasts are switched off. The owner can switch them on in Broadcast settings.");
    const rows = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.broadcastId, id));
    expect(rows).toHaveLength(0);
    // Only the test went to Meta: no customer.
    expect(sends().map((c) => (c.body as { to?: string }).to)).toEqual(["2347005556999"]);
  });

  it("turning the switch on needs the explicit confirmation", async () => {
    const bad = await call(owner, "PUT", "/settings", { ...DEFAULT_BROADCAST_SETTINGS, enabled: true });
    expect(bad.status).toBe(409);
    const legal = await call(owner, "PUT", "/settings", { ...DEFAULT_BROADCAST_SETTINGS, audience_rule: "consent_or_recent_customer" });
    expect(legal.status).toBe(409);
    const mm = await call(owner, "PUT", "/settings", { ...DEFAULT_BROADCAST_SETTINGS, route: "mm" });
    expect(mm.status).toBe(409);
    expect(mm.json.error?.message).toBe("Meta has not switched on its marketing route for this account yet.");
  });

  it("options: a marketing template with no STOP wording is not usable, with the reason", async () => {
    const res = await call(owner, "GET", "/options");
    const t = (res.json.data as { templates: { name: string; usable: boolean; why_not: string | null }[] }).templates;
    expect(t.find((x) => x.name === PROMO_NO_STOP.name)).toMatchObject({ usable: false });
    expect(t.find((x) => x.name === PROMO_NO_STOP.name)!.why_not).toContain("does not tell people how to stop");
    expect(t.find((x) => x.name === PROMO.name)).toMatchObject({ usable: true, why_not: null });
    expect(t.find((x) => x.name === UPDATE.name)).toMatchObject({ usable: true });
  });

  it("audience: each skip reason with counts, and a utility template skips people who stopped but not people with no marketing consent", async () => {
    const promo = await audienceOf(await draft());
    expect(promo.counts.list).toBe(6);
    expect(promo.counts.will_send).toBe(2);
    expect(promo.counts.skipped).toEqual({ no_consent: 1, opted_out: 1, no_phone: 1, duplicate_number: 1 });
    const upd = await audienceOf(await draft(updateId, "Hours"));
    expect(upd.counts.skipped.opted_out).toBe(1);
    expect(upd.counts.skipped.no_consent ?? 0).toBe(0);
  });

  it("test send goes to the tester's number as a normal template message and records the fingerprint", async () => {
    const id = await draft();
    const before = sends().length;
    const res = await call(owner, "POST", `/${id}/test`, { to: "0700 555 6998" });
    expect(res.status).toBe(200);
    const sent = sends().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ to: "2347005556998", type: "template", template: { name: PROMO.name } });
    expect(sent[0]!.body).not.toHaveProperty("biz_opaque_callback_data");
    const [b] = await db.select().from(broadcast).where(eq(broadcast.id, id));
    expect(b!.testFingerprint).toBe(b!.fingerprint);
    expect(b!.testTo).toBe("+2347005556998");
  });

  it("confirm is refused without a test, after the message changed, when the count does not match; then writes one recipient per contact with reasons", async () => {
    await setSettings({ enabled: true });
    const id = await draft();
    let res = await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "now" });
    expect(res.json.error?.message).toBe("Send a test first.");
    expect((await call(owner, "POST", `/${id}/test`, { to: "07005556999" })).status).toBe(200);
    await call(owner, "PATCH", `/${id}`, { blanks: { body: [{ from: "first_name", fallback: "friend" }] } });
    res = await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "now" });
    expect(res.json.error?.message).toBe("You changed the message after the test. Send a new test.");
    expect((await call(owner, "POST", `/${id}/test`, { to: "07005556999" })).status).toBe(200);
    res = await call(owner, "POST", `/${id}/confirm`, { confirm_count: 3, when: "now" });
    expect(res.status).toBe(409);
    expect(res.json.error?.message).toBe("The number of people changed from 3 to 2 while you were looking. Check the list again.");
    const customerSendsBefore = sends().length;
    res = await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "now" });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: "sending", recipients: 2, skipped: 4 });
    // Confirm itself sends nothing: the worker does.
    expect(sends().length).toBe(customerSendsBefore);
    const rows = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.broadcastId, id));
    expect(rows).toHaveLength(6);
    const pending = rows.filter((r) => r.state === "pending");
    expect(pending.map((r) => r.customerId).sort()).toEqual([people.ada, people.bola].sort());
    // Two contacts with the same number produce one message: the older keeps it.
    expect(rows.find((r) => r.customerId === people.ada2)).toMatchObject({ state: "skipped", skipReason: "duplicate_number" });
    expect(pending.find((r) => r.customerId === people.ada)!.values).toEqual({ body: ["Ada"] });
    const [b] = await db.select().from(broadcast).where(eq(broadcast.id, id));
    expect(b).toMatchObject({ status: "sending", confirmedCount: 2, templateName: PROMO.name, listName: "VIPs" });
    // A second confirm is refused.
    expect((await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "now" })).json.error?.message).toBe("This broadcast has already been confirmed.");

    // Another broadcast from the same line cannot start now.
    const other = await draft(updateId, "Hours 2");
    await call(owner, "POST", `/${other}/test`, { to: "07005556999" });
    const busy = await call(owner, "POST", `/${other}/confirm`, { confirm_count: 4, when: "now" });
    expect(busy.json.error?.message).toBe("Another broadcast is already going out from this number. Wait for it to finish, or schedule this one.");

    // Pause, resume with the remaining count, cancel.
    expect((await call(owner, "POST", `/${id}/pause`)).json.data).toEqual({ status: "paused" });
    expect((await call(owner, "POST", `/${id}/resume`, { confirm_count: 1 })).status).toBe(409);
    expect((await call(owner, "POST", `/${id}/resume`, { confirm_count: 2 })).json.data).toEqual({ status: "sending" });
    const cancelled = await call(owner, "POST", `/${id}/cancel`, { confirm: true });
    expect(cancelled.json.data).toEqual({ status: "cancelled", not_sent: 2 });
    const kinds = (await db.select().from(broadcastEvent).where(eq(broadcastEvent.broadcastId, id))).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["test", "confirmed", "started", "paused", "resumed", "cancelled"]));
    const after = await db.select().from(broadcastRecipient).where(and(eq(broadcastRecipient.broadcastId, id), eq(broadcastRecipient.skipReason, "cancelled")));
    expect(after).toHaveLength(2);
  });

  it("confirm fixes the audience: a contact added to the list later does not get it", async () => {
    await setSettings({ enabled: true });
    const id = await draft(promoId, "Fixed audience");
    await call(owner, "POST", `/${id}/test`, { to: "07005556999" });
    expect((await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "scheduled" })).status).toBe(409); // no time picked
    await call(owner, "PATCH", `/${id}`, { scheduled_at: new Date(NOW.getTime() + 2 * 3600_000).toISOString() });
    await call(owner, "POST", `/${id}/test`, { to: "07005556999" });
    expect((await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "scheduled" })).json.data).toMatchObject({ status: "scheduled", recipients: 2 });
    await person("late", { phone: "07005556010", consent: "granted" });
    const rows = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.broadcastId, id));
    expect(rows.some((r) => r.customerId === people.late)).toBe(false);
    await call(owner, "POST", `/${id}/cancel`, { confirm: true });
    await db.delete(contactListMember).where(eq(contactListMember.customerId, people.late!));
  });

  it("confirm is refused when the estimate is over 14 days", async () => {
    await setSettings({ enabled: true, daily_share: 0.1 });
    await db.update(inboxPhoneNumber).set({ messagingLimit: "1" }).where(eq(inboxPhoneNumber.id, lineId));
    const id = await draft(promoId, "Too slow");
    await call(owner, "POST", `/${id}/test`, { to: "07005556999" });
    const res = await call(owner, "POST", `/${id}/confirm`, { confirm_count: 2, when: "now" });
    // TIER "1" x 0.1 = 0 a day: it would never finish.
    expect(res.status).toBe(409);
    expect(res.json.error?.message).toMatch(/days at your current WhatsApp limit/);
    await db.update(inboxPhoneNumber).set({ messagingLimit: "TIER_250" }).where(eq(inboxPhoneNumber.id, lineId));
    await setSettings({ enabled: true });
  });

  it("results: counts by state, failures by plain reason, and orders within the window; an order inside two windows counts for the later one", async () => {
    const mk = async (name: string, sentAt: Date) => {
      const [b] = await db
        .insert(broadcast)
        .values({ name, status: "done", phoneNumberId: lineId, templateId: promoId, templateCategory: "MARKETING", attributionDays: 7, startedAt: sentAt })
        .returning();
      return b!.id;
    };
    const early = await mk("Early", new Date(NOW.getTime() - 5 * 86_400_000));
    const late = await mk("Late", new Date(NOW.getTime() - 3 * 86_400_000));
    await db.insert(broadcastRecipient).values([
      { broadcastId: early, customerId: people.ada, toWa: "2347005556001", state: "read", sentAt: new Date(NOW.getTime() - 5 * 86_400_000) },
      { broadcastId: early, customerId: people.bola, toWa: "2347005556002", state: "delivered", sentAt: new Date(NOW.getTime() - 5 * 86_400_000) },
      { broadcastId: early, customerId: people.chi, toWa: "2347005556003", state: "failed", errorCode: "131049", failedAt: NOW },
      { broadcastId: early, customerId: people.dayo, state: "skipped", skipReason: "opted_out" },
      { broadcastId: late, customerId: people.ada, toWa: "2347005556001", state: "sent", sentAt: new Date(NOW.getTime() - 3 * 86_400_000) },
    ]);
    // Ada orders after both messages (inside both windows): counts for "Late" only. Bola orders inside "Early"'s window.
    const o1 = await seedOnlineOrder(db, { status: "delivered" });
    await db.update(saleOrder).set({ customerId: people.ada, totalNgn: 5000, createdAtLocal: new Date(NOW.getTime() - 2 * 86_400_000) }).where(eq(saleOrder.id, o1.id));
    const o2 = await seedOnlineOrder(db, { status: "paid" });
    await db.update(saleOrder).set({ customerId: people.bola, totalNgn: 3000, createdAtLocal: new Date(NOW.getTime() - 4 * 86_400_000) }).where(eq(saleOrder.id, o2.id));
    // Cancelled orders never count.
    const o3 = await seedOnlineOrder(db, { status: "cancelled" });
    await db.update(saleOrder).set({ customerId: people.bola, createdAtLocal: new Date(NOW.getTime() - 4 * 86_400_000) }).where(eq(saleOrder.id, o3.id));

    const r1 = (await call(manager, "GET", `/${early}/results`)).json.data as unknown as {
      counts: Record<string, number>;
      failures: { code: string; plain: string; count: number }[];
      orders: { people: number; orders: number; total_ngn: number };
    };
    expect(r1.counts).toMatchObject({ list: 4, sent: 2, delivered: 2, read: 1, failed: 1, skipped: 1 });
    expect(r1.failures).toEqual([{ code: "131049", plain: "WhatsApp held it back: they have had enough promotions lately", count: 1 }]);
    expect(r1.orders).toMatchObject({ people: 1, orders: 1, total_ngn: 3000 });
    const r2 = (await call(manager, "GET", `/${late}/results`)).json.data as unknown as { orders: { people: number; orders: number; total_ngn: number } };
    expect(r2.orders).toMatchObject({ people: 1, orders: 1, total_ngn: 5000 });
  });

  it("recipients.csv needs inbox.export and is audited", async () => {
    const [b] = await db.select().from(broadcast).where(eq(broadcast.name, "Early"));
    expect((await call(manager, "GET", `/${b!.id}/recipients.csv`)).status).toBe(403);
    const res = await call(owner, "GET", `/${b!.id}/recipients.csv`);
    expect(res.status).toBe(200);
    expect(res.text.split("\r\n")[0]).toBe("Name,Phone,Result,Reason,Sent,Delivered,Read,Replied,Asked to stop");
  });

  it("merge and erase update recipient rows as section 5.6 says", async () => {
    const { eraseContactTables } = await import("../../src/lib/contacts-merge-erase.js");
    const [b] = await db.insert(broadcast).values({ name: "Erase", status: "paused", phoneNumberId: lineId }).returning();
    const [c] = await db.insert(customer).values({ name: "Gone", phone: "07005556050" }).returning();
    await db.insert(broadcastRecipient).values({ broadcastId: b!.id, customerId: c!.id, toWa: "2347005556050", state: "pending", values: { body: ["Gone"] } });
    await db.transaction(async (tx) => {
      await eraseContactTables(tx, c!.id);
    });
    const [r] = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.broadcastId, b!.id));
    expect(r).toMatchObject({ customerId: null, toWa: null, values: null, state: "skipped", skipReason: "erased" });
  });

  it("no route returns the Meta token", async () => {
    const id = await draft(promoId, "Token check");
    for (const path of ["/settings", "/options", "/health", `/${id}`, `/${id}/audience`]) {
      const res = await call(owner, "GET", path);
      expect(res.text).not.toContain("itest-token-not-real");
    }
  });
});
