/**
 * Turn a Meta WhatsApp webhook payload into inbox rows.
 *
 * Idempotent: messages are keyed on wa_message_id (Meta retries webhooks, and
 * the worker replays stored ones), statuses only move forward.
 *
 * Media is NOT downloaded here — the message is saved with media_id and the
 * worker fetches it (Meta's URLs are short-lived; the worker retries).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { inboxConversation, inboxMessage, inboxPhoneNumber, inboxWebhookEvent, type DbExecutor } from "@ms/db";
import { messagePreview, toE164 } from "@ms/shared";
import { findOrCreateCustomer, findOrOpenConversation, publishInboxEvent, signalFor, touchConversation, ts } from "./core.js";

/**
 * A delivery status arrived for a message we haven't finished saving (Meta can
 * call back before our send request returns). Thrown so the whole event stays
 * unprocessed and the worker retries it shortly; older orphans are ignored.
 */
export class StatusBeforeSendError extends Error {
  constructor(public readonly waMessageId: string) {
    super(`status for ${waMessageId} arrived before the message was saved; will retry`);
    this.name = "StatusBeforeSendError";
  }
}

const ORPHAN_STATUS_RETRY_MS = 5 * 60 * 1000;

export class UnknownBusinessNumberError extends Error {
  constructor(public readonly waPhoneNumberId: string) {
    super(`WhatsApp event for unknown phone_number_id ${waPhoneNumberId}`);
    this.name = "UnknownBusinessNumberError";
  }
}

// ── Payload shapes (only the parts we read) ─────────────────────────────────

interface WaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

export interface WaInboundMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: WaMedia;
  video?: WaMedia;
  audio?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  context?: { id?: string };
}

interface WaStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

interface WaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: WaInboundMessage[];
  statuses?: WaStatus[];
  // phone_number_quality_update / account updates
  display_phone_number?: string;
  event?: string;
  current_limit?: string;
}

export interface WaWebhookPayload {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: WaChangeValue }[] }[];
}

// ── Message parsing ─────────────────────────────────────────────────────────

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;

/** Flatten an inbound message into the columns we store. Exported for tests. */
export function parseInbound(m: WaInboundMessage): {
  type: string;
  body: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
} {
  let body: string | null = null;
  let media: WaMedia | undefined;
  let type = m.type;
  switch (m.type) {
    case "text":
      body = m.text?.body ?? null;
      break;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      media = m[m.type];
      body = media?.caption ?? null;
      break;
    case "location": {
      const l = m.location ?? {};
      const where = [l.name, l.address].filter(Boolean).join(", ");
      body = `${where ? `${where} ` : ""}(${l.latitude}, ${l.longitude})`;
      break;
    }
    case "button":
      body = m.button?.text ?? m.button?.payload ?? null;
      type = "interactive";
      break;
    case "interactive":
      body = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
      break;
    case "reaction":
      body = m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : "Removed a reaction";
      break;
    case "contacts": {
      const c = m.contacts?.[0];
      body = [c?.name?.formatted_name, c?.phones?.[0]?.phone].filter(Boolean).join(" ") || "Shared a contact";
      break;
    }
    default:
      type = "unsupported";
      body = "This message type isn't supported yet — open WhatsApp to view it.";
  }
  return {
    type,
    body,
    mediaId: (MEDIA_TYPES as readonly string[]).includes(m.type) ? (media?.id ?? null) : null,
    mediaMime: media?.mime_type ?? null,
    mediaFilename: media?.filename ?? null,
  };
}

function tsToDate(ts: string | undefined): Date {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

// ── Processing ──────────────────────────────────────────────────────────────

export interface IngestResult {
  messagesCreated: number;
  statusesApplied: number;
  unknownNumbers: string[];
}

/**
 * Apply one webhook payload. Run it inside a transaction so the rows and the
 * real-time signals land together. Unknown business numbers are reported (not
 * thrown) so other entries in the same payload still process.
 */
export async function ingestWhatsAppPayload(db: DbExecutor, payload: WaWebhookPayload): Promise<IngestResult> {
  const result: IngestResult = { messagesCreated: 0, statusesApplied: 0, unknownNumbers: [] };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      if (change.field === "phone_number_quality_update") {
        await applyQualityUpdate(db, value);
        continue;
      }
      if (change.field !== "messages") continue;

      const waNumberId = value.metadata?.phone_number_id;
      if (!waNumberId) continue;
      const [number] = await db
        .select()
        .from(inboxPhoneNumber)
        .where(eq(inboxPhoneNumber.waPhoneNumberId, waNumberId));
      if (!number) {
        result.unknownNumbers.push(waNumberId);
        continue;
      }

      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);

      for (const m of value.messages ?? []) {
        if (await ingestMessage(db, number.id, m, names.get(m.from) ?? null)) result.messagesCreated++;
      }
      for (const s of value.statuses ?? []) {
        if (await applyStatus(db, s)) result.statusesApplied++;
      }
    }
  }
  return result;
}

async function ingestMessage(
  db: DbExecutor,
  phoneNumberId: string,
  m: WaInboundMessage,
  profileName: string | null,
): Promise<boolean> {
  // Cheap duplicate check before creating any customer/conversation rows.
  const [dupe] = await db.select({ id: inboxMessage.id }).from(inboxMessage).where(eq(inboxMessage.waMessageId, m.id));
  if (dupe) return false;

  const phone = toE164(m.from);
  if (!phone) return false;
  const cust = await findOrCreateCustomer(db, phone, { name: profileName, source: "whatsapp" });
  const { conversation } = await findOrOpenConversation(db, cust.id, phoneNumberId);
  const parsed = parseInbound(m);
  const at = tsToDate(m.timestamp);

  const [row] = await db
    .insert(inboxMessage)
    .values({
      conversationId: conversation.id,
      direction: "in",
      type: parsed.type,
      body: parsed.body,
      mediaId: parsed.mediaId,
      mediaMime: parsed.mediaMime,
      mediaFilename: parsed.mediaFilename,
      waMessageId: m.id,
      status: "received",
      payload: m as unknown as Record<string, unknown>,
      createdAt: at,
    })
    .onConflictDoNothing({ target: inboxMessage.waMessageId })
    .returning({ id: inboxMessage.id });
  if (!row) return false;

  const conv = await touchConversation(db, conversation.id, {
    preview: messagePreview(parsed.type, parsed.body),
    inboundWa: at,
    unreadIncrement: true,
    at,
  });
  await publishInboxEvent(db, { ...signalFor("message.created", conv, row.id), direction: "in" });
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
  return true;
}

async function applyStatus(db: DbExecutor, s: WaStatus): Promise<boolean> {
  const at = tsToDate(s.timestamp);
  const [known] = await db.select({ id: inboxMessage.id }).from(inboxMessage).where(eq(inboxMessage.waMessageId, s.id));
  if (!known) {
    if (Date.now() - at.getTime() < ORPHAN_STATUS_RETRY_MS) throw new StatusBeforeSendError(s.id);
    return false; // sent outside the inbox (e.g. WhatsApp Business app) — nothing to update
  }
  if (s.status === "failed") {
    const err = s.errors?.[0];
    const [row] = await db
      .update(inboxMessage)
      .set({
        status: "failed",
        errorCode: err?.code != null ? String(err.code) : null,
        errorMessage: [err?.title ?? err?.message, err?.error_data?.details].filter(Boolean).join(": ") || "Failed",
      })
      .where(eq(inboxMessage.waMessageId, s.id))
      .returning({ id: inboxMessage.id, conversationId: inboxMessage.conversationId });
    if (row) await signalMessageStatus(db, row.conversationId, row.id);
    return !!row;
  }

  const rank = STATUS_RANK[s.status];
  if (rank === undefined) return false;
  // Only move forward: never let a late "sent" overwrite "read", never revive a failure.
  const lower = Object.entries(STATUS_RANK)
    .filter(([, r]) => r < rank)
    .map(([k]) => k as "queued" | "sent" | "delivered");
  if (lower.length === 0) return false;
  const [row] = await db
    .update(inboxMessage)
    .set({
      status: s.status as "sent" | "delivered" | "read",
      ...(s.status === "delivered" ? { deliveredAt: at } : {}),
      ...(s.status === "read" ? { readAt: at, deliveredAt: sql`coalesce(${inboxMessage.deliveredAt}, ${ts(at)})` } : {}),
    })
    .where(and(eq(inboxMessage.waMessageId, s.id), inArray(inboxMessage.status, lower)))
    .returning({ id: inboxMessage.id, conversationId: inboxMessage.conversationId });
  if (row) await signalMessageStatus(db, row.conversationId, row.id);
  return !!row;
}

async function signalMessageStatus(db: DbExecutor, conversationId: string, messageId: string): Promise<void> {
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
  if (conv) await publishInboxEvent(db, signalFor("message.status", conv, messageId));
}

async function applyQualityUpdate(db: DbExecutor, value: WaChangeValue): Promise<void> {
  const display = value.display_phone_number;
  if (!display) return;
  const e164 = toE164(display);
  if (!e164) return;
  await db
    .update(inboxPhoneNumber)
    .set({
      ...(value.event ? { qualityRating: value.event } : {}),
      ...(value.current_limit ? { messagingLimit: value.current_limit } : {}),
      updatedAt: new Date(),
    })
    .where(eq(inboxPhoneNumber.e164, e164));
}

/** Attempts value that parks an event until its business number is added. */
export const PARKED_ATTEMPTS = 1000;

/**
 * Close out a stored webhook event after ingestWhatsAppPayload. Events that
 * mention a business number we don't know are parked (not dropped): adding the
 * number later calls unparkEventsForNumber() and the worker replays them.
 */
export async function finishWebhookEvent(db: DbExecutor, eventId: string, result: IngestResult): Promise<void> {

  if (result.unknownNumbers.length > 0) {
    await db
      .update(inboxWebhookEvent)
      .set({ attempts: PARKED_ATTEMPTS, lastError: `unknown_number:${result.unknownNumbers.join(",")}` })
      .where(eq(inboxWebhookEvent.id, eventId));
    return;
  }
  await db
    .update(inboxWebhookEvent)
    .set({ processedAt: new Date(), attempts: sql`${inboxWebhookEvent.attempts} + 1`, lastError: null })
    .where(eq(inboxWebhookEvent.id, eventId));
}

/** Re-queue parked events for a WhatsApp phone number ID that now exists. */
export async function unparkEventsForNumber(db: DbExecutor, waPhoneNumberId: string): Promise<number> {

  const rows = await db
    .update(inboxWebhookEvent)
    .set({ attempts: 0, lastError: null, receivedAt: sql`now() - interval '1 hour'` })
    .where(
      and(
        sql`${inboxWebhookEvent.processedAt} is null`,
        sql`${inboxWebhookEvent.lastError} like ${`unknown_number:%${waPhoneNumberId}%`}`,
      ),
    )
    .returning({ id: inboxWebhookEvent.id });
  return rows.length;
}
