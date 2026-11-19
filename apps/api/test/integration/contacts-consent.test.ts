import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  appSetting,
  auditLog,
  branch,
  contactAlias,
  contactConsent,
  contactImportRow,
  contactLabelMember,
  contactListMember,
  contactOrigin,
  contactSummary,
  customer,
  inboxConversation,
  inboxHoursProfile,
  inboxHoursRule,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  saleOrder,
} from "@ms/db";
import {
  applyImportBatch,
  isStoppedOnWhatsApp,
  metaConfigFromEnv,
  recordConsent,
  refreshContactSummary,
  sendAfterHoursAutoReplies,
  sendConsentConfirmations,
} from "@ms/domain";
import { CONTACT_SETTINGS_KEY, DEFAULT_CONTACT_SETTINGS, type ContactDetail, type ContactListView } from "@ms/shared";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";

/**
 * STOP and START on WhatsApp, WhatsApp's own "Offers and announcements" setting,
 * and what merging and erasing a contact do to the contact_ tables (suite spec
 * 14, Phase A). Customers' messages arrive through the real, signed webhook.
 * Meta is stubbed: nothing leaves this machine. Every time is fixed: messages
 * carry their own timestamp and the jobs are called with `now`.
 *
 * Opening hours on the "hours" line: Monday to Friday 08:00 to 18:00, Lagos time.
 */

const APP_SECRET = "itest-meta-app-secret";
const MAIN = "5550001001"; // a line with no schedule: always open
const HOURS = "5550001002"; // a line with opening hours and an out-of-hours message
const AFTER_HOURS_TEXT = "We are closed now and will reply when we open.";

// Tuesday 17 Nov 2026, 21:00 in Lagos: the shop closed at 18:00.
const NIGHT = new Date("2026-11-17T20:00:00Z");
const after = (d: Date, seconds: number): Date => new Date(d.getTime() + seconds * 1000);

const graphCalls: { url: string; body: { to?: string; type?: string; text?: { body?: string } } | null }[] = [];
let wamidSeq = 0;
let failNext: { status: number; body: unknown } | null = null;
function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      graphCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (failNext) {
        const f = failNext;
        failNext = null;
        return new Response(JSON.stringify(f.body), { status: f.status });
      }
      return new Response(JSON.stringify({ messages: [{ id: `wamid.consent.out.${++wamidSeq}` }] }), { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("contacts — consent, STOP and START, merge and erase", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let ownerId: string;
  let inSeq = 0;

  async function postWebhook(payload: unknown): Promise<void> {
    const raw = JSON.stringify(payload);
    const res = await fetch(`${baseUrl}/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex"),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
  }

  /** A customer's WhatsApp message arriving through the webhook at time `at`. Returns the stored message. */
  async function customerWrites(from: string, text: string, at: Date, line: string = MAIN, name = "Ada Test") {
    const wamid = `wamid.consent.in.${++inSeq}`;
    await postWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2347005559100", phone_number_id: line },
                contacts: [{ profile: { name }, wa_id: from }],
                messages: [{ from, id: wamid, timestamp: String(Math.floor(at.getTime() / 1000)), type: "text", text: { body: text } }],
              },
            },
          ],
        },
      ],
    });
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid));
    expect(msg).toBeTruthy();
    return msg!;
  }

  /** WhatsApp telling us the customer changed "Offers and announcements" for our business. */
  async function preferenceChanges(waId: string, value: "stop" | "resume", category = "marketing_messages"): Promise<void> {
    await postWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "user_preferences",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2347005559100", phone_number_id: MAIN },
                contacts: [{ profile: { name: "Ada Test" }, wa_id: waId }],
                user_preferences: [{ wa_id: waId, detail: "User requested to change marketing messages", category, value, timestamp: 1795000000 }],
              },
            },
          ],
        },
      ],
    });
  }

  const customerOf = async (msg: { conversationId: string }): Promise<string> =>
    (await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg.conversationId)))[0]!.customerId;
  const consentRows = (customerId: string) =>
    db.select().from(contactConsent).where(eq(contactConsent.customerId, customerId)).orderBy(contactConsent.recordedAt);
  const currentState = async (customerId: string): Promise<string | null> => {
    const rows = (await consentRows(customerId)).filter((r) => r.isCurrent && r.channel === "whatsapp" && r.purpose === "marketing");
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0] ? `${rows[0].state}:${rows[0].method}` : null;
  };
  const outbound = (conversationId: string) =>
    db
      .select()
      .from(inboxMessage)
      .where(and(eq(inboxMessage.conversationId, conversationId), eq(inboxMessage.direction, "out")))
      .orderBy(inboxMessage.createdAt);
  const confirm = (now: Date): Promise<number> => sendConsentConfirmations(db, metaConfigFromEnv(), now);
  const autoReply = (now: Date): Promise<number> => sendAfterHoursAutoReplies(db, metaConfigFromEnv(), quiet, { now });
  async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: { cookie: owner, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as { data: T };
    return { status: res.status, data: json.data };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    ownerId = (await seedOwner(db)).id;

    const [profile] = await db.insert(inboxHoursProfile).values({ name: "Shop hours" }).returning();
    await db
      .insert(inboxHoursRule)
      .values([1, 2, 3, 4, 5].map((weekday) => ({ profileId: profile!.id, weekday, openTime: "08:00", closeTime: "18:00" })));
    await db.insert(inboxPhoneNumber).values([
      { e164: "+2347005559100", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: MAIN },
      { e164: "+2347005559101", label: "Hours line", channels: "both", wabaId: "WABA1", waPhoneNumberId: HOURS, hoursProfileId: profile!.id, afterHoursText: AFTER_HOURS_TEXT },
    ]);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  beforeEach(async () => {
    graphCalls.length = 0;
    failNext = null;
    // Each test starts from the default settings and with nothing waiting to be confirmed.
    await db.delete(appSetting).where(eq(appSetting.key, CONTACT_SETTINGS_KEY));
    await db.update(contactConsent).set({ confirmState: "skipped" }).where(eq(contactConsent.confirmState, "pending"));
  });

  it('an inbound "STOP" withdraws marketing consent, keeps the message in the inbox, and queues one confirmation', async () => {
    const msg = await customerWrites("2347005553001", "STOP", NIGHT);
    const customerId = await customerOf(msg);

    const rows = await consentRows(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "whatsapp",
      purpose: "marketing",
      state: "withdrawn",
      method: "keyword",
      messageId: msg.id,
      isCurrent: true,
      confirmState: "pending",
      recordedBy: null,
    });
    // Recorded at the moment the customer wrote, not when we processed it.
    expect(rows[0]!.recordedAt.toISOString()).toBe(NIGHT.toISOString());
    expect(await isStoppedOnWhatsApp(db, customerId)).toBe(true);

    // The message is an ordinary inbox message: stored, shown, unread, and it opens the reply window.
    expect(msg).toMatchObject({ direction: "in", type: "text", body: "STOP", status: "received" });
    expect((msg.payload as { _suite?: { consent?: string } })._suite).toEqual({ consent: "stop" });
    expect((msg.payload as { text?: { body?: string } }).text?.body).toBe("STOP"); // Meta's own payload is kept
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg.conversationId));
    expect(conv).toMatchObject({ status: "open", unreadCount: 1 });
    expect(conv!.lastInboundWaAt?.toISOString()).toBe(NIGHT.toISOString());
    // Nothing was sent by the webhook itself.
    expect(graphCalls).toHaveLength(0);
    // The Contacts page shows it.
    const detail = await api<ContactDetail>("GET", `/contacts/${customerId}`);
    expect(detail.data.consent).toBe("stopped");
    expect(detail.data.consent_now).toEqual([expect.objectContaining({ state: "withdrawn", method: "keyword", recorded_by_name: null })]);
  });

  it("the confirmation is sent as free text inside the 24-hour window and never twice", async () => {
    const msg = await customerWrites("2347005553002", "Stop.", NIGHT);
    const customerId = await customerOf(msg);

    expect(await confirm(after(NIGHT, 5))).toBe(1);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.url).toContain(`/${MAIN}/messages`);
    // Ordinary free text to the person who wrote: never a template.
    expect(graphCalls[0]!.body).toMatchObject({ to: "2347005553002", type: "text", text: { body: DEFAULT_CONTACT_SETTINGS.stop_text } });
    const out = await outbound(msg.conversationId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "text", status: "sent", senderUserId: null, body: DEFAULT_CONTACT_SETTINGS.stop_text });
    expect(out[0]!.payload).toMatchObject({ auto: "opt_out" });
    expect((await consentRows(customerId))[0]!.confirmState).toBe("sent");
    // It is not a staff reply: the list still shows what the customer wrote, and nobody is assigned.
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg.conversationId));
    expect(conv).toMatchObject({ assigneeId: null, firstResponseAt: null, unreadCount: 1 });
    expect(conv!.lastPreview).not.toBe(DEFAULT_CONTACT_SETTINGS.stop_text);

    // Running the job again, and again later, sends nothing more.
    expect(await confirm(after(NIGHT, 15))).toBe(0);
    expect(await confirm(after(NIGHT, 600))).toBe(0);
    expect(graphCalls).toHaveLength(1);

    // START, then STOP again within the day: the START is confirmed (a different kind),
    // the second STOP confirmation of the day is not sent.
    await customerWrites("2347005553002", "start", after(NIGHT, 60));
    expect(await confirm(after(NIGHT, 65))).toBe(1);
    expect(graphCalls[1]!.body).toMatchObject({ type: "text", text: { body: DEFAULT_CONTACT_SETTINGS.start_text } });
    await customerWrites("2347005553002", "STOP", after(NIGHT, 120));
    expect(await currentState(customerId)).toBe("withdrawn:keyword");
    expect(await confirm(after(NIGHT, 125))).toBe(0);
    expect(graphCalls).toHaveLength(2);
    expect((await consentRows(customerId)).map((r) => `${r.state}:${r.confirmState}`)).toEqual(["withdrawn:sent", "granted:sent", "withdrawn:skipped"]);
  });

  it("a confirmation Meta refuses, or that was interrupted, is never retried", async () => {
    const refused = await customerWrites("2347005553003", "unsubscribe", NIGHT);
    failNext = { status: 400, body: { error: { message: "Rate limit hit", code: 130429 } } };
    expect(await confirm(after(NIGHT, 5))).toBe(0);
    expect((await consentRows(await customerOf(refused)))[0]!.confirmState).toBe("failed");
    expect(await confirm(after(NIGHT, 20))).toBe(0);
    expect(graphCalls).toHaveLength(1);
    // The opt-out itself is unaffected.
    expect(await currentState(await customerOf(refused))).toBe("withdrawn:keyword");

    // A row left "sending" by a run that stopped part-way may have gone out: it is never sent again.
    const interrupted = await customerWrites("2347005553004", "STOP", NIGHT);
    const interruptedCustomer = await customerOf(interrupted);
    await db.update(contactConsent).set({ confirmState: "sending" }).where(eq(contactConsent.customerId, interruptedCustomer));
    expect(await confirm(after(NIGHT, 30))).toBe(0);
    expect((await consentRows(interruptedCustomer))[0]!.confirmState).toBe("skipped");
    expect(graphCalls).toHaveLength(1);
  });

  it("no confirmation when the switch is off, and none after 10 minutes", async () => {
    // Switched off in Contact settings: the opt-out still happens, the reply does not.
    const put = await api("PUT", "/contacts/settings", { stop_confirmation: false, stop_text: "Custom stop text", start_text: "Custom start text" });
    expect(put.status).toBe(200);
    const off = await customerWrites("2347005553005", "STOP", NIGHT);
    expect(await confirm(after(NIGHT, 5))).toBe(0);
    expect(graphCalls).toHaveLength(0);
    expect(await currentState(await customerOf(off))).toBe("withdrawn:keyword");
    expect((await consentRows(await customerOf(off)))[0]!.confirmState).toBe("skipped");

    // Switched on, with the owner's own wording.
    await api("PUT", "/contacts/settings", { stop_confirmation: true, stop_text: "Custom stop text", start_text: "Custom start text" });
    const custom = await customerWrites("2347005553006", "STOP", NIGHT);
    expect(await confirm(after(NIGHT, 5))).toBe(1);
    expect(graphCalls[0]!.body).toMatchObject({ text: { body: "Custom stop text" } });
    expect(custom.body).toBe("STOP");

    // The worker was down for 11 minutes: the moment has passed, nothing is sent late.
    const late = await customerWrites("2347005553007", "STOP", NIGHT);
    expect(await confirm(after(NIGHT, 11 * 60))).toBe(0);
    expect(graphCalls).toHaveLength(1);
    expect((await consentRows(await customerOf(late)))[0]!.confirmState).toBe("skipped");
    // And with WhatsApp not configured on the server, the job does nothing at all.
    const waiting = await customerWrites("2347005553008", "STOP", NIGHT);
    expect(await sendConsentConfirmations(db, null, after(NIGHT, 5))).toBe(0);
    expect((await consentRows(await customerOf(waiting)))[0]!.confirmState).toBe("pending");
  });

  it('"START" restores consent only for someone who had stopped', async () => {
    // Never stopped: a bare START is an ordinary message, not an agreement.
    const fresh = await customerWrites("2347005553010", "START", NIGHT);
    const freshCustomer = await customerOf(fresh);
    expect(await consentRows(freshCustomer)).toHaveLength(0);
    expect((fresh.payload as { _suite?: unknown })._suite).toBeUndefined();
    expect(await confirm(after(NIGHT, 5))).toBe(0);

    // Agreed (recorded by staff), then START: nothing changes either.
    await db.transaction((tx) => recordConsent(tx, freshCustomer, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff", wording: "Yes" }));
    await customerWrites("2347005553010", "start", after(NIGHT, 30));
    expect(await currentState(freshCustomer)).toBe("granted:staff");
    expect(await consentRows(freshCustomer)).toHaveLength(1);

    // Stopped, then START: consent returns, with the message it came in and one confirmation.
    await customerWrites("2347005553010", "STOP", after(NIGHT, 60));
    expect(await currentState(freshCustomer)).toBe("withdrawn:keyword");
    expect(await confirm(after(NIGHT, 62))).toBe(1);
    const start = await customerWrites("2347005553010", " Start! ", after(NIGHT, 90));
    expect((start.payload as { _suite?: { consent?: string } })._suite).toEqual({ consent: "start" });
    expect(await currentState(freshCustomer)).toBe("granted:keyword");
    const rows = await consentRows(freshCustomer);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.isCurrent)).toMatchObject({ state: "granted", method: "keyword", wording: "Replied START on WhatsApp", messageId: start.id, confirmState: "pending" });
    expect(await confirm(after(NIGHT, 95))).toBe(1);
    expect(graphCalls.at(-1)!.body).toMatchObject({ type: "text", text: { body: DEFAULT_CONTACT_SETTINGS.start_text } });
    expect((await outbound(start.conversationId)).at(-1)!.payload).toMatchObject({ auto: "opt_in" });
    expect(await isStoppedOnWhatsApp(db, freshCustomer)).toBe(false);
  });

  it('"please stop the delivery" changes nothing', async () => {
    for (const [i, text] of ["please stop the delivery", "Cancel", "end", "quit", "STOP calling the driver", "stop?", "I want to stop my order"].entries()) {
      const msg = await customerWrites(`234700555302${i}`, text, NIGHT);
      expect(await consentRows(await customerOf(msg)), text).toHaveLength(0);
      expect((msg.payload as { _suite?: unknown })._suite, text).toBeUndefined();
    }
    expect(await confirm(after(NIGHT, 5))).toBe(0);
    expect(graphCalls).toHaveLength(0);
    // A picture with the caption STOP is not a text message: nothing changes.
    await postWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2347005559100", phone_number_id: MAIN },
                contacts: [{ profile: { name: "Pic" }, wa_id: "2347005553029" }],
                messages: [
                  { from: "2347005553029", id: "wamid.consent.pic", timestamp: String(Math.floor(NIGHT.getTime() / 1000)), type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "STOP" } },
                ],
              },
            },
          ],
        },
      ],
    });
    const [pic] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.consent.pic"));
    expect(await consentRows(await customerOf(pic!))).toHaveLength(0);
  });

  it("a second STOP changes nothing and sends nothing", async () => {
    const first = await customerWrites("2347005553030", "STOP", NIGHT);
    const customerId = await customerOf(first);
    expect(await confirm(after(NIGHT, 5))).toBe(1);
    const second = await customerWrites("2347005553030", "stop", after(NIGHT, 30));
    const rows = await consentRows(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "withdrawn", messageId: first.id, confirmState: "sent" });
    expect(await confirm(after(NIGHT, 35))).toBe(0);
    expect(graphCalls).toHaveLength(1);
    // The second message is still in the inbox, unread like any other.
    expect(second.body).toBe("stop");
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, second.conversationId));
    expect(conv!.unreadCount).toBe(2);
    // A webhook delivered twice by Meta is one message and one record.
    const dupe = { wamid: first.waMessageId };
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, dupe.wamid!))).toHaveLength(1);
  });

  it("the after-hours auto-reply is not also sent for a STOP message", async () => {
    // Closed. One customer writes STOP, another writes an ordinary question.
    const stop = await customerWrites("2347005553040", "STOP", NIGHT, HOURS);
    const question = await customerWrites("2347005553041", "Are you open?", NIGHT, HOURS);

    // The out-of-hours job answers the question and leaves the STOP alone.
    expect(await autoReply(after(NIGHT, 10))).toBe(1);
    expect((await outbound(question.conversationId)).map((m) => m.body)).toEqual([AFTER_HOURS_TEXT]);
    expect(await outbound(stop.conversationId)).toHaveLength(0);
    // The STOP gets its one confirmation, and the out-of-hours job still adds nothing later.
    expect(await confirm(after(NIGHT, 12))).toBe(1);
    expect(await autoReply(after(NIGHT, 20))).toBe(0);
    const out = await outbound(stop.conversationId);
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toMatchObject({ auto: "opt_out" });
    expect(graphCalls).toHaveLength(2);

    // If the confirmation goes first, the out-of-hours reply is still not added on top.
    const other = await customerWrites("2347005553042", "unsubscribe", NIGHT, HOURS);
    expect(await confirm(after(NIGHT, 30))).toBe(1);
    expect(await autoReply(after(NIGHT, 40))).toBe(0);
    expect(await outbound(other.conversationId)).toHaveLength(1);
  });

  it("a user_preferences stop withdraws consent; a resume lifts only a stop that came from WhatsApp", async () => {
    // Known to us by their WhatsApp identity.
    const hello = await customerWrites("2347005553050", "Hello", NIGHT);
    const customerId = await customerOf(hello);
    await preferenceChanges("2347005553050", "stop");
    expect(await currentState(customerId)).toBe("withdrawn:whatsapp_setting");
    // No confirmation is queued or sent for a change made in WhatsApp itself.
    expect((await consentRows(customerId))[0]!.confirmState).toBe("none");
    expect(await confirm(after(NIGHT, 5))).toBe(0);
    await preferenceChanges("2347005553050", "resume");
    expect(await currentState(customerId)).toBe("granted:whatsapp_setting");
    expect((await consentRows(customerId)).at(-1)!.wording).toBe("Turned promotions back on in WhatsApp");

    // A person who wrote STOP to us stays stopped until they write START or tell staff.
    await customerWrites("2347005553050", "STOP", after(NIGHT, 60));
    await preferenceChanges("2347005553050", "resume");
    expect(await currentState(customerId)).toBe("withdrawn:keyword");

    // A resume from someone who never stopped is not an agreement.
    const other = await customerWrites("2347005553051", "Hi", NIGHT);
    await preferenceChanges("2347005553051", "resume");
    expect(await consentRows(await customerOf(other))).toHaveLength(0);
    // Other categories and unknown people are ignored, and nothing breaks.
    await preferenceChanges("2347005553051", "stop", "some_other_category");
    expect(await consentRows(await customerOf(other))).toHaveLength(0);
    const before = (await db.select({ id: customer.id }).from(customer)).length;
    await preferenceChanges("2347005553999", "stop");
    expect((await db.select({ id: customer.id }).from(customer)).length).toBe(before);
    expect(graphCalls).toHaveLength(0);
  });

  it("merging contacts moves labels, lists and consent, a stop on either side wins, and the merged record leaves the list", async () => {
    const fromMsg = await customerWrites("2347005553060", "Hello from the duplicate", NIGHT, MAIN, "Duplicate Record");
    const intoMsg = await customerWrites("2347005553061", "Hello from the main one", NIGHT, MAIN, "Main Record");
    const fromId = await customerOf(fromMsg);
    const intoId = await customerOf(intoMsg);
    await refreshContactSummary(db, [fromId, intoId]);

    const label = (await api<{ id: string }>("POST", "/contacts/labels", { name: "Merge label" })).data.id;
    const shared = (await api<{ id: string }>("POST", "/contacts/labels", { name: "Shared label" })).data.id;
    await api("PUT", `/contacts/${fromId}/labels`, { label_ids: [label, shared] });
    await api("PUT", `/contacts/${intoId}/labels`, { label_ids: [shared] });
    const list = (await api<ContactListView>("POST", "/contacts/lists", { name: "Merge list", kind: "static", customer_ids: [fromId] })).data;
    const both = (await api<ContactListView>("POST", "/contacts/lists", { name: "Both list", kind: "static", customer_ids: [fromId, intoId] })).data;
    // The duplicate asked us to stop; the main record had agreed, more recently.
    await db.transaction((tx) => recordConsent(tx, fromId, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword", recordedAt: after(NIGHT, -3600) }));
    await db.transaction((tx) => recordConsent(tx, intoId, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff", wording: "Yes", recordedAt: after(NIGHT, -60) }));
    // Another channel only the duplicate has a record for.
    await db.transaction((tx) => recordConsent(tx, fromId, { channel: "email", purpose: "marketing", state: "granted", method: "staff", wording: "Email offers" }));
    await db.insert(contactOrigin).values({ customerId: fromId, origin: "manual", sourceLabel: "order book", createdBy: ownerId });
    const [b] = await db.insert(branch).values({ name: "Merge branch", code: "TMRG" }).returning();
    await db.insert(saleOrder).values({
      orderNumber: "T-MRG-1",
      branchId: b!.id,
      channel: "online",
      customerId: fromId,
      status: "paid",
      subtotalNgn: 7_000,
      totalNgn: 7_000,
      paymentMethod: "transfer",
      createdAtLocal: NIGHT,
      idempotencyKey: crypto.randomUUID(),
    });
    const [fromBefore] = await db.select().from(customer).where(eq(customer.id, fromId));
    const [intoBefore] = await db.select().from(customer).where(eq(customer.id, intoId));

    const merged = await api<Record<string, unknown>>("POST", `/inbox/contacts/${fromId}/merge`, { into_customer_id: intoId });
    expect(merged.status).toBe(200);
    expect(merged.data).toMatchObject({ moved_conversations: 1, moved_identities: 1 });

    // Labels and lists are on the kept contact; the merged record has none.
    expect((await db.select().from(contactLabelMember).where(eq(contactLabelMember.customerId, intoId))).map((m) => m.labelId).sort()).toEqual([label, shared].sort());
    expect(await db.select().from(contactLabelMember).where(eq(contactLabelMember.customerId, fromId))).toHaveLength(0);
    expect((await db.select().from(contactListMember).where(eq(contactListMember.listId, list.id))).map((m) => m.customerId)).toEqual([intoId]);
    expect((await db.select().from(contactListMember).where(eq(contactListMember.listId, both.id))).map((m) => m.customerId)).toEqual([intoId]);
    // Consent: the histories are joined and the stop wins, although the "yes" was newer. Nothing new is inserted.
    expect(await consentRows(fromId)).toHaveLength(0);
    const rows = await consentRows(intoId);
    expect(rows).toHaveLength(3);
    expect(await currentState(intoId)).toBe("withdrawn:keyword");
    expect(rows.filter((r) => r.isCurrent).map((r) => `${r.channel}:${r.state}`).sort()).toEqual(["email:granted", "whatsapp:withdrawn"]);
    expect(await isStoppedOnWhatsApp(db, intoId)).toBe(true);
    expect(await isStoppedOnWhatsApp(db, fromId)).toBe(true); // asked through the merged record: the same answer
    // Origin moved (the kept contact had none); the alias is written.
    expect((await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, intoId)))[0]).toMatchObject({ origin: "manual", sourceLabel: "order book" });
    expect(await db.select().from(contactAlias).where(eq(contactAlias.customerId, fromId))).toEqual([expect.objectContaining({ intoCustomerId: intoId, createdBy: ownerId })]);
    // The merged record leaves the Contacts page; its order counts under the kept one.
    expect(await db.select().from(contactSummary).where(eq(contactSummary.customerId, fromId))).toHaveLength(0);
    expect((await db.select().from(contactSummary).where(eq(contactSummary.customerId, intoId)))[0]).toMatchObject({ ordersCount: 1, spentNgn: 7_000 });
    expect((await api<{ merged_into: string }>("GET", `/contacts/${fromId}`)).data).toEqual({ merged_into: intoId });
    const kept = (await api<ContactDetail>("GET", `/contacts/${intoId}`)).data;
    expect(kept).toMatchObject({ consent: "stopped", orders_count: 1 });
    expect(kept.lists.map((l) => l.name).sort()).toEqual(["Both list", "Merge list"]);
    // The shop's customer rows are exactly as they were.
    expect((await db.select().from(customer).where(eq(customer.id, fromId)))[0]).toEqual(fromBefore);
    expect((await db.select().from(customer).where(eq(customer.id, intoId)))[0]).toEqual(intoBefore);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.contact_merge"), eq(auditLog.entityId, fromId)));
    expect(audit!.afterJson).toMatchObject({ into_customer_id: intoId, moved_labels: 1, moved_lists: 1, alias: true });

    // A STOP from the merged record's number now lands on, and stops, the kept contact.
    await db.transaction((tx) => recordConsent(tx, intoId, { channel: "whatsapp", purpose: "marketing", state: "granted", method: "staff", wording: "They asked again" }));
    const later = await customerWrites("2347005553060", "STOP", after(NIGHT, 300));
    expect(await customerOf(later)).toBe(intoId);
    expect(await currentState(intoId)).toBe("withdrawn:keyword");

    // A record that was merged away cannot be the one that is kept.
    const third = await customerOf(await customerWrites("2347005553062", "Hello", NIGHT));
    const refused = await fetch(`${baseUrl}/v1/inbox/contacts/${third}/merge`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ into_customer_id: fromId }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Pick the main contact, not one that was merged into another.");
    // Merging the kept contact onward re-points the earlier alias, so nothing points at a hidden record.
    const final = await customerOf(await customerWrites("2347005553063", "Hello", NIGHT));
    expect((await api("POST", `/inbox/contacts/${intoId}/merge`, { into_customer_id: final })).status).toBe(200);
    expect((await db.select().from(contactAlias).where(eq(contactAlias.customerId, fromId)))[0]!.intoCustomerId).toBe(final);
    expect(await isStoppedOnWhatsApp(db, final)).toBe(true);
    expect(await isStoppedOnWhatsApp(db, fromId)).toBe(true);
  });

  it("erasing a contact removes labels, lists, origin and import details, and keeps them marked as stopped", async () => {
    // Imported with declared consent, then labelled, listed and chatting.
    const up = await api<{ id: string; suggested_mapping: Record<string, string> }>("POST", "/contacts/imports", {
      filename: "erase.csv",
      csv_text: "Name,Phone,Email,Address,Notes\nErase Me,0700 555 3070,erase@example.test,3 Erase Road,private note",
    });
    await api("POST", `/contacts/imports/${up.data.id}/preview`, {
      mapping: up.data.suggested_mapping,
      source_label: "sign-up sheet",
      customer_source: "walkup_anonymous",
      consent_declared: "marketing_whatsapp",
      consent_method: "Paper form",
      consent_wording: "Offers on WhatsApp",
      consent_collected_on: "2026-11-01",
      fill_blanks: false,
    });
    expect((await api("POST", `/contacts/imports/${up.data.id}/apply`, { confirm: true, expect_new: 1, expect_matched: 0 })).status).toBe(202);
    expect(await applyImportBatch(db, up.data.id, 200)).toEqual({ done: true, applied: 1 });
    const [cust] = await db.select().from(customer).where(eq(customer.phone, "+2347005553070"));
    const id = cust!.id;
    await customerWrites("2347005553070", "Hello, it is me", NIGHT, MAIN, "Erase Me");
    const label = (await api<{ id: string }>("POST", "/contacts/labels", { name: "Erase label" })).data.id;
    await api("PUT", `/contacts/${id}/labels`, { label_ids: [label] });
    const list = (await api<ContactListView>("POST", "/contacts/lists", { name: "Erase list", kind: "static", customer_ids: [id] })).data;
    await api("POST", `/contacts/${id}/consent`, { channel: "email", purpose: "marketing", state: "granted", wording: "Email offers", note: "a private note" });
    expect(await currentState(id)).toBe("granted:import");
    const [custBefore] = await db.select().from(customer).where(eq(customer.id, id));

    const erased = await api<Record<string, unknown>>("POST", `/inbox/contacts/${id}/erase`, { confirm: "0700 555 3070" });
    expect(erased.status).toBe(200);
    expect(erased.data).toMatchObject({ conversations: 1, messages: 1, identities: 1, contact_labels: 1, contact_lists: 1, consent_kept_as_stopped: true });

    expect(await db.select().from(contactLabelMember).where(eq(contactLabelMember.customerId, id))).toHaveLength(0);
    expect(await db.select().from(contactListMember).where(eq(contactListMember.listId, list.id))).toHaveLength(0);
    expect(await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, id))).toHaveLength(0);
    const [row] = await db.select().from(contactImportRow).where(eq(contactImportRow.importId, up.data.id));
    expect(row).toMatchObject({ raw: {}, name: null, phoneE164: null, email: null, address: null, notes: null, filled: null, customerId: id });
    // Consent: only the fact that they must never get a promotion is kept, with no wording or note.
    const rows = await consentRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "erase_request", isCurrent: true, wording: null, note: null, confirmState: "none" });
    expect(await isStoppedOnWhatsApp(db, id)).toBe(true);
    // The customer row is the shop's own record: untouched. They remain a contact, marked stopped.
    expect((await db.select().from(customer).where(eq(customer.id, id)))[0]).toEqual(custBefore);
    const detail = (await api<ContactDetail>("GET", `/contacts/${id}`)).data;
    expect(detail).toMatchObject({ name: "Erase Me", consent: "stopped", labels: [], lists: [], origin: null, channels: [], conversations: [] });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.contact_erase"), eq(auditLog.entityId, id)));
    expect(audit!.afterJson).toMatchObject({ contact_labels: 1, contact_lists: 1, consent_kept_as_stopped: true, customer_row_kept: true });

    // The stop survives a re-import that declares everyone agreed.
    const again = await api<{ id: string; suggested_mapping: Record<string, string> }>("POST", "/contacts/imports", {
      filename: "erase-again.csv",
      csv_text: "Name,Phone\nErase Me,07005553070",
    });
    await api("POST", `/contacts/imports/${again.data.id}/preview`, {
      mapping: again.data.suggested_mapping,
      source_label: "sign-up sheet",
      customer_source: "walkup_anonymous",
      consent_declared: "marketing_whatsapp",
      consent_method: "Paper form",
      consent_wording: "Offers on WhatsApp",
      consent_collected_on: "2026-11-15",
      fill_blanks: true,
    });
    await api("POST", `/contacts/imports/${again.data.id}/apply`, { confirm: true, expect_new: 0, expect_matched: 1 });
    await applyImportBatch(db, again.data.id, 200);
    expect(await currentState(id)).toBe("withdrawn:erase_request");
    // And it survives being erased a second time, and a person who was already stopped keeps their own record.
    expect((await api("POST", `/inbox/contacts/${id}/erase`, { confirm: "07005553070" })).status).toBe(200);
    expect(await currentState(id)).toBe("withdrawn:erase_request");
    const stopped = await customerOf(await customerWrites("2347005553071", "STOP", NIGHT));
    expect((await api("POST", `/inbox/contacts/${stopped}/erase`, { confirm: "07005553071" })).status).toBe(200);
    expect(await currentState(stopped)).toBe("withdrawn:keyword");
    expect(await consentRows(stopped)).toHaveLength(1);
  });

  it("ingest still never modifies an existing customer row", async () => {
    // A shop customer with their own details, known before they ever write on WhatsApp.
    const [shop] = await db
      .insert(customer)
      .values({ name: "Shop Name", phone: "0700 555 3080", email: "shop@example.test", defaultAddress: "1 Shop Road", notes: "shop notes", source: "online" })
      .returning();
    const [before] = await db.select().from(customer).where(eq(customer.id, shop!.id));
    const snapshot = async () => (await db.select().from(customer).where(eq(customer.id, shop!.id)))[0];

    const stop = await customerWrites("2347005553080", "STOP", NIGHT, MAIN, "A Different WhatsApp Name");
    expect(await customerOf(stop)).toBe(shop!.id);
    expect(await snapshot()).toEqual(before);
    expect(await confirm(after(NIGHT, 5))).toBe(1);
    expect(await snapshot()).toEqual(before);
    await customerWrites("2347005553080", "START", after(NIGHT, 30), MAIN, "A Different WhatsApp Name");
    expect(await currentState(shop!.id)).toBe("granted:keyword");
    expect(await snapshot()).toEqual(before);
    await customerWrites("2347005553080", "Do you deliver to Lekki?", after(NIGHT, 60), MAIN, "A Different WhatsApp Name");
    await preferenceChanges("2347005553080", "stop");
    expect(await currentState(shop!.id)).toBe("withdrawn:whatsapp_setting");
    expect(await snapshot()).toEqual(before);
    // The WhatsApp name went onto the identity, where it belongs.
    const [ident] = await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, shop!.id));
    expect(ident).toMatchObject({ channel: "whatsapp", displayName: "A Different WhatsApp Name" });
  });
});
