import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { customer, inboxConversation, inboxMessage, inboxPhoneNumber, inboxReminder, inboxTeam, inboxUserNumberAccess } from "@ms/db";
import { touchConversation, wakeSnoozedConversations } from "@ms/domain";
import { loginAs, seedOwner, seedUser, setupTestDb } from "./helpers.js";

/**
 * Suite spec 15: snooze, reminders and the reply-time target, through the real
 * routes and migration 0087. Nothing here calls Meta.
 */
describe("suite spec 15 — tasks and reminders", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let numberId: string;
  let otherNumberId: string;
  let owner: string;
  let staff: string;
  let staffId: string;

  async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/inbox${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function newChat(phone: string, lineId = numberId) {
    const [cust] = await db.insert(customer).values({ phone, name: `Customer ${phone.slice(-3)}`, source: "whatsapp" }).returning();
    const [conv] = await db.insert(inboxConversation).values({ customerId: cust!.id, phoneNumberId: lineId, status: "open" }).returning();
    await db.insert(inboxMessage).values({ conversationId: conv!.id, direction: "in", type: "text", body: "hi", status: "received" });
    return { customerId: cust!.id, conversationId: conv!.id };
  }

  async function listIds(cookie: string, status: string): Promise<string[]> {
    const res = await call(cookie, "GET", `/conversations?status=${status}&view=all`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id);
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
    const [team] = await db.insert(inboxTeam).values({ name: "Care" }).returning();
    const [num] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000001", label: "Main", channels: "both", defaultTeamId: team!.id })
      .returning();
    const [other] = await db.insert(inboxPhoneNumber).values({ e164: "+2348000000002", label: "Other", channels: "both" }).returning();
    numberId = num!.id;
    otherNumberId = other!.id;
    const u = await seedUser(db, { email: "staff@example.com", role: "branch_staff", granted: ["inbox.view", "inbox.reply", "inbox.view_team"] });
    staffId = u.id;
    await db.insert(inboxUserNumberAccess).values({ userId: staffId, phoneNumberId: numberId });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    staff = await loginAs(baseUrl, "staff@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("a snoozed chat leaves the open list and shows under Snoozed", async () => {
    const { conversationId } = await newChat("+2347000000101");
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call(owner, "POST", `/tasks/snooze/${conversationId}`, { until })).status).toBe(200);
    expect(await listIds(owner, "open")).not.toContain(conversationId);
    expect(await listIds(owner, "snoozed")).toContain(conversationId);
  });

  it("refuses a time in the past and a closed chat", async () => {
    const { conversationId } = await newChat("+2347000000102");
    expect((await call(owner, "POST", `/tasks/snooze/${conversationId}`, { until: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    await db.update(inboxConversation).set({ status: "closed" }).where(eq(inboxConversation.id, conversationId));
    expect((await call(owner, "POST", `/tasks/snooze/${conversationId}`, { until: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
  });

  it("a customer message wakes a snoozed chat at once", async () => {
    const { conversationId } = await newChat("+2347000000103");
    await call(owner, "POST", `/tasks/snooze/${conversationId}`, { until: new Date(Date.now() + 86_400_000).toISOString() });
    await touchConversation(db, conversationId, { preview: "are you there?", inboundWa: new Date(), unreadIncrement: true });
    const [row] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
    expect(row!.snoozedUntil).toBeNull();
    expect(await listIds(owner, "open")).toContain(conversationId);
  });

  it("the wake job brings it back to the top, marked, and opening it clears the mark", async () => {
    const { conversationId } = await newChat("+2347000000104");
    await db.update(inboxConversation).set({ snoozedUntil: new Date(Date.now() - 1000) }).where(eq(inboxConversation.id, conversationId));
    const woken = await wakeSnoozedConversations(db);
    expect(woken.map((w) => w.id)).toContain(conversationId);
    const ids = await listIds(owner, "open");
    expect(ids[0]).toBe(conversationId);
    await call(owner, "POST", `/conversations/${conversationId}/read`);
    const [row] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
    expect(row!.wokeAt).toBeNull();
  });

  it("reminders: add, count when due, mark done", async () => {
    const { conversationId } = await newChat("+2347000000105");
    const add = await call(staff, "POST", "/tasks/reminders", { note: "Call back about the party", due_at: new Date(Date.now() - 60_000).toISOString(), conversation_id: conversationId });
    expect(add.status).toBe(201);
    const { data: rem } = (await add.json()) as { data: { id: string; assigneeId: string } };
    expect(rem.assigneeId).toBe(staffId);
    const count = (await (await call(staff, "GET", "/tasks/reminders/count")).json()) as { data: { due: number } };
    expect(count.data.due).toBeGreaterThanOrEqual(1);
    const due = (await (await call(staff, "GET", "/tasks/reminders?view=due")).json()) as { data: { id: string }[] };
    expect(due.data.map((r) => r.id)).toContain(rem.id);
    expect((await call(staff, "PATCH", `/tasks/reminders/${rem.id}`, { done: true })).status).toBe(200);
    const after = (await (await call(staff, "GET", "/tasks/reminders?view=due")).json()) as { data: { id: string }[] };
    expect(after.data.map((r) => r.id)).not.toContain(rem.id);
  });

  it("a reminder on a chat outside someone's scope is invisible to them (404)", async () => {
    const { conversationId } = await newChat("+2347000000106", otherNumberId);
    // Staff cannot see the chat, so cannot add a reminder on it.
    expect((await call(staff, "POST", "/tasks/reminders", { note: "x", due_at: new Date().toISOString(), conversation_id: conversationId })).status).toBe(404);
    const add = await call(owner, "POST", "/tasks/reminders", { note: "Owner's", due_at: new Date().toISOString(), conversation_id: conversationId });
    const { data: rem } = (await add.json()) as { data: { id: string } };
    expect((await call(staff, "PATCH", `/tasks/reminders/${rem.id}`, { done: true })).status).toBe(404);
    // Nor can it be given to them.
    expect(
      (await call(owner, "POST", "/tasks/reminders", { note: "For staff", due_at: new Date().toISOString(), conversation_id: conversationId, assignee_id: staffId })).status,
    ).toBe(400);
  });

  it("the reply-time target flags a waiting chat and counts it", async () => {
    expect((await call(owner, "PUT", "/settings/reply-target", { minutes: 5 })).status).toBe(200);
    const { conversationId } = await newChat("+2347000000107");
    await db.update(inboxMessage).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(inboxMessage.conversationId, conversationId));
    await db.update(inboxConversation).set({ lastInboundWaAt: new Date(Date.now() - 20 * 60_000) }).where(eq(inboxConversation.id, conversationId));
    const list = (await (await call(owner, "GET", "/conversations?status=open&view=all")).json()) as {
      data: { id: string; waiting_minutes: number | null }[];
      reply_target_minutes: number | null;
    };
    expect(list.reply_target_minutes).toBe(5);
    expect(list.data.find((r) => r.id === conversationId)?.waiting_minutes).toBeGreaterThanOrEqual(19);
    const summary = (await (await call(owner, "GET", "/tasks/reply-target")).json()) as { data: { late: number } };
    expect(summary.data.late).toBeGreaterThanOrEqual(1);
  });

  it("erasing a contact deletes their reminders", async () => {
    const { customerId } = await newChat("+2347000000108");
    await call(owner, "POST", "/tasks/reminders", { note: "Contact reminder", due_at: new Date().toISOString(), customer_id: customerId });
    expect((await call(owner, "POST", `/contacts/${customerId}/erase`, { confirm: "+2347000000108" })).status).toBe(200);
    const left = await db.select().from(inboxReminder).where(eq(inboxReminder.customerId, customerId));
    expect(left).toHaveLength(0);
  });
});
