import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { customer, inboxCall, inboxConversation, inboxPhoneNumber, inboxRecording } from "@ms/db";
import { setupTestDb, seedOwner } from "./helpers.js";

const SECRET = "itest-fireflies-signing-secret";

describe("Fireflies webhook", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let sentId: string;
  let notSentId: string;

  function sign(body: string, secret = SECRET): string {
    return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  }

  async function post(payload: unknown, signature?: string | null) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const sig = signature === undefined ? sign(body) : signature;
    if (sig !== null) headers["x-hub-signature"] = sig;
    const res = await fetch(`${baseUrl}/v1/webhooks/fireflies`, { method: "POST", headers, body });
    return res.status;
  }

  async function row(id: string) {
    const [r] = await db.select().from(inboxRecording).where(eq(inboxRecording.id, id));
    return r!;
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.FIREFLIES_WEBHOOK_SECRET = SECRET;
    await seedOwner(db);

    const [c] = await db
      .insert(customer)
      .values({ name: "Test Caller", phone: "+2347005557002", source: "online" })
      .returning();
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000902", label: "Main line", channels: "voice" })
      .returning();
    const [conv] = await db
      .insert(inboxConversation)
      .values({ customerId: c!.id, phoneNumberId: line!.id, channel: "voice" })
      .returning();
    const [call] = await db
      .insert(inboxCall)
      .values({
        conversationId: conv!.id,
        customerId: c!.id,
        phoneNumberId: line!.id,
        twilioCallSid: "CA-ff-api",
        direction: "in",
        fromE164: "+2347005557002",
        toE164: "+2348000000902",
      })
      .returning();
    const [sent] = await db
      .insert(inboxRecording)
      .values({
        callId: call!.id,
        twilioRecordingSid: "RE-ff-1",
        kind: "call",
        status: "stored",
        storageKey: "k1",
        firefliesSentAt: new Date(),
      })
      .returning();
    const [notSent] = await db
      .insert(inboxRecording)
      .values({
        callId: call!.id,
        twilioRecordingSid: "RE-ff-2",
        kind: "call",
        status: "stored",
        storageKey: "k2",
      })
      .returning();
    sentId = sent!.id;
    notSentId = notSent!.id;

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("rejects an unsigned or wrongly signed call and changes nothing", async () => {
    const payload = {
      event: "meeting.transcribed",
      meeting_id: "ff-1",
      client_reference_id: sentId,
    };
    expect(await post(payload, null)).toBe(401);
    expect(await post(payload, sign(JSON.stringify(payload), "wrong-secret"))).toBe(401);
    expect(await post(payload, "sha256=nothex")).toBe(401);
    expect((await row(sentId)).firefliesReadyAt).toBeNull();
  });

  it("marks a recording we sent as ready, with Fireflies' meeting id", async () => {
    expect(
      await post({
        event: "meeting.transcribed",
        meeting_id: "ff-1",
        client_reference_id: sentId,
        timestamp: 1,
      }),
    ).toBe(200);
    const r = await row(sentId);
    expect(r.firefliesMeetingId).toBe("ff-1");
    expect(r.firefliesReadyAt).not.toBeNull();
  });

  it("accepts the legacy payload names too", async () => {
    await db
      .update(inboxRecording)
      .set({ firefliesReadyAt: null })
      .where(eq(inboxRecording.id, sentId));
    expect(
      await post({
        eventType: "Transcription completed",
        meetingId: "ff-1",
        clientReferenceId: sentId,
      }),
    ).toBe(200);
    expect((await row(sentId)).firefliesReadyAt).not.toBeNull();
  });

  it("ignores recordings we never sent, other events and other meetings, but still answers 200", async () => {
    expect(
      await post({
        event: "meeting.transcribed",
        meeting_id: "ff-2",
        client_reference_id: notSentId,
      }),
    ).toBe(200);
    expect((await row(notSentId)).firefliesReadyAt).toBeNull();

    expect(
      await post({
        event: "meeting.bot_joined",
        meeting_id: "ff-3",
        client_reference_id: notSentId,
      }),
    ).toBe(200);
    expect(await post({ event: "meeting.transcribed", meeting_id: "ff-4" })).toBe(200);
    expect(
      await post({
        event: "meeting.transcribed",
        meeting_id: "ff-5",
        client_reference_id: "not-a-uuid",
      }),
    ).toBe(200);
  });
});
