/**
 * Voice background jobs for the unified inbox.
 *
 *   processPendingRecordings – copy each Twilio recording into private R2,
 *     delete it from Twilio, then (when configured) transcribe and summarise.
 *   sendMissedCallFollowups  – WhatsApp template to callers we missed.
 *
 * Both are safe to run every tick: they no-op when their providers are not
 * configured.
 */
import { and, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { customer, inboxCall, inboxConversation, inboxMessage, inboxPhoneNumber, inboxRecording, type DbClient } from "@ms/db";
import {
  InboxSendError,
  deleteRecording,
  downloadRecording,
  findOrOpenConversation,
  metaConfigFromEnv,
  publishInboxEvent,
  sendFromConversation,
  signalFor,
  twilioRestConfigFromEnv,
  type TwilioRestConfig,
} from "@ms/domain";
import { recordingStoreFromEnv, type RecordingStore } from "./inbox-recording-store.js";

export interface JobLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

// ── Pluggable providers ──────────────────────────────────────────────────────

export interface Transcriber {
  /** Plain-text transcript. For 2-channel audio, channel 1 = caller leg, 2 = staff leg (Twilio dual). */
  transcribe(bytes: Buffer, opts: { channels: number | null; contentType: string }): Promise<string>;
}

export interface CallSummary {
  summary: string;
  call_reason: string;
  action_items: string[];
  sentiment: string;
}

export interface Summariser {
  summariseCall(transcript: string): Promise<CallSummary>;
}

/**
 * No real transcription provider is wired yet: returns null (recordings stay
 * at "stored") unless TRANSCRIBE_PROVIDER is set, in which case it warns that
 * the provider still needs implementing. Inject a Transcriber to enable.
 */
export function transcriberFromEnv(env: NodeJS.ProcessEnv = process.env, logger?: JobLogger): Transcriber | null {
  if (!env.TRANSCRIBE_PROVIDER) return null;
  logger?.warn({ provider: env.TRANSCRIBE_PROVIDER }, "TRANSCRIBE_PROVIDER set but no transcriber is implemented");
  return null;
}

export interface RecordingJobDeps {
  store?: RecordingStore | null;
  twilio?: TwilioRestConfig | null;
  transcriber?: Transcriber | null;
  /** The lead's Claude summariser. Ignored when LLM_API_KEY is unset and none is injected. */
  summariser?: Summariser | null;
  now?: Date;
  batchSize?: number;
}

const MAX_ATTEMPTS = 5;

/** inbox/recordings/YYYY/MM/<id>.mp3 (UTC month of the recording). */
export function recordingStorageKey(id: string, createdAt: Date): string {
  const yyyy = createdAt.getUTCFullYear();
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  return `inbox/recordings/${yyyy}/${mm}/${id}.mp3`;
}

type RecordingRow = typeof inboxRecording.$inferSelect;

async function publishProcessed(db: DbClient, rec: RecordingRow): Promise<void> {
  const [row] = await db
    .select({ conv: inboxConversation })
    .from(inboxCall)
    .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
    .where(eq(inboxCall.id, rec.callId));
  if (row) await publishInboxEvent(db, signalFor("recording.processed", row.conv, rec.id));
}

/**
 * Advance recordings through pending → stored → transcribed → summarised.
 * Returns how many recordings moved forward at least one step.
 */
export async function processPendingRecordings(
  db: DbClient,
  logger: JobLogger,
  deps: RecordingJobDeps = {},
): Promise<number> {
  const store = deps.store !== undefined ? deps.store : recordingStoreFromEnv();
  const twilio = deps.twilio !== undefined ? deps.twilio : twilioRestConfigFromEnv();
  const transcriber = deps.transcriber !== undefined ? deps.transcriber : transcriberFromEnv(process.env, logger);
  const summariser = deps.summariser !== undefined ? deps.summariser : null;
  const now = deps.now ?? new Date();

  const wanted: SQL[] = [];
  if (store && twilio) wanted.push(eq(inboxRecording.status, "pending"));
  if (store && transcriber) wanted.push(eq(inboxRecording.status, "stored"));
  if (summariser) wanted.push(eq(inboxRecording.status, "transcribed"));
  if (wanted.length === 0) return 0;

  const rows = await db
    .select()
    .from(inboxRecording)
    .where(and(lt(inboxRecording.attempts, MAX_ATTEMPTS), or(...wanted)))
    .orderBy(inboxRecording.createdAt)
    .limit(deps.batchSize ?? 10);

  let advanced = 0;
  for (const original of rows) {
    let rec = original;
    let bytes: Buffer | null = null;
    let moved = false;
    try {
      // 1. Twilio → R2, then delete from Twilio.
      if (rec.status === "pending") {
        if (!rec.twilioRecordingUrl) throw new Error("no recording URL from Twilio");
        const dl = await downloadRecording(twilio!, rec.twilioRecordingUrl, { format: "mp3", channels: rec.channels });
        const key = recordingStorageKey(rec.id, rec.createdAt);
        await store!.put(key, dl.bytes, "audio/mpeg");
        bytes = dl.bytes;
        [rec] = (await db
          .update(inboxRecording)
          .set({ storageKey: key, status: "stored", lastError: null, processedAt: now })
          .where(eq(inboxRecording.id, rec.id))
          .returning()) as [RecordingRow];
        moved = true;
        try {
          await deleteRecording(twilio!, rec.twilioRecordingSid);
        } catch (err) {
          // We hold our copy; a leftover at Twilio is a cost/privacy issue, not data loss.
          logger.warn({ err, recordingId: rec.id }, "could not delete recording from Twilio");
          await db
            .update(inboxRecording)
            .set({ lastError: `twilio delete: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000) })
            .where(eq(inboxRecording.id, rec.id));
        }
      }

      // 2. Transcribe.
      if (rec.status === "stored" && transcriber && store) {
        bytes ??= await store.get(rec.storageKey!);
        const transcript = await transcriber.transcribe(bytes, { channels: rec.channels, contentType: "audio/mpeg" });
        [rec] = (await db
          .update(inboxRecording)
          .set({ transcript, status: "transcribed", lastError: null, processedAt: now })
          .where(eq(inboxRecording.id, rec.id))
          .returning()) as [RecordingRow];
        moved = true;
      }

      // 3. Summarise.
      if (rec.status === "transcribed" && summariser && rec.transcript) {
        const summary = await summariser.summariseCall(rec.transcript);
        [rec] = (await db
          .update(inboxRecording)
          .set({ summaryJson: summary, status: "summarised", lastError: null, processedAt: now })
          .where(eq(inboxRecording.id, rec.id))
          .returning()) as [RecordingRow];
        moved = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = rec.attempts + 1;
      logger.warn({ err, recordingId: rec.id, status: rec.status, attempts }, "recording processing failed");
      await db
        .update(inboxRecording)
        .set({
          attempts,
          lastError: message.slice(0, 1000),
          // Only a recording we never managed to copy is "failed"; later stages keep their status.
          ...(rec.status === "pending" && attempts >= MAX_ATTEMPTS ? { status: "failed" as const } : {}),
        })
        .where(eq(inboxRecording.id, rec.id));
    }
    if (moved) {
      advanced++;
      await publishProcessed(db, rec);
    }
  }
  return advanced;
}

// ── Missed-call follow-up ────────────────────────────────────────────────────

const FOLLOWUP_WINDOW_MS = 6 * 60 * 60 * 1000;
const FOLLOWUP_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FOLLOWUP_MAX_TRIES = 3;
/** Calls with no final status callback are treated as over after this long. */
const STALE_CALL_MS = 15 * 60 * 1000;
export const MISSED_CALL_TEMPLATE = "missed_call_followup";

export function firstNameOrThere(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : "there";
}

/**
 * WhatsApp the callers we missed (missed / voicemail / after_hours, inbound,
 * never answered, within the last 6h). At-most-once: each call is claimed by
 * setting followup_sent_at before sending and the claim is never released.
 * Skipped when the customer already had a follow-up in the last 6h or staff
 * have messaged them since the call.
 */
export async function sendMissedCallFollowups(
  db: DbClient,
  logger: JobLogger,
  opts: { now?: Date; batchSize?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const cfg = metaConfigFromEnv(env);
  if (!cfg) return 0;
  const now = opts.now ?? new Date();
  const language = env.INBOX_TEMPLATE_LANGUAGE || "en";

  const calls = await db
    .select({
      call: inboxCall,
      channels: inboxPhoneNumber.channels,
      waPhoneNumberId: inboxPhoneNumber.waPhoneNumberId,
      fallbackId: inboxPhoneNumber.waFallbackNumberId,
      customerName: customer.name,
    })
    .from(inboxCall)
    // Only phone lines take calls; a Page or Instagram account never sends a follow-up.
    .innerJoin(inboxPhoneNumber, and(eq(inboxPhoneNumber.id, inboxCall.phoneNumberId), eq(inboxPhoneNumber.kind, "phone")))
    .innerJoin(customer, eq(customer.id, inboxCall.customerId))
    .where(
      and(
        eq(inboxCall.direction, "in"),
        inArray(inboxCall.outcome, ["missed", "voicemail", "after_hours"]),
        isNull(inboxCall.followupSentAt),
        // A call someone picked up is never "missed", whatever the callbacks said.
        isNull(inboxCall.answeredAt),
        gte(inboxCall.startedAt, new Date(now.getTime() - FOLLOWUP_WINDOW_MS)),
        // Wait until the caller has hung up (or the call is clearly over).
        or(sql`${inboxCall.endedAt} is not null`, lt(inboxCall.startedAt, new Date(now.getTime() - STALE_CALL_MS))),
      ),
    )
    .orderBy(inboxCall.startedAt)
    .limit(opts.batchSize ?? 20);

  let sent = 0;
  for (const row of calls) {
    const { call } = row;
    const [claimed] = await db
      .update(inboxCall)
      .set({ followupSentAt: now })
      .where(and(eq(inboxCall.id, call.id), isNull(inboxCall.followupSentAt)))
      .returning({ id: inboxCall.id });
    if (!claimed) continue;

    // One follow-up per customer per 6 hours, and none if staff already replied.
    const since = new Date(now.getTime() - FOLLOWUP_COOLDOWN_MS);
    const [recentFollowup] = await db
      .select({ id: inboxCall.id })
      .from(inboxCall)
      .where(and(eq(inboxCall.customerId, call.customerId), ne(inboxCall.id, call.id), gte(inboxCall.followupSentAt, since)))
      .limit(1);
    const [staffReply] = await db
      .select({ id: inboxMessage.id })
      .from(inboxMessage)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxMessage.conversationId))
      .where(
        and(
          eq(inboxConversation.customerId, call.customerId),
          eq(inboxMessage.direction, "out"),
          ne(inboxMessage.status, "failed"),
          gte(inboxMessage.createdAt, call.startedAt),
        ),
      )
      .limit(1);
    if (recentFollowup || staffReply) {
      logger.info({ callId: call.id }, "missed-call follow-up skipped: already contacted");
      continue;
    }

    let conversationId: string | null = null;
    try {
      if (row.channels !== "voice" && row.waPhoneNumberId) {
        conversationId = call.conversationId;
      } else if (row.fallbackId) {
        // The fallback must be a WhatsApp phone line too, never a Page.
        const [fallback] = await db
          .select({ id: inboxPhoneNumber.id })
          .from(inboxPhoneNumber)
          .where(and(eq(inboxPhoneNumber.id, row.fallbackId), eq(inboxPhoneNumber.kind, "phone")));
        if (fallback) {
          const { conversation } = await findOrOpenConversation(db, call.customerId, fallback.id, now);
          conversationId = conversation.id;
        }
      }
      if (!conversationId) {
        logger.info({ callId: call.id }, "missed-call follow-up skipped: no WhatsApp number to send from");
        continue;
      }
      const msg = await sendFromConversation(
        db,
        cfg,
        {
          conversationId,
          userId: null,
          content: {
            type: "template",
            name: MISSED_CALL_TEMPLATE,
            language,
            bodyParams: [firstNameOrThere(row.customerName)],
          },
        },
        now,
      );
      if (msg.status === "failed") {
        // Retry only when it certainly did not go out (never when unconfirmed,
        // which could double-send), and at most FOLLOWUP_MAX_TRIES times.
        const retryable = (msg.payload as { retryable?: boolean } | null)?.retryable === true;
        const [tries] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(inboxMessage)
          .where(
            and(
              eq(inboxMessage.conversationId, conversationId),
              eq(inboxMessage.templateName, MISSED_CALL_TEMPLATE),
              eq(inboxMessage.status, "failed"),
              gte(inboxMessage.createdAt, call.startedAt),
            ),
          );
        if (retryable && (tries?.n ?? 0) < FOLLOWUP_MAX_TRIES) {
          await db.update(inboxCall).set({ followupSentAt: null }).where(eq(inboxCall.id, call.id));
          logger.warn({ callId: call.id, error: msg.errorMessage }, "missed-call follow-up not sent; will retry");
        } else {
          logger.warn({ callId: call.id, messageId: msg.id, error: msg.errorMessage }, "missed-call follow-up failed");
        }
      } else {
        sent++;
      }
    } catch (err) {
      if (err instanceof InboxSendError) {
        // Not retryable (template not approved, no WhatsApp, …): keep the claim so it doesn't loop.
        logger.warn({ callId: call.id, code: err.code, err: err.message }, "missed-call follow-up not sent");
      } else {
        // At most once: the send may already have reached Meta before this
        // error, so the claim is never released (no double messages).
        logger.error({ err, callId: call.id }, "missed-call follow-up error; not retried");
      }
    }
  }
  return sent;
}
