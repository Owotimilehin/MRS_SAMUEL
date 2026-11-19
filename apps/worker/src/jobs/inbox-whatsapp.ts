/**
 * WhatsApp background jobs for the unified inbox:
 *   - retryWebhookEvents: re-process stored Meta webhooks that failed inline
 *     (WhatsApp, and Page/Instagram events through ingestMetaEntry)
 *   - downloadPendingMedia: fetch incoming photos/voice notes/documents from
 *     Meta (short-lived URLs) into private R2 storage, and remove files of
 *     messages the customer unsent
 *   - syncAllTemplates: hourly refresh of message templates from Meta
 *   - refreshPendingTemplates: every 5 minutes, templates still in review
 *   - syncAllFlows: hourly refresh of the status of WhatsApp forms (Flows) we hold
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  inboxWebhookEvent,
  outboxEvent,
  waFlow,
  type DbClient,
} from "@ms/db";
import {
  downloadMedia,
  finishMetaWebhookEvent,
  finishWebhookEvent,
  ingestMetaEntry,
  ingestWhatsAppPayload,
  applyMetaTemplate,
  getTemplate,
  metaConfigFromEnv,
  publishInboxEvent,
  sendAfterHoursAutoReplies,
  signalFor,
  syncTemplatesForWaba,
  syncFlowsForWaba,
  MetaApiError,
  type MetaEntry,
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
    const resyncWabas: string[] = [];
    let noSender = 0;
    try {
      await db.transaction(async (tx) => {
        const payload = ev.payload as { object?: string; entry?: unknown[] };
        if (payload.object === "page" || payload.object === "instagram") {
          // Page and Instagram events: one entry per stored row (spec 02, ruling 9.2.3).
          const appId = process.env.META_APP_ID;
          const res = await ingestMetaEntry(tx, payload.object, (payload.entry?.[0] ?? {}) as MetaEntry, appId ? { appId } : {});
          await finishMetaWebhookEvent(tx, ev.id, res);
        } else {
          const res = await ingestWhatsAppPayload(tx, ev.payload as WaWebhookPayload);
          await finishWebhookEvent(tx, ev.id, res);
          resyncWabas.push(...res.templateResyncWabas);
          noSender = res.noSender;
        }
      });
      if (noSender > 0) {
        // finishWebhookEvent left it unprocessed and counted the attempt: stop at the limit and tell the owner.
        const attempts = ev.attempts + 1;
        log.warn({ eventId: ev.id, attempts }, "whatsapp message with no usable sender; event left unprocessed");
        if (attempts >= MAX_WEBHOOK_ATTEMPTS) {
          await db.insert(outboxEvent).values({
            eventType: "inbox.webhook_dead",
            payload: { webhook_event_id: ev.id, error: "a message arrived with no sender we can use (no_sender)" },
          });
        }
      } else {
        done++;
      }
      // A template event for a template we do not hold: one sync of that account, after the commit.
      const cfg = resyncWabas.length > 0 ? metaConfigFromEnv() : null;
      for (const waba of cfg ? resyncWabas : []) {
        try {
          await syncTemplatesForWaba(db, cfg!, waba);
        } catch (err) {
          log.warn({ err, waba }, "template re-sync after a webhook failed; the hourly sync will catch up");
        }
      }
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
  "image/gif": "gif",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/x-m4a": "m4a",
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
  if (!store) return 0;
  const cfg = metaConfigFromEnv();
  let done = 0;
  if (cfg) done += await downloadWhatsAppMedia(db, log, store, cfg);
  done += await downloadLinkedMedia(db, log, store);
  await purgeUnsentMedia(db, log, store);
  return done;
}

function mediaKeyFor(m: { id: string; createdAt: Date }, mime: string, filename: string | null): string {
  const d = m.createdAt;
  return `inbox/media/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${m.id}.${extensionFor(mime, filename)}`;
}

async function signalStatus(db: DbClient, conversationId: string, messageId: string): Promise<void> {
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
  if (conv) await publishInboxEvent(db, signalFor("message.status", conv, messageId));
}

/** WhatsApp: resolve the media id at Meta, then fetch it with the token. */
async function downloadWhatsAppMedia(
  db: DbClient,
  log: Log,
  store: RecordingStore,
  cfg: NonNullable<ReturnType<typeof metaConfigFromEnv>>,
): Promise<number> {
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
      const key = mediaKeyFor(m, mimeType, m.mediaFilename);
      await store.put(key, Buffer.from(bytes), mimeType);
      await db
        .update(inboxMessage)
        .set({ mediaKey: key, mediaMime: mimeType, mediaAttempts: sql`${inboxMessage.mediaAttempts} + 1` })
        .where(eq(inboxMessage.id, m.id));
      await signalStatus(db, m.conversationId, m.id);
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

/** Messenger and Instagram files are refused above this size (spec 02, 6.2). */
export const MAX_LINKED_MEDIA_BYTES = 26 * 1024 * 1024;

/**
 * Messenger and Instagram: the webhook gave us a short-lived link (media_url).
 * Fetch it with no authorization header, store it, and clear the link (rule
 * R26). A 403/404/410 means the link has expired: give up and clear it.
 * Story mentions and shares never have a media_url, so they are never fetched.
 */
async function downloadLinkedMedia(db: DbClient, log: Log, store: RecordingStore): Promise<number> {
  const pending = await db
    .select()
    .from(inboxMessage)
    .where(
      and(
        isNotNull(inboxMessage.mediaUrl),
        isNull(inboxMessage.mediaKey),
        isNull(inboxMessage.deletedAt),
        lt(inboxMessage.mediaAttempts, MAX_MEDIA_ATTEMPTS),
        gt(inboxMessage.createdAt, sql`now() - interval '14 days'`),
        notInArray(inboxMessage.type, ["story_mention", "share"]),
      ),
    )
    .orderBy(asc(inboxMessage.createdAt))
    .limit(10);

  let done = 0;
  for (const m of pending) {
    const giveUp = async (errorMessage: string, clearLink: boolean) => {
      await db
        .update(inboxMessage)
        .set({ mediaAttempts: MAX_MEDIA_ATTEMPTS, errorMessage, ...(clearLink ? { mediaUrl: null } : {}) })
        .where(eq(inboxMessage.id, m.id));
    };
    try {
      const res = await fetch(m.mediaUrl!, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        await giveUp("media download: the link expired", true);
        await signalStatus(db, m.conversationId, m.id);
        continue;
      }
      if (!res.ok) throw new Error(`media download ${res.status}`);
      const length = Number(res.headers.get("content-length") ?? "0");
      if (length > MAX_LINKED_MEDIA_BYTES) {
        await res.body?.cancel();
        await giveUp("media download: too large", false);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_LINKED_MEDIA_BYTES) {
        await giveUp("media download: too large", false);
        continue;
      }
      const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
      const key = mediaKeyFor(m, mime, m.mediaFilename);
      await store.put(key, bytes, mime);
      await db
        .update(inboxMessage)
        .set({ mediaKey: key, mediaMime: mime, mediaUrl: null, mediaAttempts: sql`${inboxMessage.mediaAttempts} + 1` })
        .where(eq(inboxMessage.id, m.id));
      await signalStatus(db, m.conversationId, m.id);
      done++;
    } catch (err) {
      await db
        .update(inboxMessage)
        .set({
          mediaAttempts: sql`${inboxMessage.mediaAttempts} + 1`,
          errorMessage: `media download: ${err instanceof Error ? err.message : String(err)}`,
        })
        .where(eq(inboxMessage.id, m.id));
      log.warn({ err, messageId: m.id }, "inbox linked media download failed");
    }
  }
  return done;
}

/** Remove stored files of messages the customer unsent (payload.purge_key, rule R9). Retried next tick on failure. */
async function purgeUnsentMedia(db: DbClient, log: Log, store: RecordingStore): Promise<number> {
  const rows = await db
    .select({ id: inboxMessage.id, key: sql<string>`${inboxMessage.payload}->>'purge_key'` })
    .from(inboxMessage)
    .where(sql`${inboxMessage.payload} ? 'purge_key'`)
    .limit(20);
  let done = 0;
  for (const r of rows) {
    try {
      if (r.key) await store.delete(r.key);
      await db
        .update(inboxMessage)
        .set({ payload: sql`${inboxMessage.payload} - 'purge_key'` })
        .where(eq(inboxMessage.id, r.id));
      done++;
    } catch (err) {
      log.warn({ err, messageId: r.id }, "inbox media purge failed; will retry");
    }
  }
  return done;
}

/**
 * After-hours WhatsApp auto-reply to customers who write when closed. The
 * rules and the at-most-once guarantee live in @ms/domain (inbox/auto-reply).
 * No-op when WhatsApp isn't configured.
 */
export async function sendAutoReplies(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  return sendAfterHoursAutoReplies(db, metaConfigFromEnv(), log, opts);
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
      // The one sync (packages/domain): keeps local drafts, never marks them deleted.
      total += await syncTemplatesForWaba(db, cfg, waba);
    } catch (err) {
      log.warn({ err, waba }, "inbox template sync failed");
    }
  }
  return total;
}

/**
 * Every 5 minutes: ask Meta about templates still waiting for review (and those whose category change
 * has come due), so the list moves even when the three template webhook fields are not subscribed
 * (suite spec 06, section 6). Only reads; never submits, edits or deletes a template. A rate limit
 * stops the run until the next tick; a refusal for one template is logged and skipped.
 */
/**
 * Hourly: bring the status and validation errors of the forms we hold in line with Meta (suite
 * spec 07, section 6). Read-only at Meta. It never creates, uploads, publishes, retires or sends a
 * form. A failure is logged and tried again next hour.
 */
export async function syncAllFlows(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const cfg = metaConfigFromEnv();
  if (!cfg) return 0;
  const wabas = await db.selectDistinct({ waba: waFlow.wabaId }).from(waFlow).where(isNotNull(waFlow.metaFlowId));
  let total = 0;
  for (const { waba } of wabas) {
    try {
      total += await syncFlowsForWaba(db, cfg, waba, opts.now ?? new Date());
    } catch (err) {
      log.warn({ err, waba }, "whatsapp form sync failed");
    }
  }
  return total;
}

export async function refreshPendingTemplates(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const cfg = metaConfigFromEnv();
  if (!cfg) return 0;
  const now = opts.now ?? new Date();
  const rows = await db
    .select()
    .from(inboxTemplate)
    .where(
      and(
        isNotNull(inboxTemplate.metaTemplateId),
        or(
          inArray(inboxTemplate.status, ["PENDING", "IN_APPEAL"]),
          and(
            isNotNull(inboxTemplate.correctCategory),
            isNotNull(inboxTemplate.categoryChangeAt),
            lt(inboxTemplate.categoryChangeAt, now),
            // Not read since the change fell due.
            lt(inboxTemplate.syncedAt, sql`${inboxTemplate.categoryChangeAt}`),
          ),
        ),
      ),
    )
    .orderBy(asc(inboxTemplate.syncedAt), asc(inboxTemplate.id))
    .limit(20);

  let done = 0;
  for (const row of rows) {
    try {
      const fresh = await getTemplate(cfg, row.metaTemplateId!);
      await applyMetaTemplate(db, row.wabaId, fresh, now);
      done++;
    } catch (err) {
      if (err instanceof MetaApiError && err.retryable) {
        log.warn({ err, template: row.id }, "template refresh stopped: Meta is busy");
        break;
      }
      log.warn({ err, template: row.id }, "template refresh skipped one template");
    }
  }
  return done;
}
