import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDbClient, customer, inboxConversation, inboxMessage, inboxPhoneNumber } from "@ms/db";
import { downloadPendingMedia, MAX_LINKED_MEDIA_BYTES } from "./inbox-whatsapp.js";
import type { RecordingStore } from "./inbox-recording-store.js";

/**
 * Suite spec 02 worker jobs, against a real Postgres (testcontainers). Every
 * outside call is stubbed: Meta's file links (cdn.example.test) and the Graph API.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const PAGE_ID = "100200300400";
const log = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory storage standing in for R2. */
class MemoryStore implements RecordingStore {
  files = new Map<string, { bytes: Buffer; type: string }>();
  deleted: string[] = [];
  async put(key: string, bytes: Buffer, contentType: string) {
    this.files.set(key, { bytes, type: contentType });
  }
  async get(key: string) {
    return this.files.get(key)!.bytes;
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.files.delete(key);
  }
}

type CdnAnswer = { status: number; body?: Buffer; type?: string; length?: number };
const cdn = new Map<string, CdnAnswer>();
const cdnCalls: { url: string; auth: string | null }[] = [];

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://cdn.example.test/")) {
      cdnCalls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
      const a = cdn.get(url) ?? { status: 404 };
      const headers: Record<string, string> = {};
      if (a.type) headers["content-type"] = a.type;
      if (a.length !== undefined) headers["content-length"] = String(a.length);
      return new Response(a.body ?? null, { status: a.status, headers });
    }
    throw new Error(`unexpected network call in test: ${url}`);
  }) as typeof fetch;
}

describe("spec 02 worker: media by link", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let conversationId: string;
  let store: MemoryStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    delete process.env.META_SYSTEM_USER_TOKEN; // the WhatsApp pass needs Meta; this file tests the link pass only
    installStub();

    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ kind: "messenger", e164: null, externalId: PAGE_ID, pageExternalId: PAGE_ID, label: "Facebook Page", channels: "whatsapp" })
      .returning();
    const [cust] = await db.insert(customer).values({ name: "Ada", phone: null, source: "online" }).returning();
    const [conv] = await db
      .insert(inboxConversation)
      .values({ customerId: cust!.id, phoneNumberId: line!.id, channel: "messenger", status: "open" })
      .returning();
    conversationId = conv!.id;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    store = new MemoryStore();
    cdn.clear();
    cdnCalls.length = 0;
  });

  async function inbound(mid: string, mediaUrl: string | null, type = "image", extra: Partial<typeof inboxMessage.$inferInsert> = {}) {
    const [m] = await db
      .insert(inboxMessage)
      .values({ conversationId, direction: "in", type, body: null, mediaUrl, channel: "messenger", waMessageId: mid, status: "received", ...extra })
      .returning();
    return m!;
  }
  const reload = async (id: string) => (await db.select().from(inboxMessage).where(eq(inboxMessage.id, id)))[0]!;

  it("downloadPendingMedia stores a media_url file and clears the link", async () => {
    const url = "https://cdn.example.test/img1.jpg";
    cdn.set(url, { status: 200, body: Buffer.from("jpeg-bytes"), type: "image/jpeg; charset=binary" });
    const m = await inbound("m_media_1", url);
    expect(await downloadPendingMedia(db, log, store)).toBe(1);
    const after = await reload(m.id);
    expect(after.mediaUrl).toBeNull();
    expect(after.mediaMime).toBe("image/jpeg");
    expect(after.mediaKey).toMatch(new RegExp(`^inbox/media/\\d{4}/\\d{2}/${m.id}\\.jpg$`));
    expect(store.files.get(after.mediaKey!)?.bytes.toString()).toBe("jpeg-bytes");
    expect(cdnCalls[0]!.auth).toBeNull(); // never our token on a CDN link
  });

  it("a 404 link is given up as expired", async () => {
    const m = await inbound("m_media_404", "https://cdn.example.test/gone.jpg");
    await downloadPendingMedia(db, log, store);
    const after = await reload(m.id);
    expect(after).toMatchObject({ mediaUrl: null, mediaKey: null, mediaAttempts: 5, errorMessage: "media download: the link expired" });
  });

  it("an oversized file is refused", async () => {
    const url = "https://cdn.example.test/huge.mp4";
    cdn.set(url, { status: 200, body: Buffer.from("x"), type: "video/mp4", length: MAX_LINKED_MEDIA_BYTES + 1 });
    const m = await inbound("m_media_big", url, "video");
    await downloadPendingMedia(db, log, store);
    const after = await reload(m.id);
    expect(after).toMatchObject({ mediaKey: null, mediaAttempts: 5, errorMessage: "media download: too large" });
    expect(store.files.size).toBe(0);
  });

  it("never downloads a story mention or a deleted message", async () => {
    const url = "https://cdn.example.test/story.jpg";
    cdn.set(url, { status: 200, body: Buffer.from("story"), type: "image/jpeg" });
    await inbound("m_story", url, "story_mention");
    await inbound("m_deleted", url, "image", { deletedAt: new Date() });
    await downloadPendingMedia(db, log, store);
    expect(cdnCalls).toHaveLength(0);
    expect(store.files.size).toBe(0);
  });

  it("purge deletes the stored file", async () => {
    await store.put("inbox/media/2026/11/old.jpg", Buffer.from("x"), "image/jpeg");
    const m = await inbound("m_purge", null, "image", { deletedAt: new Date(), payload: { purge_key: "inbox/media/2026/11/old.jpg" } });
    await downloadPendingMedia(db, log, store);
    expect(store.deleted).toEqual(["inbox/media/2026/11/old.jpg"]);
    const after = await reload(m.id);
    expect(after.payload).toEqual({});
  });
});
