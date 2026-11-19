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
import { findOrCreateCustomerByIdentity } from "@ms/domain";
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
});
