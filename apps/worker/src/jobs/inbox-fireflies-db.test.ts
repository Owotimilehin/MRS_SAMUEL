import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  customer,
  inboxCall,
  inboxConversation,
  inboxPhoneNumber,
  inboxRecording,
} from "@ms/db";
import {
  collectFirefliesResults,
  sendRecordingsToFireflies,
  type FirefliesClient,
  type FirefliesTranscript,
} from "./inbox-fireflies.js";
import type { RecordingStore } from "./inbox-recording-store.js";

/**
 * Fireflies call transcripts against a real Postgres (testcontainers). Fireflies
 * itself is a stub; nothing leaves this machine. The webhook step in between
 * (the API marking a recording ready) is done here by setting the same two
 * columns the API sets; the API side has its own test.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const NOW = new Date("2026-11-22T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const store: RecordingStore = {
  put: async () => {},
  get: async () => Buffer.alloc(0),
  delete: async () => {},
  presignGet: (key, ttl) => `https://r2.test/${key}?ttl=${ttl}`,
};

function stubClient(transcripts: Record<string, FirefliesTranscript>, failUploads = false) {
  const uploads: { url: string; title: string; clientReferenceId: string }[] = [];
  const client: FirefliesClient = {
    async uploadAudio(input) {
      if (failUploads) throw new Error("Fireflies: paid_required: Pro plan required");
      uploads.push(input);
    },
    async getTranscript(id) {
      return transcripts[id] ?? null;
    },
  };
  return { client, uploads };
}

describe("Fireflies transcripts (worker jobs)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let callId: string;
  let sid = 0;

  async function recording(
    o: {
      createdAt?: Date;
      status?: "pending" | "stored" | "summarised";
      kind?: "call" | "voicemail";
    } = {},
  ) {
    const [rec] = await db
      .insert(inboxRecording)
      .values({
        callId,
        twilioRecordingSid: `RE${++sid}`,
        kind: o.kind ?? "call",
        status: o.status ?? "stored",
        storageKey: o.status === "pending" ? null : `inbox/recordings/2026/11/r${sid}.mp3`,
        channels: 2,
        durationS: 95,
        createdAt: o.createdAt ?? hoursAgo(1),
      })
      .returning();
    return rec!;
  }

  async function row(id: string) {
    const [r] = await db.select().from(inboxRecording).where(eq(inboxRecording.id, id));
    return r!;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const url = container.getConnectionUri();
    const sql = postgres(url, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(url);

    const [c] = await db
      .insert(customer)
      .values({ name: "Test Caller", phone: "+2347005557001", source: "online" })
      .returning();
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000901", label: "Main line", channels: "voice" })
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
        twilioCallSid: "CA-ff-1",
        direction: "in",
        fromE164: "+2347005557001",
        toE164: "+2348000000901",
      })
      .returning();
    callId = call!.id;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("sends only recent stored recordings, once, tagged with the recording id", async () => {
    const recent = await recording();
    const old = await recording({ createdAt: hoursAgo(72) });
    const pending = await recording({ status: "pending" });
    const { client, uploads } = stubClient({});

    expect(await sendRecordingsToFireflies(db, logger, { client, store, now: NOW })).toBe(1);
    expect(uploads).toEqual([
      {
        url: `https://r2.test/${recent.storageKey}?ttl=86400`,
        title: "Mrs Samuel call 2026-11-22 11:00 UTC",
        clientReferenceId: recent.id,
      },
    ]);
    expect((await row(recent.id)).firefliesSentAt).toEqual(NOW);
    expect((await row(old.id)).firefliesSentAt).toBeNull();
    expect((await row(pending.id)).firefliesSentAt).toBeNull();

    // A second run sends nothing new.
    expect(await sendRecordingsToFireflies(db, logger, { client, store, now: NOW })).toBe(0);
    await db.delete(inboxRecording);
  });

  it("records a failed upload and tries again later", async () => {
    const rec = await recording();
    const { client } = stubClient({}, true);
    expect(await sendRecordingsToFireflies(db, logger, { client, store, now: NOW })).toBe(0);
    const r = await row(rec.id);
    expect(r.firefliesSentAt).toBeNull();
    expect(r.attempts).toBe(1);
    expect(r.lastError).toMatch(/paid_required/);
    await db.delete(inboxRecording);
  });

  it("does nothing while Fireflies is switched off", async () => {
    await recording();
    expect(await sendRecordingsToFireflies(db, logger, { client: null, store, now: NOW })).toBe(0);
    expect(await collectFirefliesResults(db, logger, { client: null, now: NOW })).toBe(0);
    await db.delete(inboxRecording);
  });

  it("saves the transcript first, then the summary when Fireflies has written it", async () => {
    const rec = await recording();
    const transcript: FirefliesTranscript = {
      id: "ff-9",
      sentences: [
        {
          index: 0,
          speaker_name: "Speaker 1",
          text: "Mrs Samuel's, good afternoon.",
          start_time: 0.4,
          end_time: 2,
        },
        {
          index: 1,
          speaker_name: "Speaker 2",
          text: "I want two crates of zobo.",
          start_time: 2.5,
          end_time: 4,
        },
      ],
      summary: null,
      sentiments: null,
    };
    const { client } = stubClient({ "ff-9": transcript });
    await sendRecordingsToFireflies(db, logger, { client, store, now: NOW });

    // Not ready yet: nothing to collect.
    expect(await collectFirefliesResults(db, logger, { client, now: NOW })).toBe(0);

    // meeting.transcribed arrives (the API sets these two columns).
    await db
      .update(inboxRecording)
      .set({ firefliesMeetingId: "ff-9", firefliesReadyAt: NOW })
      .where(eq(inboxRecording.id, rec.id));
    expect(await collectFirefliesResults(db, logger, { client, now: NOW })).toBe(1);
    let r = await row(rec.id);
    expect(r.status).toBe("transcribed");
    expect(r.transcript).toBe(
      "Speaker 1: Mrs Samuel's, good afternoon.\nSpeaker 2: I want two crates of zobo.",
    );
    expect(r.transcriptLines).toHaveLength(2);
    expect(r.summaryJson).toBeNull();
    expect(r.firefliesReadyAt).toBeNull();

    // meeting.summarized arrives.
    transcript.summary = {
      overview: "Customer ordered two crates of zobo.",
      gist: "Zobo order",
      action_items: "- Confirm delivery date",
    };
    transcript.sentiments = { positive_pct: 70, neutral_pct: 30, negative_pct: 0 };
    await db
      .update(inboxRecording)
      .set({ firefliesReadyAt: NOW })
      .where(eq(inboxRecording.id, rec.id));
    expect(await collectFirefliesResults(db, logger, { client, now: NOW })).toBe(1);
    r = await row(rec.id);
    expect(r.status).toBe("summarised");
    expect(r.summaryJson).toEqual({
      summary: "Customer ordered two crates of zobo.",
      call_reason: "Zobo order",
      action_items: ["Confirm delivery date"],
      sentiment: "positive",
    });

    // Done: a summarised recording is never fetched again.
    await db
      .update(inboxRecording)
      .set({ firefliesReadyAt: NOW })
      .where(eq(inboxRecording.id, rec.id));
    expect(await collectFirefliesResults(db, logger, { client, now: NOW })).toBe(0);
    await db.delete(inboxRecording);
  });

  it("records a transcript Fireflies can't find as a failure", async () => {
    const rec = await recording();
    await db
      .update(inboxRecording)
      .set({ firefliesSentAt: NOW, firefliesMeetingId: "missing", firefliesReadyAt: NOW })
      .where(eq(inboxRecording.id, rec.id));
    const { client } = stubClient({});
    expect(await collectFirefliesResults(db, logger, { client, now: NOW })).toBe(0);
    const r = await row(rec.id);
    expect(r.status).toBe("stored");
    expect(r.attempts).toBe(1);
    expect(r.lastError).toMatch(/no transcript missing/);
    await db.delete(inboxRecording);
  });
});
