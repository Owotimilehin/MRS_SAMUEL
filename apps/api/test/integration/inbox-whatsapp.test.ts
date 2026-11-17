import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTeam,
  inboxTeamMember,
  inboxTemplate,
  inboxUserNumberAccess,
  inboxWebhookEvent,
} from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

const APP_SECRET = "itest-meta-app-secret";
const WA_NUMBER_ID = "1098765432";

/** Intercept Graph API calls so nothing reaches Meta; record what was sent. */
const graphCalls: { url: string; body: unknown }[] = [];
function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      graphCalls.push({ url, body });
      if ((body as { status?: string } | null)?.status === "read") return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${graphCalls.length}` }] }), { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
}

function sign(raw: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}

function inboundPayload(opts: { wamid: string; from: string; text: string; name?: string; ts?: number }) {
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
              contacts: [{ profile: { name: opts.name ?? "Ada" }, wa_id: opts.from }],
              messages: [
                {
                  from: opts.from,
                  id: opts.wamid,
                  timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: opts.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("unified inbox — WhatsApp", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let numberId: string;
  let otherNumberId: string;
  let teamId: string;
  let agentId: string;

  async function postWebhook(payload: unknown, signature?: string): Promise<Response> {
    const raw = JSON.stringify(payload);
    return fetch(`${baseUrl}/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) },
      body: raw,
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
    teamId = team!.id;
    const [num] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: WA_NUMBER_ID, defaultTeamId: teamId })
      .returning();
    numberId = num!.id;
    const [other] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000001", label: "Sales", channels: "both", wabaId: "WABA1", waPhoneNumberId: "222" })
      .returning();
    otherNumberId = other!.id;

    // An "agent": branch_staff with inbox basics granted, in the team, on the main number only.
    const agent = await seedUser(db, {
      email: "agent@example.com",
      role: "branch_staff",
      granted: ["inbox.view", "inbox.reply", "inbox.notes"],
    });
    agentId = agent.id;
    await db.insert(inboxTeamMember).values({ teamId, userId: agentId });
    await db.insert(inboxUserNumberAccess).values({ userId: agentId, phoneNumberId: numberId });

    await db.insert(inboxTemplate).values({
      wabaId: "WABA1",
      name: "conversation_reopen",
      language: "en",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hi {{1}}, following up on your message." }],
    });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("answers Meta's verification handshake only with the right token", async () => {
    const ok = await fetch(`${baseUrl}/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=itest-verify&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const bad = await fetch(`${baseUrl}/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    expect(bad.status).toBe(403);
  });

  it("rejects an unsigned or wrongly signed webhook and stores nothing", async () => {
    const res = await postWebhook(inboundPayload({ wamid: "wamid.bad", from: "2347011111111", text: "x" }), "sha256=00");
    expect(res.status).toBe(401);
    expect(await db.select().from(inboxWebhookEvent)).toHaveLength(0);
  });

  it("creates customer, conversation and message from an inbound message; duplicates are ignored", async () => {
    const payload = inboundPayload({ wamid: "wamid.in.1", from: "2347011111111", text: "Do you deliver to Lekki?" });
    expect((await postWebhook(payload)).status).toBe(200);
    expect((await postWebhook(payload)).status).toBe(200); // Meta retry

    const msgs = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.in.1"));
    expect(msgs).toHaveLength(1);
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msgs[0]!.conversationId));
    expect(conv).toMatchObject({ phoneNumberId: numberId, teamId, status: "open", unreadCount: 1 });
    const [cust] = await db.select().from(customer).where(eq(customer.id, conv!.customerId));
    expect(cust).toMatchObject({ phone: "+2347011111111", name: "Ada", source: "whatsapp" });
  });

  it("matches an existing customer whose phone was typed in local format", async () => {
    const [existing] = await db.insert(customer).values({ phone: "0702 222 2222", name: "Bola", source: "online" }).returning();
    await postWebhook(inboundPayload({ wamid: "wamid.in.2", from: "2347022222222", text: "Hi", name: "B" }));
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.in.2"));
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg!.conversationId));
    expect(conv!.customerId).toBe(existing!.id);
  });

  it("lets the agent list, open and reply inside the 24h window", async () => {
    const cookie = await loginAs(baseUrl, "agent@example.com", "userpassword123");
    const list = await fetch(`${baseUrl}/v1/inbox/conversations?view=all`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as { data: { id: string; customer_phone: string }[] };
    const conv = data.find((d) => d.customer_phone === "+2347011111111");
    expect(conv).toBeTruthy();

    const reply = await fetch(`${baseUrl}/v1/inbox/conversations/${conv!.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type: "text", body: "Yes we do!" }),
    });
    expect(reply.status).toBe(201);
    const sent = graphCalls.find((g) => (g.body as { text?: { body?: string } })?.text?.body === "Yes we do!");
    expect(sent?.url).toContain(`/v23.0/${WA_NUMBER_ID}/messages`);
    expect((sent!.body as { to: string }).to).toBe("2347011111111");

    // Replying first claimed the unassigned thread.
    const [row] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv!.id));
    expect(row!.assigneeId).toBe(agentId);
    expect(row!.firstResponseAt).not.toBeNull();
  });

  it("applies delivery/read statuses forward-only", async () => {
    const [out] = await db.select().from(inboxMessage).where(eq(inboxMessage.body, "Yes we do!"));
    const statusPayload = (status: string) => ({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: WA_NUMBER_ID }, statuses: [{ id: out!.waMessageId, status, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }],
    });
    await postWebhook(statusPayload("read"));
    await postWebhook(statusPayload("delivered")); // late, must not downgrade
    const [after] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, out!.id));
    expect(after!.status).toBe("read");
  });

  it("blocks free text outside the 24h window but allows an approved template", async () => {
    const old = Math.floor(Date.now() / 1000) - 2 * 86_400;
    await postWebhook(inboundPayload({ wamid: "wamid.in.old", from: "2347033333333", text: "old", ts: old }));
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.in.old"));
    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    const url = `${baseUrl}/v1/inbox/conversations/${msg!.conversationId}/messages`;
    const text = await fetch(url, { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ type: "text", body: "hello?" }) });
    expect(text.status).toBe(409);
    const tpl = await fetch(url, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ type: "template", name: "conversation_reopen", language: "en", params: ["Ada"] }),
    });
    expect(tpl.status).toBe(201);
    const body = (await tpl.json()) as { data: { body: string } };
    expect(body.data.body).toBe("Hi Ada, following up on your message.");
  });

  it("hides other numbers' conversations from the agent (404, not 403)", async () => {
    const payload = inboundPayload({ wamid: "wamid.sales.1", from: "2347044444444", text: "sales q" });
    payload.entry[0]!.changes[0]!.value.metadata.phone_number_id = "222";
    await postWebhook(payload);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.sales.1"));
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg!.conversationId));
    expect(conv!.phoneNumberId).toBe(otherNumberId);

    const cookie = await loginAs(baseUrl, "agent@example.com", "userpassword123");
    const res = await fetch(`${baseUrl}/v1/inbox/conversations/${conv!.id}`, { headers: { cookie } });
    expect(res.status).toBe(404);
    const timeline = await fetch(`${baseUrl}/v1/inbox/conversations/${conv!.id}/timeline`, { headers: { cookie } });
    expect(timeline.status).toBe(404);
    const list = (await (await fetch(`${baseUrl}/v1/inbox/conversations?view=all`, { headers: { cookie } })).json()) as { data: { id: string }[] };
    expect(list.data.map((d) => d.id)).not.toContain(conv!.id);
  });

  it("stops an agent from assigning to others without inbox.assign", async () => {
    const cookie = await loginAs(baseUrl, "agent@example.com", "userpassword123");
    const list = (await (await fetch(`${baseUrl}/v1/inbox/conversations?view=mine`, { headers: { cookie } })).json()) as { data: { id: string }[] };
    const id = list.data[0]!.id;
    const owner = await db.select().from(inboxTeamMember);
    expect(owner.length).toBeGreaterThan(0);
    const res = await fetch(`${baseUrl}/v1/inbox/conversations/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ assignee_id: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(res.status).toBe(403);
  });

  it("parks messages for an unknown number and brings them in once the number is added", async () => {
    const payload = inboundPayload({ wamid: "wamid.unknown", from: "2347055555555", text: "?" });
    payload.entry[0]!.changes[0]!.value.metadata.phone_number_id = "999999";
    expect((await postWebhook(payload)).status).toBe(200);
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.unknown"))).toHaveLength(0);
    const parked = (await db.select().from(inboxWebhookEvent)).filter((e) => e.lastError?.startsWith("unknown_number:"));
    expect(parked).toHaveLength(1);
    expect(parked[0]!.processedAt).toBeNull();

    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    const res = await fetch(`${baseUrl}/v1/inbox/settings/numbers`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ e164: "+2348000000009", label: "Abuja", channels: "whatsapp", wa_phone_number_id: "999999" }),
    });
    expect(res.status).toBe(201);
    const [after] = await db.select().from(inboxWebhookEvent).where(eq(inboxWebhookEvent.id, parked[0]!.id));
    expect(after!.attempts).toBe(0);
    expect(after!.lastError).toBeNull(); // re-queued for the worker
  });

  it("keeps a fresh status for an unknown message id unprocessed so it is retried", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: WA_NUMBER_ID }, statuses: [{ id: "wamid.not.yet.saved", status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }],
    };
    expect((await postWebhook(payload)).status).toBe(200);
    const events = await db.select().from(inboxWebhookEvent);
    const ev = events.find((e) => JSON.stringify(e.payload).includes("wamid.not.yet.saved"));
    expect(ev!.processedAt).toBeNull();
    expect(ev!.lastError).toContain("will retry");
  });

  it("refuses an attachment the sender didn't upload", async () => {
    const cookie = await loginAs(baseUrl, "agent@example.com", "userpassword123");
    const list = (await (await fetch(`${baseUrl}/v1/inbox/conversations?view=mine`, { headers: { cookie } })).json()) as { data: { id: string }[] };
    const res = await fetch(`${baseUrl}/v1/inbox/conversations/${list.data[0]!.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        type: "image",
        media_key: "inbox/outgoing/2026/11/0b9a1c5e-1111-4222-8333-444455556666.jpg",
        mime: "image/jpeg",
        media_token: "forged-token-forged-token",
      }),
    });
    expect(res.status).toBe(403);
  });
});
