import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  inboxConversation,
  inboxHoliday,
  inboxHoursProfile,
  inboxHoursRule,
  inboxMessage,
  inboxPhoneNumber,
} from "@ms/db";
import { metaConfigFromEnv, sendAfterHoursAutoReplies } from "@ms/domain";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";

/**
 * The after-hours WhatsApp auto-reply, with a fixed clock. The job is the one
 * the inbox worker runs every few seconds; here it is called directly with
 * `now`, and the customer's messages arrive through the real webhook.
 *
 * Opening hours in these tests: Monday–Friday 08:00–18:00, Lagos time (UTC+1).
 */

const APP_SECRET = "itest-meta-app-secret";
const AFTER_HOURS_TEXT = "Thanks for reaching out! We're closed now and will reply when we open.";

// Tuesday 17 Nov 2026.
const TUE_OPEN = new Date("2026-11-17T10:00:00Z"); // 11:00 Lagos, open
const TUE_NIGHT = new Date("2026-11-17T20:00:00Z"); // 21:00 Lagos, closed since 18:00
const WED_EARLY = new Date("2026-11-18T05:00:00Z"); // 06:00 Lagos, still the same closed period
const WED_NIGHT = new Date("2026-11-18T20:00:00Z"); // 21:00 Lagos, a new closed period
const THU_HOLIDAY = new Date("2026-11-19T10:00:00Z"); // 11:00 Lagos on a holiday

const NUMBERS = { main: "7770000001", noSchedule: "7770000002", noText: "7770000003", callsOnly: "7770000004" } as const;

const graphCalls: { url: string; body: unknown }[] = [];
let wamidSeq = 0;
/** When set, the next send is answered with this error instead of a message id. */
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
      return new Response(JSON.stringify({ messages: [{ id: `wamid.auto.out.${++wamidSeq}` }] }), { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("unified inbox — after-hours WhatsApp auto-reply", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerId: string;
  let inSeq = 0;

  /** A customer's WhatsApp message arriving through the webhook at time `at`. */
  async function customerWrites(from: string, at: Date, waNumberId: string = NUMBERS.main, text = "Are you open?"): Promise<string> {
    const wamid = `wamid.auto.in.${++inSeq}`;
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2348000000200", phone_number_id: waNumberId },
                contacts: [{ profile: { name: "Ada" }, wa_id: from }],
                messages: [{ from, id: wamid, timestamp: String(Math.floor(at.getTime() / 1000)), type: "text", text: { body: text } }],
              },
            },
          ],
        },
      ],
    });
    const res = await fetch(`${baseUrl}/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex"),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid));
    expect(msg).toBeTruthy();
    return msg!.conversationId;
  }

  const runJob = (now: Date): Promise<number> => sendAfterHoursAutoReplies(db, metaConfigFromEnv(), quiet, { now });
  const minutesAfter = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);

  async function outbound(conversationId: string) {
    return db
      .select()
      .from(inboxMessage)
      .where(and(eq(inboxMessage.conversationId, conversationId), eq(inboxMessage.direction, "out")))
      .orderBy(inboxMessage.createdAt);
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
    await db.insert(inboxHoliday).values({ profileId: null, date: "2026-11-19", label: "Stock-take day" });

    await db.insert(inboxPhoneNumber).values([
      { e164: "+2348000000201", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: NUMBERS.main, hoursProfileId: profile!.id, afterHoursText: AFTER_HOURS_TEXT },
      { e164: "+2348000000202", label: "Always open", channels: "whatsapp", wabaId: "WABA1", waPhoneNumberId: NUMBERS.noSchedule, hoursProfileId: null, afterHoursText: AFTER_HOURS_TEXT },
      { e164: "+2348000000203", label: "No message", channels: "whatsapp", wabaId: "WABA1", waPhoneNumberId: NUMBERS.noText, hoursProfileId: profile!.id, afterHoursText: "  " },
      { e164: "+2348000000204", label: "Calls only", channels: "voice", wabaId: "WABA1", waPhoneNumberId: NUMBERS.callsOnly, hoursProfileId: profile!.id, afterHoursText: AFTER_HOURS_TEXT },
    ]);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  beforeEach(() => {
    graphCalls.length = 0;
    failNext = null;
  });

  it("closed + message set: exactly one auto-reply, as an ordinary text from the business number", async () => {
    const from = "2347020000001";
    const conv = await customerWrites(from, minutesAfter(TUE_NIGHT, -1));
    expect(await runJob(TUE_NIGHT)).toBe(1);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${NUMBERS.main}/messages`);
    expect(graphCalls[0]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: from,
      type: "text",
      text: { body: AFTER_HOURS_TEXT, preview_url: true },
    });

    const out = await outbound(conv);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "text", body: AFTER_HOURS_TEXT, status: "sent", senderUserId: null, payload: { auto: "after_hours" } });

    // Running again (next tick, or a second worker) sends nothing more.
    expect(await runJob(minutesAfter(TUE_NIGHT, 0.2))).toBe(0);
    expect(graphCalls).toHaveLength(1);
  });

  it("it is not a staff reply: no first-response time, nobody assigned, preview still the customer's words", async () => {
    // A Tuesday night in the future: the list preview only moves forward in
    // time, so this has to be later than the moment the test itself runs.
    const night = new Date("2027-11-16T20:00:00Z");
    const conv = await customerWrites("2347020000002", minutesAfter(night, -1), NUMBERS.main, "Do you deliver to Lekki?");
    expect(await runJob(night)).toBe(1);
    const [row] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv));
    expect(row).toMatchObject({ firstResponseAt: null, assigneeId: null, unreadCount: 1, lastPreview: "Do you deliver to Lekki?" });

    // The timeline marks it as automatic, with no sender.
    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    const timeline = (await (await fetch(`${baseUrl}/v1/inbox/conversations/${conv}/timeline`, { headers: { cookie: owner } })).json()) as {
      data: { data: { direction: string; auto: string | null; sender_name: string | null } }[];
    };
    expect(timeline.data.map((d) => [d.data.direction, d.data.auto, d.data.sender_name])).toEqual([
      ["in", null, null],
      ["out", "after_hours", null],
    ]);
  });

  it("once per closed period: later messages that night and before opening get nothing; the next night gets one", async () => {
    const from = "2347020000003";
    const conv = await customerWrites(from, minutesAfter(TUE_NIGHT, -1));
    expect(await runJob(TUE_NIGHT)).toBe(1);

    await customerWrites(from, minutesAfter(TUE_NIGHT, 2), NUMBERS.main, "Hello??");
    expect(await runJob(minutesAfter(TUE_NIGHT, 3))).toBe(0);

    // 06:00 next morning: still closed since 18:00 yesterday.
    await customerWrites(from, minutesAfter(WED_EARLY, -1), NUMBERS.main, "Morning");
    expect(await runJob(WED_EARLY)).toBe(0);
    expect(await outbound(conv)).toHaveLength(1);

    // The shop was open all Wednesday; that night is a new closed period (and more than 12 hours on).
    await customerWrites(from, minutesAfter(WED_NIGHT, -1), NUMBERS.main, "Still there?");
    expect(await runJob(WED_NIGHT)).toBe(1);
    expect(await outbound(conv)).toHaveLength(2);
  });

  it("never more than once in 12 hours, even when the shop opened in between", async () => {
    const from = "2347020000004";
    // 07:30 Lagos Tuesday, before opening → one auto-reply.
    const early = new Date("2026-11-17T06:30:00Z");
    const conv = await customerWrites(from, minutesAfter(early, -1));
    expect(await runJob(early)).toBe(1);
    // 18:05 Lagos the same day: open in between, but only 10½ hours later.
    const evening = new Date("2026-11-17T17:05:00Z");
    await customerWrites(from, minutesAfter(evening, -1));
    expect(await runJob(evening)).toBe(0);
    expect(await outbound(conv)).toHaveLength(1);
  });

  it("open: no auto-reply", async () => {
    const conv = await customerWrites("2347020000005", minutesAfter(TUE_OPEN, -1));
    expect(await runJob(TUE_OPEN)).toBe(0);
    expect(await outbound(conv)).toHaveLength(0);
  });

  it("a number with no opening hours is always open: no auto-reply", async () => {
    const conv = await customerWrites("2347020000006", minutesAfter(TUE_NIGHT, -1), NUMBERS.noSchedule);
    expect(await runJob(TUE_NIGHT)).toBe(0);
    expect(await outbound(conv)).toHaveLength(0);
  });

  it("no after-hours message set: no auto-reply", async () => {
    const conv = await customerWrites("2347020000007", minutesAfter(TUE_NIGHT, -1), NUMBERS.noText);
    expect(await runJob(TUE_NIGHT)).toBe(0);
    expect(await outbound(conv)).toHaveLength(0);
  });

  it("a calls-only number never sends one", async () => {
    const conv = await customerWrites("2347020000008", minutesAfter(TUE_NIGHT, -1), NUMBERS.callsOnly);
    expect(await runJob(TUE_NIGHT)).toBe(0);
    expect(await outbound(conv)).toHaveLength(0);
  });

  it("staff replied since closing: no auto-reply; a staff reply from before closing doesn't count", async () => {
    // Staff answered at 19:30 Lagos, after closing at 18:00.
    const a = await customerWrites("2347020000009", minutesAfter(TUE_NIGHT, -1));
    await db.insert(inboxMessage).values({
      conversationId: a,
      direction: "out",
      type: "text",
      body: "We're closed but I saw this — yes we do.",
      status: "sent",
      senderUserId: ownerId,
      createdAt: new Date("2026-11-17T18:30:00Z"),
    });
    // Staff answered at 16:00 Lagos, while still open.
    const b = await customerWrites("2347020000010", minutesAfter(TUE_NIGHT, -1));
    await db.insert(inboxMessage).values({
      conversationId: b,
      direction: "out",
      type: "text",
      body: "Earlier answer",
      status: "sent",
      senderUserId: ownerId,
      createdAt: new Date("2026-11-17T15:00:00Z"),
    });

    expect(await runJob(TUE_NIGHT)).toBe(1);
    expect((await outbound(a)).filter((m) => m.senderUserId === null)).toHaveLength(0);
    expect((await outbound(b)).filter((m) => m.senderUserId === null)).toHaveLength(1);
  });

  it("a holiday counts as closed, even in the middle of a working day", async () => {
    const conv = await customerWrites("2347020000011", minutesAfter(THU_HOLIDAY, -1));
    expect(await runJob(THU_HOLIDAY)).toBe(1);
    expect((await outbound(conv))[0]).toMatchObject({ body: AFTER_HOURS_TEXT, payload: { auto: "after_hours" } });
  });

  it("only recent messages: nothing older than 10 minutes is answered (no backlog after downtime)", async () => {
    const conv = await customerWrites("2347020000012", minutesAfter(TUE_NIGHT, -11));
    expect(await runJob(TUE_NIGHT)).toBe(0);
    expect(await outbound(conv)).toHaveLength(0);
  });

  it("WhatsApp not configured: nothing is sent or saved", async () => {
    const conv = await customerWrites("2347020000013", minutesAfter(TUE_NIGHT, -1));
    expect(await sendAfterHoursAutoReplies(db, null, quiet, { now: TUE_NIGHT })).toBe(0);
    expect(await outbound(conv)).toHaveLength(0);
    expect(graphCalls).toHaveLength(0);
    // (Left unanswered on purpose; the 10-minute rule keeps later tests from picking it up at other times.)
  });

  it("Meta refuses the send: saved as failed, not sent again, and incoming messages keep working", async () => {
    const from = "2347020000014";
    const at = new Date("2026-11-16T20:00:00Z"); // Monday night, a time no other test uses
    const conv = await customerWrites(from, minutesAfter(at, -1));
    failNext = { status: 400, body: { error: { message: "(#131026) Message undeliverable", code: 131026 } } };
    expect(await runJob(at)).toBe(0);
    const out = await outbound(conv);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "failed", errorCode: "131026", senderUserId: null });
    expect(out[0]!.payload).toMatchObject({ auto: "after_hours", retryable: false });

    // The webhook still takes the customer's next message, and the refused reply is not retried.
    await customerWrites(from, minutesAfter(at, 1), NUMBERS.main, "Hello?");
    expect(await runJob(minutesAfter(at, 2))).toBe(0);
    expect(await outbound(conv)).toHaveLength(1);
    const [row] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv));
    expect(row).toMatchObject({ firstResponseAt: null, assigneeId: null, unreadCount: 2 });
  });

  it("no answer from Meta (it may have been delivered): never sent again", async () => {
    const at = new Date("2026-11-13T20:00:00Z"); // Friday night
    const conv = await customerWrites("2347020000015", minutesAfter(at, -1));
    failNext = { status: 502, body: "bad gateway" };
    expect(await runJob(at)).toBe(0);
    expect((await outbound(conv))[0]!.payload).toMatchObject({ auto: "after_hours", unconfirmed: true });
    expect(await runJob(minutesAfter(at, 1))).toBe(0);
    expect(await outbound(conv)).toHaveLength(1);
  });

  it("Meta says 'too busy, try again': tried again on the next run, then stops once sent", async () => {
    const at = new Date("2026-11-12T20:00:00Z"); // Thursday night
    const conv = await customerWrites("2347020000016", minutesAfter(at, -1));
    failNext = { status: 429, body: { error: { message: "Rate limit hit", code: 130429 } } };
    expect(await runJob(at)).toBe(0);
    expect(await runJob(minutesAfter(at, 0.2))).toBe(1);
    expect(await runJob(minutesAfter(at, 0.4))).toBe(0);
    const out = await outbound(conv);
    expect(out.map((m) => m.status)).toEqual(["failed", "sent"]);
  });
});
