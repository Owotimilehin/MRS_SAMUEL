import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  customer,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxTeam,
  inboxWebhookEvent,
} from "@ms/db";
import { findOrCreateCustomer, findOrCreateCustomerByIdentity, findOrOpenConversation } from "@ms/domain";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";

/**
 * Suite spec 01: customer identities (WhatsApp phone and BSUID, Messenger,
 * Instagram), merge and erase. Graph API calls are stubbed; nothing reaches Meta.
 */

const APP_SECRET = "itest-meta-app-secret";
const WA_NUMBER_ID = "1098765432";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Intercept Graph API calls so nothing reaches Meta; record what was sent. */
const graphCalls: { url: string; body: Record<string, unknown> | null }[] = [];
/** When set, the next Graph send answers with this Meta error. */
let nextGraphError: { status: number; error: { message: string; code: number } } | null = null;
function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      graphCalls.push({ url, body });
      if (nextGraphError) {
        const e = nextGraphError;
        nextGraphError = null;
        return new Response(JSON.stringify({ error: e.error }), { status: e.status });
      }
      if (body?.status === "read") return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${graphCalls.length}` }] }), { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
}

function sign(raw: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}

type InboundOpts = {
  wamid: string;
  from?: string;
  userId?: string;
  text?: string;
  name?: string;
  username?: string;
  ts?: number;
  /** Replace the message object entirely (system messages). */
  message?: Record<string, unknown>;
};

function inboundPayload(o: InboundOpts) {
  const contact: Record<string, unknown> = { profile: { name: o.name ?? "Ada", ...(o.username ? { username: o.username } : {}) } };
  if (o.from) contact.wa_id = o.from;
  if (o.userId) contact.user_id = o.userId;
  const message = o.message ?? {
    ...(o.from ? { from: o.from } : {}),
    ...(o.userId ? { from_user_id: o.userId } : {}),
    id: o.wamid,
    timestamp: String(o.ts ?? Math.floor(Date.now() / 1000)),
    type: "text",
    text: { body: o.text ?? "hello" },
  };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2348000000000", phone_number_id: WA_NUMBER_ID },
              contacts: [contact],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

describe("suite spec 01 — customer identities", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let numberId: string;

  async function postWebhook(payload: unknown): Promise<Response> {
    const raw = JSON.stringify(payload);
    return fetch(`${baseUrl}/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    });
  }

  async function messageByWamid(wamid: string) {
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid));
    return msg;
  }

  async function conversationOf(wamid: string) {
    const msg = await messageByWamid(wamid);
    if (!msg) return undefined;
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg.conversationId));
    return conv;
  }

  async function waIdentity(externalId: string) {
    const [row] = await db
      .select()
      .from(inboxIdentity)
      .where(
        and(
          eq(inboxIdentity.channel, "whatsapp"),
          eq(inboxIdentity.accountExternalId, "global"),
          eq(inboxIdentity.externalId, externalId),
        ),
      );
    return row;
  }

  async function ownerCookie(): Promise<string> {
    return loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }

  async function reply(cookie: string, conversationId: string, text: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/inbox/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type: "text", body: text }),
    });
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
    await seedOwner(db);

    const [team] = await db.insert(inboxTeam).values({ name: "Customer care" }).returning();
    const [num] = await db
      .insert(inboxPhoneNumber)
      .values({
        e164: "+2348000000000",
        label: "Main line",
        channels: "both",
        wabaId: "WABA1",
        waPhoneNumberId: WA_NUMBER_ID,
        defaultTeamId: team!.id,
      })
      .returning();
    numberId = num!.id;

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  // ── Migration ──────────────────────────────────────────────────────────────

  it("migration back-fill is idempotent", async () => {
    const [cust] = await db.insert(customer).values({ phone: "+2347090000001", name: "Old", source: "whatsapp" }).returning();
    const [conv] = await db
      .insert(inboxConversation)
      .values({ customerId: cust!.id, phoneNumberId: numberId, status: "closed", closedAt: new Date("2026-01-01T00:00:00Z") })
      .returning();
    await db.insert(inboxMessage).values({
      conversationId: conv!.id,
      direction: "in",
      type: "text",
      body: "from before the migration",
      waMessageId: "wamid.backfill.1",
      status: "received",
      payload: { from: "2347090000001", id: "wamid.backfill.1", type: "text" },
    });

    // The last two statements of 0071 are the two back-fills.
    const file = readFileSync(
      path.resolve(__dirname, "../../../../packages/db/migrations/0071_channel_accounts_identities.sql"),
      "utf8",
    );
    const statements = file.split("--> statement-breakpoint").map((s) => s.trim());
    const backfills = statements.slice(-2);
    expect(backfills[0]).toContain('INSERT INTO "inbox_identity"');
    expect(backfills[1]).toContain('UPDATE "inbox_conversation" c');
    for (let run = 0; run < 2; run++) {
      for (const stmt of backfills) await db.execute(sql.raw(stmt));
    }

    const idents = await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, "2347090000001"));
    expect(idents).toHaveLength(1);
    expect(idents[0]).toMatchObject({ customerId: cust!.id, channel: "whatsapp", accountExternalId: "global" });
    const [after] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv!.id));
    expect(after!.identityId).toBe(idents[0]!.id);
    expect(after!.channel).toBe("whatsapp");
  });

  // ── WhatsApp by phone ──────────────────────────────────────────────────────

  it("an inbound WhatsApp message creates the customer, the identity and a conversation with channel whatsapp and identity_id", async () => {
    expect((await postWebhook(inboundPayload({ wamid: "wamid.id.1", from: "2347090000010", name: "Chi" }))).status).toBe(200);
    const conv = await conversationOf("wamid.id.1");
    expect(conv).toBeTruthy();
    expect(conv!.channel).toBe("whatsapp");
    const ident = await waIdentity("2347090000010");
    expect(ident).toMatchObject({ customerId: conv!.customerId, displayName: "Chi" });
    expect(ident!.lastSeenAt).not.toBeNull();
    expect(conv!.identityId).toBe(ident!.id);
    const msg = await messageByWamid("wamid.id.1");
    expect(msg!.channel).toBe("whatsapp");
    const [cust] = await db.select().from(customer).where(eq(customer.id, conv!.customerId));
    expect(cust).toMatchObject({ phone: "+2347090000010", name: "Chi", source: "whatsapp" });
  });

  it("a second message from the same number re-uses the identity", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.id.2", from: "2347090000010", name: "Chi" }));
    const first = await conversationOf("wamid.id.1");
    const second = await conversationOf("wamid.id.2");
    expect(second!.id).toBe(first!.id);
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, "2347090000010"))).toHaveLength(1);
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347090000010"))).toHaveLength(1);
  });

  // ── findOrCreateCustomerByIdentity ─────────────────────────────────────────

  it("findOrCreateCustomerByIdentity creates a phone-less customer once under concurrent calls", async () => {
    const identity = { channel: "instagram" as const, accountExternalId: "17840000001", externalId: "IGSID-CONCURRENT", username: "ada_ig" };
    const [a, b] = await Promise.all([
      db.transaction((tx) => findOrCreateCustomerByIdentity(tx, identity)),
      db.transaction((tx) => findOrCreateCustomerByIdentity(tx, identity)),
    ]);
    expect(a!.customerId).toBe(b!.customerId);
    expect(a!.identityId).toBe(b!.identityId);
    expect([a!.created, b!.created].sort()).toEqual([false, true]);
    const idents = await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, "IGSID-CONCURRENT"));
    expect(idents).toHaveLength(1);
    const [cust] = await db.select().from(customer).where(eq(customer.id, a!.customerId));
    expect(cust).toMatchObject({ phone: null, name: "@ada_ig", source: "online" });
  });

  it("findOrCreateCustomerByIdentity points the identity at a new customer when the old one is soft-deleted", async () => {
    const identity = { channel: "messenger" as const, accountExternalId: "1001", externalId: "PSID-DELETED", displayName: "Funmi" };
    const first = await db.transaction((tx) => findOrCreateCustomerByIdentity(tx, identity));
    await db.update(customer).set({ deletedAt: new Date() }).where(eq(customer.id, first.customerId));
    const second = await db.transaction((tx) => findOrCreateCustomerByIdentity(tx, identity));
    expect(second.created).toBe(true);
    expect(second.customerId).not.toBe(first.customerId);
    expect(second.identityId).toBe(first.identityId);
    const [ident] = await db.select().from(inboxIdentity).where(eq(inboxIdentity.id, first.identityId));
    expect(ident!.customerId).toBe(second.customerId);
    // The deleted customer row is left exactly as it was.
    const [old] = await db.select().from(customer).where(eq(customer.id, first.customerId));
    expect(old!.deletedAt).not.toBeNull();
    await expect(
      db.transaction((tx) => findOrCreateCustomerByIdentity(tx, { channel: "messenger", accountExternalId: " ", externalId: "x" })),
    ).rejects.toThrow("identity needs an account and an id");
  });

  // ── WhatsApp by business-scoped user ID (BSUID) ────────────────────────────

  it("a WhatsApp message without from but with from_user_id is stored on a phone-less contact (R14)", async () => {
    const res = await postWebhook(
      inboundPayload({ wamid: "wamid.bsuid.1", userId: "NG.1000000000001", name: "Hidden", username: "hidden_ada", text: "no number" }),
    );
    expect(res.status).toBe(200);
    const msg = await messageByWamid("wamid.bsuid.1");
    expect(msg).toBeTruthy(); // the live defect: this used to be dropped
    expect(msg!.body).toBe("no number");
    const conv = await conversationOf("wamid.bsuid.1");
    const [cust] = await db.select().from(customer).where(eq(customer.id, conv!.customerId));
    expect(cust).toMatchObject({ phone: null, name: "Hidden", source: "whatsapp" });
    const ident = await waIdentity("NG.1000000000001");
    expect(ident).toMatchObject({ customerId: cust!.id, username: "hidden_ada", displayName: "Hidden" });
    expect(conv!.identityId).toBe(ident!.id);
    const events = await db.select().from(inboxWebhookEvent);
    const ev = events.find((e) => JSON.stringify(e.payload).includes("wamid.bsuid.1"));
    expect(ev!.processedAt).not.toBeNull();
  });

  it("a WhatsApp message with neither a phone nor a user ID is ignored and its event marked processed (R14)", async () => {
    const payload = inboundPayload({
      wamid: "wamid.nobody",
      message: { id: "wamid.nobody", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "?" } },
    });
    expect((await postWebhook(payload)).status).toBe(200);
    expect(await messageByWamid("wamid.nobody")).toBeUndefined();
    const events = await db.select().from(inboxWebhookEvent);
    const ev = events.find((e) => JSON.stringify(e.payload).includes("wamid.nobody"));
    expect(ev!.processedAt).not.toBeNull();
  });

  it("a message with phone and a known BSUID continues the BSUID contact's thread and adds the phone identity", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.cont.1", userId: "NG.2000000000002", name: "Kemi" }));
    const before = await conversationOf("wamid.cont.1");
    await postWebhook(inboundPayload({ wamid: "wamid.cont.2", from: "2347090000020", userId: "NG.2000000000002", name: "Kemi" }));
    const after = await conversationOf("wamid.cont.2");
    expect(after!.id).toBe(before!.id);
    const phoneIdent = await waIdentity("2347090000020");
    expect(phoneIdent!.customerId).toBe(before!.customerId);
    expect(after!.identityId).toBe(phoneIdent!.id); // replies now go to the number
    const [cust] = await db.select().from(customer).where(eq(customer.id, before!.customerId));
    expect(cust!.phone).toBeNull(); // the customer row is never changed by ingestion
  });

  it("conflicting phone and BSUID contacts: the phone's contact wins and nothing moves (R15)", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.clash.p", from: "2347090000030", name: "Phone side" }));
    await postWebhook(inboundPayload({ wamid: "wamid.clash.b", userId: "NG.3000000000003", name: "Hidden side" }));
    const phoneConv = await conversationOf("wamid.clash.p");
    const bsuidConv = await conversationOf("wamid.clash.b");
    expect(phoneConv!.customerId).not.toBe(bsuidConv!.customerId);

    await postWebhook(inboundPayload({ wamid: "wamid.clash.both", from: "2347090000030", userId: "NG.3000000000003", name: "Both" }));
    const bothConv = await conversationOf("wamid.clash.both");
    expect(bothConv!.id).toBe(phoneConv!.id);
    expect((await waIdentity("NG.3000000000003"))!.customerId).toBe(bsuidConv!.customerId);
    expect((await waIdentity("2347090000030"))!.customerId).toBe(phoneConv!.customerId);
  });

  it("user_changed_user_id re-keys the identity (R16)", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.rekey.1", userId: "NG.4000000000004", name: "Tolu" }));
    const conv = await conversationOf("wamid.rekey.1");
    const old = await waIdentity("NG.4000000000004");
    const system = {
      from_user_id: "NG.4000000000005",
      id: "wamid.rekey.sys",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "system",
      system: {
        type: "user_changed_user_id",
        body: "User changed from NG.4000000000004 to NG.4000000000005",
        previous_user_id: "NG.4000000000004",
        user_id: "NG.4000000000005",
      },
    };
    expect((await postWebhook(inboundPayload({ wamid: "wamid.rekey.sys", userId: "NG.4000000000005", message: system }))).status).toBe(200);
    expect(await waIdentity("NG.4000000000004")).toBeUndefined();
    const renamed = await waIdentity("NG.4000000000005");
    expect(renamed!.id).toBe(old!.id);
    expect(renamed!.customerId).toBe(conv!.customerId);
    const sysMsg = await messageByWamid("wamid.rekey.sys");
    expect(sysMsg).toMatchObject({ conversationId: conv!.id, type: "system", body: "User changed from NG.4000000000004 to NG.4000000000005" });
  });

  // ── Sending ────────────────────────────────────────────────────────────────

  it("a reply goes to the conversation's identity, not to customer.phone (R13)", async () => {
    // A contact whose record holds one number, but who writes from another (as after a merge).
    const [cust] = await db.insert(customer).values({ phone: "+2347090000040", name: "Two phones", source: "online" }).returning();
    await db.insert(inboxIdentity).values({ customerId: cust!.id, channel: "whatsapp", accountExternalId: "global", externalId: "2347090000041" });
    await postWebhook(inboundPayload({ wamid: "wamid.r13.1", from: "2347090000041", name: "Two phones" }));
    const conv = await conversationOf("wamid.r13.1");
    expect(conv!.customerId).toBe(cust!.id);

    const res = await reply(await ownerCookie(), conv!.id, "Reply to the number that wrote");
    expect(res.status).toBe(201);
    const sent = graphCalls.find((g) => (g.body?.text as { body?: string } | undefined)?.body === "Reply to the number that wrote");
    expect(sent!.body!.to).toBe("2347090000041");
    expect(sent!.body).not.toHaveProperty("recipient");
  });

  it("a reply to a BSUID-only contact sends recipient, not to", async () => {
    const conv = await conversationOf("wamid.bsuid.1");
    const res = await reply(await ownerCookie(), conv!.id, "Hello hidden customer");
    expect(res.status).toBe(201);
    const sent = graphCalls.find((g) => (g.body?.text as { body?: string } | undefined)?.body === "Hello hidden customer");
    expect(sent!.body!.recipient).toBe("NG.1000000000001");
    expect(sent!.body).not.toHaveProperty("to");
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.body, "Hello hidden customer"));
    expect(msg).toMatchObject({ status: "sent", channel: "whatsapp", direction: "out" });
  });

  it("Meta's 131062 refusal on a BSUID send is shown in plain words, with Meta's text kept", async () => {
    const conv = await conversationOf("wamid.bsuid.1");
    nextGraphError = { status: 400, error: { message: "BSUID recipient not supported", code: 131062 } };
    const res = await reply(await ownerCookie(), conv!.id, "This one is refused");
    expect(res.status).toBe(502);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.body, "This one is refused"));
    expect(msg).toMatchObject({
      status: "failed",
      errorCode: "131062",
      errorMessage: "Not sent: WhatsApp can't deliver this kind of message to a customer who has hidden their number.",
    });
    expect((msg!.payload as { meta_message?: string }).meta_message).toContain("BSUID recipient not supported");
  });

  // ── Merge ──────────────────────────────────────────────────────────────────

  async function merge(cookie: string, fromId: string, intoId: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/inbox/contacts/${fromId}/merge`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ into_customer_id: intoId }),
    });
  }

  it("after a merge the next message from the merged number lands on the kept contact (R7)", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.r7.a1", from: "2347090000050", name: "Merge A" }));
    await postWebhook(inboundPayload({ wamid: "wamid.r7.b1", from: "2347090000051", name: "Merge B" }));
    const a = (await conversationOf("wamid.r7.a1"))!.customerId;
    const b = (await conversationOf("wamid.r7.b1"))!.customerId;
    expect((await merge(await ownerCookie(), a, b)).status).toBe(200);

    await postWebhook(inboundPayload({ wamid: "wamid.r7.a2", from: "2347090000050", name: "Merge A" }));
    const after = await conversationOf("wamid.r7.a2");
    expect(after!.customerId).toBe(b); // before spec 01 this reopened contact A
    // The customer row of A is untouched and still holds the number.
    const [rowA] = await db.select().from(customer).where(eq(customer.id, a));
    expect(rowA).toMatchObject({ phone: "+2347090000050", name: "Merge A" });
    // A reply in that thread goes to the number that wrote in it (R13).
    const res = await reply(await ownerCookie(), after!.id, "Reply after merge");
    expect(res.status).toBe(201);
    const sent = graphCalls.find((g) => (g.body?.text as { body?: string } | undefined)?.body === "Reply after merge");
    expect(sent!.body!.to).toBe("2347090000050");
  });

  it("merge moves identities and reports moved_identities", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.mi.a", userId: "NG.5000000000005", name: "Hidden twin", username: "twin" }));
    await postWebhook(inboundPayload({ wamid: "wamid.mi.b", from: "2347090000052", name: "Visible twin" }));
    const a = (await conversationOf("wamid.mi.a"))!.customerId;
    const b = (await conversationOf("wamid.mi.b"))!.customerId;
    const res = await merge(await ownerCookie(), a, b);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { moved_conversations: number; moved_identities: number } };
    expect(body.data).toEqual({ moved_conversations: 1, moved_identities: 1 });
    expect((await waIdentity("NG.5000000000005"))!.customerId).toBe(b);
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, a))).toHaveLength(0);
    // Both live threads on the same line folded into one, which still knows who it is with.
    const convs = await db.select().from(inboxConversation).where(eq(inboxConversation.customerId, b));
    expect(convs).toHaveLength(1);
    expect(convs[0]!.identityId).not.toBeNull();

    const contact = await fetch(`${baseUrl}/v1/inbox/contacts/${b}`, { headers: { cookie: await ownerCookie() } });
    const detail = (await contact.json()) as { data: { identities: { channel: string; phone: string | null; username: string | null; account_label: string }[] } };
    expect(detail.data.identities).toHaveLength(2);
    expect(detail.data.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "whatsapp", phone: "+2347090000052", account_label: "WhatsApp" }),
        expect.objectContaining({ channel: "whatsapp", phone: null, username: "twin" }),
      ]),
    );
  });

  // ── Erase ──────────────────────────────────────────────────────────────────

  async function erase(cookie: string, customerId: string, confirm: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/inbox/contacts/${customerId}/erase`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
  }

  it("erase with a phone still needs the phone; erase without a phone accepts the username, then the name, then DELETE (R10)", async () => {
    const owner = await ownerCookie();

    // Phone: only the phone will do.
    await postWebhook(inboundPayload({ wamid: "wamid.r10.phone", from: "2347090000060", name: "Has Phone" }));
    const withPhone = (await conversationOf("wamid.r10.phone"))!.customerId;
    expect((await erase(owner, withPhone, "DELETE")).status).toBe(400);
    expect((await erase(owner, withPhone, "Has Phone")).status).toBe(400);
    expect((await erase(owner, withPhone, "0709 000 0060")).status).toBe(200);

    // No phone, a username: the username (any case, with or without "@"), not the name.
    await postWebhook(inboundPayload({ wamid: "wamid.r10.user", userId: "NG.6000000000006", name: "User Name", username: "erase_me" }));
    const withUsername = (await conversationOf("wamid.r10.user"))!.customerId;
    const wrong = await erase(owner, withUsername, "User Name");
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toBe("That doesn't match this customer");
    expect((await erase(owner, withUsername, " @ERASE_me ")).status).toBe(200);

    // No phone, no username, a name: the name (any case). No conversations is still a 200.
    const named = await db.transaction((tx) =>
      findOrCreateCustomerByIdentity(tx, { channel: "messenger", accountExternalId: "1001", externalId: "PSID-NAMED", displayName: "Named Person" }),
    );
    expect((await erase(owner, named.customerId, "DELETE")).status).toBe(400);
    const okNamed = await erase(owner, named.customerId, " named person ");
    expect(okNamed.status).toBe(200);
    expect(((await okNamed.json()) as { data: { identities: number; conversations: number } }).data).toMatchObject({
      identities: 1,
      conversations: 0,
    });

    // Nothing at all: exactly DELETE.
    const anon = await db.transaction((tx) =>
      findOrCreateCustomerByIdentity(tx, { channel: "messenger", accountExternalId: "1001", externalId: "PSID-ANON" }),
    );
    expect((await erase(owner, anon.customerId, "delete")).status).toBe(400);
    expect((await erase(owner, anon.customerId, "DELETE")).status).toBe(200);
  });

  it("erase deletes identities and webhook copies containing the identity id", async () => {
    await postWebhook(inboundPayload({ wamid: "wamid.erase.id", userId: "NG.7000000000007", name: "Forget", username: "forget_me" }));
    const cust = (await conversationOf("wamid.erase.id"))!.customerId;
    const before = await db.select().from(inboxWebhookEvent);
    expect(before.some((e) => JSON.stringify(e.payload).includes("NG.7000000000007"))).toBe(true);

    const res = await erase(await ownerCookie(), cust, "forget_me");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { identities: number; messages: number } }).data).toMatchObject({ identities: 1, messages: 1 });
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, cust))).toHaveLength(0);
    expect(await waIdentity("NG.7000000000007")).toBeUndefined();
    const after = await db.select().from(inboxWebhookEvent);
    expect(after.some((e) => JSON.stringify(e.payload).includes("NG.7000000000007"))).toBe(false);
    expect(await db.select().from(customer).where(eq(customer.id, cust))).toHaveLength(1); // the shop's record stays
  });

  // ── Search and other channels ──────────────────────────────────────────────

  it("conversation search finds a contact by Instagram username", async () => {
    const [ig] = await db
      .insert(inboxPhoneNumber)
      .values({
        kind: "instagram",
        e164: null,
        externalId: "17840000009",
        pageExternalId: "1009",
        externalName: "mrs_samuelfruitjuice",
        label: "Instagram",
        channels: "whatsapp",
      })
      .returning();
    const who = await db.transaction((tx) =>
      findOrCreateCustomerByIdentity(tx, {
        channel: "instagram",
        accountExternalId: "17840000009",
        externalId: "IGSID-SEARCH",
        displayName: "Bimpe",
        username: "juice_lover",
      }),
    );
    // The contact's name is "Bimpe", so only the identity can match "juice_lov".
    expect((await db.select().from(customer).where(eq(customer.id, who.customerId)))[0]!.name).toBe("Bimpe");
    const { conversation } = await db.transaction((tx) =>
      findOrOpenConversation(tx, who.customerId, ig!.id, new Date(), { identityId: who.identityId }),
    );
    expect(conversation).toMatchObject({ channel: "instagram", identityId: who.identityId });

    const owner = await ownerCookie();
    type Row = { id: string; channel: string; number_kind: string; identity_name: string | null };
    const list = async (query: string) =>
      ((await (await fetch(`${baseUrl}/v1/inbox/conversations?${query}`, { headers: { cookie: owner } })).json()) as { data: Row[] }).data;

    const found = await list("q=juice_lov");
    expect(found.map((r) => r.id)).toContain(conversation.id);
    expect(found.find((r) => r.id === conversation.id)).toMatchObject({
      channel: "instagram",
      number_kind: "instagram",
      identity_name: "Bimpe",
    });
    expect((await list(`q=${encodeURIComponent("@juice_lover")}`)).map((r) => r.id)).toContain(conversation.id);
    expect((await list("channel=instagram")).map((r) => r.id)).toEqual([conversation.id]);
    expect((await list("channel=whatsapp")).map((r) => r.id)).not.toContain(conversation.id);

    const hits = (await (await fetch(`${baseUrl}/v1/inbox/contacts/search?q=juice`, { headers: { cookie: owner } })).json()) as {
      data: { id: string; handles: string[] }[];
    };
    expect(hits.data.find((h) => h.id === who.customerId)?.handles).toEqual(["@juice_lover"]);

    const detail = (await (await fetch(`${baseUrl}/v1/inbox/conversations/${conversation.id}`, { headers: { cookie: owner } })).json()) as {
      data: { number: { kind: string; e164: string | null; external_name: string }; identity: { username: string } };
    };
    expect(detail.data.number).toMatchObject({ kind: "instagram", e164: null, external_name: "mrs_samuelfruitjuice" });
    expect(detail.data.identity.username).toBe("juice_lover");

    // A reply on Instagram is refused until spec 02 switches it on.
    const res = await reply(owner, conversation.id, "hi on instagram");
    expect(res.status).toBe(409);
  });

  it("a call never creates a WhatsApp identity (R8)", async () => {
    // A first-time caller: a customer, but no identity.
    const caller = await db.transaction((tx) => findOrCreateCustomer(tx, "+2347090000070", { source: "phone" }));
    expect(caller.created).toBe(true);
    expect(await waIdentity("2347090000070")).toBeUndefined();

    // A caller who has written on WhatsApp before: their identity's contact is used.
    await postWebhook(inboundPayload({ wamid: "wamid.r8.wa", from: "2347090000071", name: "Writes and calls" }));
    const waCustomer = (await conversationOf("wamid.r8.wa"))!.customerId;
    const again = await db.transaction((tx) => findOrCreateCustomer(tx, "+2347090000071", { source: "phone" }));
    expect(again).toEqual({ id: waCustomer, created: false });
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, "2347090000071"))).toHaveLength(1);
  });
});
