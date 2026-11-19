/**
 * Turn a Meta WhatsApp webhook payload into inbox rows.
 *
 * Idempotent: messages are keyed on wa_message_id (Meta retries webhooks, and
 * the worker replays stored ones), statuses only move forward.
 *
 * Media is NOT downloaded here — the message is saved with media_id and the
 * worker fetches it (Meta's URLs are short-lived; the worker retries).
 */
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import {
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxWebhookEvent,
  type DbExecutor,
} from "@ms/db";
import { isBsuid, messagePreview, toE164, WHATSAPP_ACCOUNT_KEY } from "@ms/shared";
import { applyTemplateWebhook, TEMPLATE_WEBHOOK_FIELDS, wabaIsOurs } from "../meta/templates.js";
import { parseFlowReply, recordFlowResponse } from "../meta/flow-responses.js";
import { applyFlowWebhook } from "../meta/flows.js";
import { applyConsentKeyword, applyUserPreference } from "../contacts/consent.js";
import { findOrOpenConversation, publishInboxEvent, resolveWhatsAppCustomer, signalFor, touchConversation, ts } from "./core.js";
import { noteChatOrderMessage, parseOrderMessage } from "../meta/catalogue-chat.js";

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
  /** The sender's phone number (wa_id). Meta may leave it out when the customer uses a username (spec 01, M12). */
  from?: string;
  /** The sender's business-scoped user ID (BSUID), e.g. "US.1349…". */
  from_user_id?: string;
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
    /** A completed WhatsApp form (Flow); `response_json` is JSON as a string (suite spec 07). */
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  context?: { id?: string };
  /** type "system": the customer changed their number or their user ID. */
  system?: { type?: string; body?: string; user_id?: string; previous_user_id?: string; wa_id?: string };
  /** Some system messages may carry these at the top level instead (read defensively; rule R16). */
  user_id?: string;
  previous_user_id?: string;
  /** type "order": a cart sent from the catalogue (suite spec 08). item_price is Meta's, for display only. */
  order?: {
    catalog_id?: string;
    text?: string;
    product_items?: { product_retailer_id?: string; quantity?: number; item_price?: number; currency?: string }[];
  };
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
  contacts?: { profile?: { name?: string; username?: string }; wa_id?: string; user_id?: string }[];
  messages?: WaInboundMessage[];
  statuses?: WaStatus[];
  // phone_number_quality_update / account updates
  display_phone_number?: string;
  event?: string;
  current_limit?: string;
}

export interface WaWebhookPayload {
  object?: string;
  entry?: { id?: string; time?: number; changes?: { field?: string; value?: WaChangeValue }[] }[];
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
      body =
        m.interactive?.type === "nfm_reply"
          ? "Completed a form"
          : (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null);
      break;
    case "reaction":
      body = m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : "Removed a reaction";
      break;
    case "contacts": {
      const c = m.contacts?.[0];
      body = [c?.name?.formatted_name, c?.phones?.[0]?.phone].filter(Boolean).join(" ") || "Shared a contact";
      break;
    }
    case "system":
      body = m.system?.body ?? "WhatsApp updated this customer's details.";
      break;
    case "order": {
      // A cart from the catalogue (suite spec 08). Only a summary is kept here; the cart itself goes to catalogue_chat_order.
      const lines = parseOrderMessage(m)?.lines ?? [];
      const n = lines.length;
      const units = lines.reduce((sum, l) => sum + l.quantity, 0);
      const text = m.order?.text?.trim();
      type = "order";
      body = `Sent a cart: ${n} item${n === 1 ? "" : "s"}, ${units} bottle${units === 1 ? "" : "s"}${text ? ` — "${text}"` : ""}`;
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

/** When Meta says the entry happened (unix seconds), else now. */
function entryTime(entry: { time?: number }): Date {
  return typeof entry.time === "number" && entry.time > 0 ? new Date(entry.time * 1000) : new Date();
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
  /** Template status, quality or category events applied to a row (suite spec 06). */
  templatesUpdated: number;
  /** WhatsApp accounts that sent an event for a template we do not hold: sync each once after the commit. */
  templateResyncWabas: string[];
  /** `flows` webhook events applied to a form we hold (suite spec 07). */
  flowsUpdated: number;
  /** Form events that are only worth a log line (CLIENT_ERROR_RATE). */
  flowNotices: string[];
}

/**
 * Apply one webhook payload. Run it inside a transaction so the rows and the
 * real-time signals land together. Unknown business numbers are reported (not
 * thrown) so other entries in the same payload still process.
 */
export async function ingestWhatsAppPayload(db: DbExecutor, payload: WaWebhookPayload): Promise<IngestResult> {
  const result: IngestResult = { messagesCreated: 0, statusesApplied: 0, unknownNumbers: [], templatesUpdated: 0, templateResyncWabas: [], flowsUpdated: 0, flowNotices: [] };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      if (change.field === "phone_number_quality_update") {
        await applyQualityUpdate(db, value);
        continue;
      }
      if ((TEMPLATE_WEBHOOK_FIELDS as readonly string[]).includes(change.field ?? "")) {
        // Template review, quality and category news. Events for an account we do not hold are ignored.
        const known = entry.id ? await wabaIsOurs(db, entry.id) : false;
        if (known) {
          const r = await applyTemplateWebhook(
            db,
            entry.id!,
            change.field!,
            value as unknown as Record<string, unknown>,
            entryTime(entry),
          );
          if (r.applied) result.templatesUpdated++;
          if (r.resync && !result.templateResyncWabas.includes(entry.id!)) result.templateResyncWabas.push(entry.id!);
        }
        continue;
      }
      if (change.field === "flows") {
        // Form status and endpoint health (suite spec 07). An event for a form we do not hold is ignored.
        const r = await applyFlowWebhook(db, value as unknown as Record<string, unknown>, entryTime(entry));
        if (r.applied || r.alerted) result.flowsUpdated++;
        if (r.event === "CLIENT_ERROR_RATE") result.flowNotices.push(r.event);
        continue;
      }
      if (change.field === "user_preferences") {
        // The customer stopped or resumed promotions from us in WhatsApp's own settings (suite spec 14, R31).
        for (const p of (value as { user_preferences?: unknown[] }).user_preferences ?? []) {
          await applyUserPreference(db, p as never);
        }
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

      // Profile name and username, keyed by both the phone (wa_id) and the BSUID (user_id).
      const names = new Map<string, string>();
      const usernames = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        for (const key of [c.wa_id, c.user_id]) {
          if (!key) continue;
          if (c.profile?.name) names.set(key, c.profile.name);
          if (c.profile?.username) usernames.set(key, c.profile.username);
        }
      }
      const lookup = (map: Map<string, string>, m: WaInboundMessage): string | null =>
        (m.from ? map.get(m.from) : undefined) ?? (m.from_user_id ? map.get(m.from_user_id) : undefined) ?? null;

      for (const m of value.messages ?? []) {
        if (await ingestMessage(db, number.id, m, lookup(names, m), lookup(usernames, m))) result.messagesCreated++;
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
  username: string | null,
): Promise<boolean> {
  // Cheap duplicate check before creating any customer/conversation rows.
  const [dupe] = await db.select({ id: inboxMessage.id }).from(inboxMessage).where(eq(inboxMessage.waMessageId, m.id));
  if (dupe) return false;

  // A customer who uses a WhatsApp username may arrive with no phone number,
  // only a business-scoped user ID (rule R14). Neither → nothing identifies them.
  const phone = m.from ? toE164(m.from) : null;
  const userId = m.from_user_id && isBsuid(m.from_user_id) ? m.from_user_id : null;
  if (!phone && !userId) return false;

  if (m.type === "system") await applySystemChange(db, m);

  const who = await resolveWhatsAppCustomer(db, { phone, userId, name: profileName, username });
  const { conversation } = await findOrOpenConversation(db, who.customerId, phoneNumberId, undefined, {
    identityId: who.identityId,
  });
  const parsed = parseInbound(m);
  const at = tsToDate(m.timestamp);
  // A system notice ("changed their number") is not the customer writing: it
  // does not open the 24-hour window or count as unread.
  const fromCustomer = parsed.type !== "system";

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
      channel: "whatsapp",
      waMessageId: m.id,
      status: "received",
      payload: m as unknown as Record<string, unknown>,
      createdAt: at,
    })
    .onConflictDoNothing({ target: inboxMessage.waMessageId })
    .returning({ id: inboxMessage.id });
  if (!row) return false;

  // STOP and START (suite spec 14, R27). The message is stored, shown and counted
  // as unread exactly as any other; this only records the customer's wish and
  // marks the message so the out-of-hours reply is not sent on top of the
  // confirmation. The customer row itself is never changed.
  if (fromCustomer) {
    const kw = await applyConsentKeyword(db, {
      customerId: who.customerId,
      messageId: row.id,
      type: parsed.type,
      body: parsed.body,
      at,
    });
    if (kw) {
      await db
        .update(inboxMessage)
        .set({ payload: sql`coalesce(${inboxMessage.payload}, '{}'::jsonb) || ${JSON.stringify({ _suite: { consent: kw } })}::jsonb` })
        .where(eq(inboxMessage.id, row.id));
    }
  }

  // A completed form (suite spec 07): keep the answers beside the message, name the form in the
  // body and the list preview, and label the chat. Nothing is sent and no contact is changed.
  let previewBody = parsed.body;
  const reply = parseFlowReply(m);
  if (reply) {
    const recorded = await recordFlowResponse(db, {
      messageId: row.id,
      conversationId: conversation.id,
      contextWaMessageId: m.context?.id ?? null,
      reply,
    });
    previewBody = `Completed form: ${recorded.title}`;
    await db.update(inboxMessage).set({ body: previewBody }).where(eq(inboxMessage.id, row.id));
    if (recorded.label) {
      const label = recorded.label.toLowerCase();
      await db
        .update(inboxConversation)
        .set({ labels: sql`array_append(${inboxConversation.labels}, ${label})` })
        .where(and(eq(inboxConversation.id, conversation.id), sql`not (${label} = any(${inboxConversation.labels}))`));
    }
  }

  // Selling in chat (suite spec 08): a cart is recorded once; any other message may be the
  // customer's answer to "delivery or pickup?" or their address. Same transaction, no network
  // call, and it can never stop the message itself from being saved.
  await noteChatOrderMessage(db, { conversationId: conversation.id, customerId: who.customerId, message: m });

  const conv = await touchConversation(db, conversation.id, {
    preview: messagePreview(parsed.type, previewBody),
    ...(fromCustomer ? { inboundWa: at, unreadIncrement: true } : {}),
    at,
  });
  await publishInboxEvent(db, { ...signalFor("message.created", conv, row.id), direction: "in" });
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
  return true;
}

/**
 * Rule R16. `user_changed_user_id`: when both IDs are BSUIDs, an identity
 * exists for the old one and none for the new one, re-key it so the next
 * message lands on the same contact. `user_changed_number`: nothing (the new
 * number gets its own identity when it writes; staff merge if needed).
 */
async function applySystemChange(db: DbExecutor, m: WaInboundMessage): Promise<void> {
  const previous = m.system?.previous_user_id ?? m.previous_user_id;
  const next = m.system?.user_id ?? m.user_id;
  const kind = m.system?.type ?? (previous && next ? "user_changed_user_id" : undefined);
  if (kind !== "user_changed_user_id") return;
  if (!previous || !next || previous === next || !isBsuid(previous) || !isBsuid(next)) return;
  const sameKey = (externalId: string) =>
    and(
      eq(inboxIdentity.channel, "whatsapp"),
      eq(inboxIdentity.accountExternalId, WHATSAPP_ACCOUNT_KEY),
      eq(inboxIdentity.externalId, externalId),
    );
  const newer = db.select({ id: inboxIdentity.id }).from(inboxIdentity).where(sameKey(next));
  await db
    .update(inboxIdentity)
    .set({ externalId: next, updatedAt: new Date() })
    .where(and(sameKey(previous), notExists(newer)));
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
