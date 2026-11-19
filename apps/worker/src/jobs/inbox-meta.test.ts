import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDbClient, customer, inboxConversation, inboxIdentity, inboxMessage, inboxPhoneNumber, inboxWebhookEvent, outboxEvent } from "@ms/db";
import { clearPageTokenCache, PAGE_WEBHOOK_FIELDS } from "@ms/domain";
import { downloadPendingMedia, MAX_LINKED_MEDIA_BYTES, retryWebhookEvents } from "./inbox-whatsapp.js";
import { ensureMetaSubscriptions, refreshIdentityProfiles } from "./inbox-meta.js";
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
    if (url.startsWith("https://graph.facebook.com/")) {
      const method = init?.method ?? "GET";
      graphCalls.push({ method, url });
      const path = new URL(url).pathname.replace(/^\/v[\d.]+\//, "");
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("fields=access_token")) return ok({ access_token: "itest-worker-page-token" });
      if (path.endsWith("/subscribed_apps")) {
        if (method === "POST") {
          subscribed = true;
          return ok({ success: true });
        }
        return ok({ data: subscribed ? [{ id: "APP1", subscribed_fields: [...PAGE_WEBHOOK_FIELDS] }] : [] });
      }
      const profile = profiles.get(path);
      if (profile === "error") return new Response(JSON.stringify({ error: { message: "No profile available for this user", code: 2018218 } }), { status: 400 });
      return ok(profile ?? {});
    }
    throw new Error(`unexpected network call in test: ${url}`);
  }) as typeof fetch;
}

const graphCalls: { method: string; url: string }[] = [];
/** Profile answers by scoped ID ("error" = Meta has no profile for them). */
const profiles = new Map<string, Record<string, unknown> | "error">();
let subscribed = false;

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

describe("spec 02 worker: profiles and subscriptions", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  const cfg = { token: "itest-system-token", graphVersion: "v23.0", appId: "APP1" };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    installStub();
    clearPageTokenCache();
    await db.insert(inboxPhoneNumber).values([
      { kind: "messenger", e164: null, externalId: PAGE_ID, pageExternalId: PAGE_ID, label: "Facebook Page", channels: "whatsapp" },
      { kind: "instagram", e164: null, externalId: "17841400000000001", pageExternalId: PAGE_ID, label: "Instagram", channels: "whatsapp" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  async function identity(channel: "messenger" | "instagram", externalId: string, names: { displayName?: string } = {}) {
    const [cust] = await db.insert(customer).values({ name: null, phone: null, source: "online" }).returning();
    const [ident] = await db
      .insert(inboxIdentity)
      .values({
        customerId: cust!.id,
        channel,
        accountExternalId: channel === "messenger" ? PAGE_ID : "17841400000000001",
        externalId,
        displayName: names.displayName ?? null,
        lastSeenAt: new Date(),
      })
      .returning();
    return { ident: ident!, customerId: cust!.id };
  }

  it("refreshIdentityProfiles fills name and picture and never clears a known name", async () => {
    profiles.set("24000000000000001", { first_name: "Ada", last_name: "Obi", profile_pic: "https://cdn.example.test/ada.jpg" });
    profiles.set("980000000000000001", { name: null, username: "bisi_juice", profile_pic: null });
    profiles.set("24000000000000002", "error");
    const a = await identity("messenger", "24000000000000001");
    const b = await identity("instagram", "980000000000000001");
    const known = await identity("messenger", "24000000000000002", { displayName: "Chidi from WhatsApp" });

    expect(await refreshIdentityProfiles(db, log, cfg)).toBe(3);
    const read = async (id: string) => (await db.select().from(inboxIdentity).where(eq(inboxIdentity.id, id)))[0]!;
    expect(await read(a.ident.id)).toMatchObject({ displayName: "Ada Obi", profilePicUrl: "https://cdn.example.test/ada.jpg" });
    expect(await read(b.ident.id)).toMatchObject({ username: "bisi_juice", displayName: null });
    const k = await read(known.ident.id);
    expect(k.displayName).toBe("Chidi from WhatsApp"); // a failed look-up never wipes a name
    expect(k.profileFetchedAt).not.toBeNull(); // and is not retried for 3 days
    // The customer row is never touched (foundation D2).
    const [cust] = await db.select().from(customer).where(eq(customer.id, a.customerId));
    expect(cust!.name).toBeNull();
    // Nothing is due now.
    expect(await refreshIdentityProfiles(db, log, cfg)).toBe(0);
  });

  it("ensureMetaSubscriptions re-subscribes when the app is missing", async () => {
    subscribed = false;
    graphCalls.length = 0;
    expect(await ensureMetaSubscriptions(db, log, cfg)).toBe(1);
    const posts = graphCalls.filter((c) => c.method === "POST" && c.url.includes("/subscribed_apps"));
    expect(posts).toHaveLength(1); // one Page behind both lines → one call
    expect(posts[0]!.url).toContain(`/${PAGE_ID}/subscribed_apps?subscribed_fields=`);
    const lines = await db.select().from(inboxPhoneNumber);
    expect(lines.every((l) => l.webhookSubscribedAt !== null && l.webhookCheckedAt !== null)).toBe(true);
    // Already subscribed: only a check.
    graphCalls.length = 0;
    expect(await ensureMetaSubscriptions(db, log, cfg)).toBe(0);
    expect(graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("M2: a WhatsApp event whose message has no usable sender is retried up to the limit, then raises one owner alert and stops", async () => {
    const WA_ID = "1098765499";
    await db.insert(inboxPhoneNumber).values({ e164: "+2348000000499", label: "Main", channels: "whatsapp", waPhoneNumberId: WA_ID });
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA1", changes: [{ field: "messages", value: { metadata: { phone_number_id: WA_ID }, messages: [{ id: "wamid.m2.nobody", timestamp: "1795000000", type: "text", text: { body: "?" } }] } }] }],
    };
    const old = new Date("2026-01-01T00:00:00Z"); // long past every back-off
    const [ev] = await db.insert(inboxWebhookEvent).values({ source: "meta", kind: "messages", payload, attempts: 6, receivedAt: old }).returning();
    const reloadEv = async () => (await db.select().from(inboxWebhookEvent).where(eq(inboxWebhookEvent.id, ev!.id)))[0]!;
    const alerts = async () =>
      (await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "inbox.webhook_dead"))).filter((o) => (o.payload as { webhook_event_id?: string }).webhook_event_id === ev!.id);
    const warned: object[] = [];
    const logSpy = { ...log, warn: (o: object) => void warned.push(o) };

    expect(await retryWebhookEvents(db, logSpy)).toBe(0);
    expect(await reloadEv()).toMatchObject({ processedAt: null, lastError: "no_sender", attempts: 7 });
    expect(await alerts()).toHaveLength(0);

    expect(await retryWebhookEvents(db, logSpy)).toBe(0);
    expect(await reloadEv()).toMatchObject({ processedAt: null, lastError: "no_sender", attempts: 8 });
    expect(await alerts()).toHaveLength(1);

    // At the limit the job no longer picks it up: no loop, no second alert.
    expect(await retryWebhookEvents(db, logSpy)).toBe(0);
    expect(await reloadEv()).toMatchObject({ attempts: 8 });
    expect(await alerts()).toHaveLength(1);
    expect(warned).toHaveLength(2);
    expect(JSON.stringify(warned)).not.toContain("wamid.m2.nobody");
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.m2.nobody"))).toHaveLength(0);
  });
});
