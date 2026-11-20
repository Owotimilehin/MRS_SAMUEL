import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  customer,
  inboxCall,
  inboxConversation,
  inboxPhoneNumber,
  inboxRecording,
  inboxTeam,
  inboxTeamMember,
  inboxUserNumberAccess,
} from "@ms/db";
import { loginAs, seedOwner, seedUser, setupTestDb } from "./helpers.js";

interface CallRow {
  id: string;
  conversation_id: string;
  number_id: string;
  number_label: string;
  customer_name: string | null;
  direction: "in" | "out";
  outcome: string;
  started_at: string;
  answered_by: string | null;
  started_by: string | null;
  recordings: { id: string; kind: string; playable: boolean; transcript: string | null; summary: unknown }[];
}
interface CallPage {
  data: CallRow[];
  next_before: string | null;
}

describe("GET /v1/inbox/calls — the call list", () => {
  let container: StartedPostgreSqlContainer;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerId: string;
  let agentId: string;
  let lineA: string;
  let lineB: string;
  const ids: Record<string, string> = {};

  async function list(cookie: string, query = ""): Promise<{ status: number; body: CallPage }> {
    const res = await fetch(`${baseUrl}/v1/inbox/calls${query ? `?${query}` : ""}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as CallPage };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    ownerId = (await seedOwner(db)).id;

    const [orders] = await db.insert(inboxTeam).values({ name: "Orders" }).returning();
    const [other] = await db.insert(inboxTeam).values({ name: "Deliveries" }).returning();
    const [a] = await db.insert(inboxPhoneNumber).values({ e164: "+2348100000101", label: "Main line", channels: "both" }).returning();
    const [b] = await db.insert(inboxPhoneNumber).values({ e164: "+2348100000102", label: "Night line", channels: "voice" }).returning();
    lineA = a!.id;
    lineB = b!.id;

    // The agent sees unassigned chats of the Orders team on the Main line only.
    agentId = (await seedUser(db, { email: "calls-agent@example.com", role: "branch_staff", granted: ["inbox.view", "calls.answer"] })).id;
    await db.insert(inboxTeamMember).values({ teamId: orders!.id, userId: agentId });
    await db.insert(inboxUserNumberAccess).values({ userId: agentId, phoneNumberId: lineA });
    // Someone with no inbox at all.
    await seedUser(db, { email: "no-inbox@example.com", role: "branch_staff", revoked: ["inbox.view"] });

    const [ada] = await db.insert(customer).values({ phone: "+2347011110001", name: "Ada", source: "whatsapp" }).returning();
    const [bola] = await db.insert(customer).values({ phone: "+2347011110002", name: "Bola", source: "whatsapp" }).returning();
    const [chi] = await db.insert(customer).values({ phone: "+2347011110003", name: "Chi", source: "whatsapp" }).returning();
    const [convAgent] = await db.insert(inboxConversation).values({ customerId: ada!.id, phoneNumberId: lineA, teamId: orders!.id }).returning();
    const [convOtherTeam] = await db.insert(inboxConversation).values({ customerId: bola!.id, phoneNumberId: lineA, teamId: other!.id }).returning();
    const [convOtherLine] = await db.insert(inboxConversation).values({ customerId: chi!.id, phoneNumberId: lineB, teamId: orders!.id }).returning();

    const call = (sid: string, v: Partial<typeof inboxCall.$inferInsert> & { conversationId: string; customerId: string; phoneNumberId: string }) =>
      db
        .insert(inboxCall)
        .values({ twilioCallSid: sid, direction: "in", fromE164: "+2347011110000", toE164: "+2348100000101", ...v })
        .returning()
        .then((r) => r[0]!.id);

    ids.answered = await call("CA1", {
      conversationId: convAgent!.id,
      customerId: ada!.id,
      phoneNumberId: lineA,
      outcome: "answered",
      answeredByUserId: agentId,
      durationS: 75,
      startedAt: new Date("2026-11-10T09:00:00Z"),
    });
    // 23:30 UTC on the 11th is 00:30 on the 12th in Lagos.
    ids.missed = await call("CA2", {
      conversationId: convAgent!.id,
      customerId: ada!.id,
      phoneNumberId: lineA,
      outcome: "missed",
      startedAt: new Date("2026-11-11T23:30:00Z"),
    });
    ids.outgoing = await call("CA3", {
      conversationId: convOtherTeam!.id,
      customerId: bola!.id,
      phoneNumberId: lineA,
      direction: "out",
      outcome: "answered",
      startedByUserId: ownerId,
      answeredByUserId: ownerId,
      startedAt: new Date("2026-11-13T12:00:00Z"),
    });
    ids.voicemail = await call("CA4", {
      conversationId: convOtherLine!.id,
      customerId: chi!.id,
      phoneNumberId: lineB,
      outcome: "voicemail",
      startedAt: new Date("2026-11-14T12:00:00Z"),
    });

    await db.insert(inboxRecording).values({
      callId: ids.answered,
      twilioRecordingSid: "RE1",
      kind: "call",
      status: "transcribed",
      storageKey: "inbox/recordings/re1.mp3",
      durationS: 75,
      transcript: "Hello, I want two bottles.",
      summaryJson: { summary: "Wants two bottles", call_reason: "Order", action_items: [], sentiment: "positive" },
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

  it("needs a signed-in person with the inbox", async () => {
    expect((await fetch(`${baseUrl}/v1/inbox/calls`)).status).toBe(401);
    const noInbox = await loginAs(baseUrl, "no-inbox@example.com", "userpassword123");
    expect((await list(noInbox)).status).toBe(403);
  });

  it("lists every call for the owner, newest first, with names and recordings", async () => {
    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    const { status, body } = await list(owner);
    expect(status).toBe(200);
    expect(body.data.map((c) => c.id)).toEqual([ids.voicemail, ids.outgoing, ids.missed, ids.answered]);
    expect(body.next_before).toBeNull();
    const answered = body.data.find((c) => c.id === ids.answered)!;
    expect(answered.customer_name).toBe("Ada");
    expect(answered.number_label).toBe("Main line");
    expect(answered.answered_by).toBe("calls-agent@example.com");
    expect(answered.recordings).toHaveLength(1);
    expect(answered.recordings[0]!.playable).toBe(true);
    expect(answered.recordings[0]!.transcript).toContain("two bottles");
    const outgoing = body.data.find((c) => c.id === ids.outgoing)!;
    expect(outgoing.started_by).toBe("owner@example.com");
  });

  it("filters by outcome, number, staff, direction and Lagos dates", async () => {
    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    const only = async (q: string) => (await list(owner, q)).body.data.map((c) => c.id);
    expect(await only("outcome=missed")).toEqual([ids.missed]);
    expect(await only(`number=${lineB}`)).toEqual([ids.voicemail]);
    expect(await only(`staff=${agentId}`)).toEqual([ids.answered]);
    expect(await only(`staff=${ownerId}`)).toEqual([ids.outgoing]);
    expect(await only("direction=out")).toEqual([ids.outgoing]);
    expect(await only("from=2026-11-12&to=2026-11-12")).toEqual([ids.missed]);
    expect(await only("from=2026-11-11&to=2026-11-11")).toEqual([]);
    expect(await only("from=2026-11-13")).toEqual([ids.voicemail, ids.outgoing]);
  });

  it("pages with next_before without repeating or skipping a call", async () => {
    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    const first = (await list(owner, "limit=3")).body;
    expect(first.data).toHaveLength(3);
    expect(first.next_before).not.toBeNull();
    const second = (await list(owner, `limit=3&before=${encodeURIComponent(first.next_before!)}`)).body;
    expect(second.data.map((c) => c.id)).toEqual([ids.answered]);
    expect(second.next_before).toBeNull();
  });

  it("rejects bad filters plainly", async () => {
    const owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    expect((await list(owner, "outcome=nonsense")).status).toBe(400);
    expect((await list(owner, "from=2026-11-20&to=2026-11-01")).status).toBe(400);
    expect((await list(owner, "before=garbage")).status).toBe(400);
  });

  it("shows staff only the calls of chats they may open, and hides audio and transcripts without permission", async () => {
    const agent = await loginAs(baseUrl, "calls-agent@example.com", "userpassword123");
    const { status, body } = await list(agent);
    expect(status).toBe(200);
    expect(body.data.map((c) => c.id)).toEqual([ids.missed, ids.answered]);
    const rec = body.data.find((c) => c.id === ids.answered)!.recordings[0]!;
    expect(rec.playable).toBe(false);
    expect(rec.transcript).toBeNull();
    expect(rec.summary).toBeNull();
    // A number they can't use returns nothing rather than an error.
    expect((await list(agent, `number=${lineB}`)).body.data).toEqual([]);
  });
});
