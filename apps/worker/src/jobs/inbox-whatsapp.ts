/**
 * WhatsApp background jobs for the unified inbox:
 *   - retryWebhookEvents: re-process stored Meta webhooks that failed inline
 *   - downloadPendingMedia: fetch incoming photos/voice notes/documents from
 *     Meta (short-lived URLs) into private R2 storage
 *   - syncAllTemplates: hourly refresh of message templates from Meta
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  inboxWebhookEvent,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import {
  downloadMedia,
  ingestWhatsAppPayload,
  listTemplates,
  metaConfigFromEnv,
  publishInboxEvent,
  signalFor,
  MetaApiError,
  type WaWebhookPayload,
} from "@ms/domain";
import { recordingStoreFromEnv, type RecordingStore } from "./inbox-recording-store.js";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

const MAX_WEBHOOK_ATTEMPTS = 8;
const MAX_MEDIA_ATTEMPTS = 5;

export async function retryWebhookEvents(db: DbClient, log: Log): Promise<number> {
  const due = await db
    .select()
    .from(inboxWebhookEvent)
    .where(
      and(
        eq(inboxWebhookEvent.source, "meta"),
        isNull(inboxWebhookEvent.processedAt),
        lt(inboxWebhookEvent.attempts, MAX_WEBHOOK_ATTEMPTS),
        // Give the inline attempt time to finish; back off by attempts.
        lt(inboxWebhookEvent.receivedAt, sql`now() - (interval '30 seconds' * power(2, ${inboxWebhookEvent.attempts}))`),
      ),
    )
    .orderBy(asc(inboxWebhookEvent.receivedAt))
    .limit(25);

  let done = 0;
  for (const ev of due) {
    try {
      await db.transaction(async (tx) => {
        await ingestWhatsAppPayload(tx, ev.payload as WaWebhookPayload);
        await tx
          .update(inboxWebhookEvent)
          .set({ processedAt: new Date(), attempts: sql`${inboxWebhookEvent.attempts} + 1`, lastError: null })
          .where(eq(inboxWebhookEvent.id, ev.id));
      });
      done++;
    } catch (err) {
      const attempts = ev.attempts + 1;
      await db
        .update(inboxWebhookEvent)
        .set({ attempts, lastError: err instanceof Error ? err.message : String(err) })
        .where(eq(inboxWebhookEvent.id, ev.id));
      log.error({ err, eventId: ev.id, attempts }, "inbox webhook retry failed");
      if (attempts >= MAX_WEBHOOK_ATTEMPTS) {
        await db.insert(outboxEvent).values({
          eventType: "inbox.webhook_dead",
          payload: { webhook_event_id: ev.id, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
  return done;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

export function extensionFor(mime: string | null | undefined, filename?: string | null): string {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base]!;
  const fromName = filename?.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  return fromName || "bin";
}

export async function downloadPendingMedia(
  db: DbClient,
  log: Log,
  store: RecordingStore | null = recordingStoreFromEnv(),
): Promise<number> {
  const cfg = metaConfigFromEnv();
  if (!cfg || !store) return 0;

  const pending = await db
    .select()
    .from(inboxMessage)
    .where(
      and(
        isNotNull(inboxMessage.mediaId),
        isNull(inboxMessage.mediaKey),
        lt(inboxMessage.mediaAttempts, MAX_MEDIA_ATTEMPTS),
        // Meta keeps media for a limited time; don't chase old ones forever.
        gt(inboxMessage.createdAt, sql`now() - interval '14 days'`),
      ),
    )
    .orderBy(asc(inboxMessage.createdAt))
    .limit(10);

  let done = 0;
  for (const m of pending) {
    try {
      const { bytes, mimeType } = await downloadMedia(cfg, m.mediaId!);
      const d = m.createdAt;
      const key = `inbox/media/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${m.id}.${extensionFor(mimeType, m.mediaFilename)}`;
      await store.put(key, Buffer.from(bytes), mimeType);
      await db
        .update(inboxMessage)
        .set({ mediaKey: key, mediaMime: mimeType, mediaAttempts: sql`${inboxMessage.mediaAttempts} + 1` })
        .where(eq(inboxMessage.id, m.id));
      const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, m.conversationId));
      if (conv) await publishInboxEvent(db, signalFor("message.status", conv, m.id));
      done++;
    } catch (err) {
      const permanent = err instanceof MetaApiError && !err.retryable;
      await db
        .update(inboxMessage)
        .set({
          mediaAttempts: permanent ? MAX_MEDIA_ATTEMPTS : sql`${inboxMessage.mediaAttempts} + 1`,
          errorMessage: `media download: ${err instanceof Error ? err.message : String(err)}`,
        })
        .where(eq(inboxMessage.id, m.id));
      log.warn({ err, messageId: m.id }, "inbox media download failed");
    }
  }
  return done;
}

export async function syncAllTemplates(db: DbClient, log: Log): Promise<number> {
  const cfg = metaConfigFromEnv();
  if (!cfg) return 0;
  const wabas = await db
    .selectDistinct({ waba: inboxPhoneNumber.wabaId })
    .from(inboxPhoneNumber)
    .where(and(isNotNull(inboxPhoneNumber.wabaId), eq(inboxPhoneNumber.isActive, true)));
  let total = 0;
  for (const { waba } of wabas) {
    if (!waba) continue;
    try {
      const templates = await listTemplates(cfg, waba);
      const now = new Date();
      for (const t of templates) {
        await db
          .insert(inboxTemplate)
          .values({ wabaId: waba, name: t.name, language: t.language, category: t.category ?? null, status: t.status, components: t.components ?? [], syncedAt: now })
          .onConflictDoUpdate({
            target: [inboxTemplate.wabaId, inboxTemplate.name, inboxTemplate.language],
            set: { status: t.status, category: t.category ?? null, components: t.components ?? [], syncedAt: now },
          });
      }
      // Templates deleted in WhatsApp Manager: mark them so they can't be picked.
      const names = templates.map((t) => `${t.name}::${t.language}`);
      const existing = await db.select().from(inboxTemplate).where(eq(inboxTemplate.wabaId, waba));
      const gone = existing.filter((e) => !names.includes(`${e.name}::${e.language}`) && e.status !== "DELETED").map((e) => e.id);
      if (gone.length) await db.update(inboxTemplate).set({ status: "DELETED", syncedAt: now }).where(inArray(inboxTemplate.id, gone));
      total += templates.length;
    } catch (err) {
      log.warn({ err, waba }, "inbox template sync failed");
    }
  }
  return total;
}
