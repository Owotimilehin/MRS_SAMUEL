/**
 * Send a WhatsApp message from a conversation, always from the business number
 * the conversation belongs to. Enforces the 24-hour window server-side: outside
 * it, only an approved template may go.
 */
import { eq } from "drizzle-orm";
import {
  customer,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  type DbClient,
} from "@ms/db";
import { fitsTextLimit, humanAgentRemainingMs, isBsuid, messagePreview, toE164, waIdFromE164, waWindowOpen } from "@ms/shared";
import { and, isNull, or, sql } from "drizzle-orm";
import { classifyMessagingError, sendMetaMessage, type MetaSendContent } from "../meta/messaging.js";
import {
  MetaApiError,
  renderTemplateBody,
  sendMessage,
  type MetaConfig,
  type OutboundContent,
  type WaRecipient,
} from "./meta.js";

/** Meta error 131062: this message can't go to a customer known only by their user ID (spec 01, M14). */
const BSUID_NOT_SUPPORTED = "131062";
const BSUID_NOT_SUPPORTED_TEXT =
  "Not sent: WhatsApp can't deliver this kind of message to a customer who has hidden their number.";

/**
 * Who a WhatsApp reply goes to (rule R13), first match wins: the
 * conversation's WhatsApp identity (its digits, or its BSUID); else, for a
 * thread with no identity, the customer's phone as before.
 */
export function whatsappRecipient(
  identity: { channel: string | null; externalId: string | null } | null,
  customerPhone: string | null,
): WaRecipient | null {
  if (identity?.channel === "whatsapp" && identity.externalId) {
    if (/^\d{8,15}$/.test(identity.externalId)) return identity.externalId;
    if (isBsuid(identity.externalId)) return { bsuid: identity.externalId };
  }
  const e164 = toE164(customerPhone);
  return e164 ? waIdFromE164(e164) : null;
}
import { publishInboxEvent, signalFor, touchConversation } from "./core.js";

export class InboxSendError extends Error {
  constructor(
    public readonly code:
      | "window_closed"
      | "no_whatsapp"
      | "template_not_approved"
      | "no_phone"
      | "not_configured"
      | "not_supported"
      | "too_long"
      | "no_recipient"
      | "account_off",
    message: string,
  ) {
    super(message);
    this.name = "InboxSendError";
  }
}

export interface SendInput {
  conversationId: string;
  /** Staff member sending; null for automatic sends (missed-call follow-up). */
  userId: string | null;
  content: OutboundContent;
  /** Storage key of an outgoing file, kept so the timeline can show it. */
  mediaKey?: string | null;
  mediaMime?: string | null;
}

export type SentMessage = typeof inboxMessage.$inferSelect;

export async function sendFromConversation(
  db: DbClient,
  cfg: MetaConfig | null,
  input: SendInput,
  now: Date = new Date(),
): Promise<SentMessage> {
  // The only send function (ruling 9.2.6): Messenger and Instagram threads take their own branch.
  const [route] = await db
    .select({ channel: inboxConversation.channel, kind: inboxPhoneNumber.kind })
    .from(inboxConversation)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .where(eq(inboxConversation.id, input.conversationId));
  if (route && route.kind !== "phone" && (route.channel === "messenger" || route.channel === "instagram")) {
    return sendMetaFromConversation(db, cfg, input, route.channel, now);
  }

  if (!cfg) throw new InboxSendError("not_configured", "WhatsApp is not configured on this server");

  const [ctx] = await db
    .select({
      conv: inboxConversation,
      waPhoneNumberId: inboxPhoneNumber.waPhoneNumberId,
      channels: inboxPhoneNumber.channels,
      kind: inboxPhoneNumber.kind,
      wabaId: inboxPhoneNumber.wabaId,
      phone: customer.phone,
      identityChannel: inboxIdentity.channel,
      identityExternalId: inboxIdentity.externalId,
    })
    .from(inboxConversation)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
    .leftJoin(inboxIdentity, eq(inboxIdentity.id, inboxConversation.identityId))
    .where(eq(inboxConversation.id, input.conversationId));
  if (!ctx) throw new InboxSendError("no_phone", "conversation not found");
  // spec 02 replaces this branch with Messenger and Instagram sending.
  if (ctx.kind !== "phone") throw new InboxSendError("no_whatsapp", "This channel can't send yet");
  if (!ctx.waPhoneNumberId || ctx.channels === "voice") {
    throw new InboxSendError("no_whatsapp", "This business number has no WhatsApp");
  }
  const waNumberId = ctx.waPhoneNumberId;
  const to = whatsappRecipient(
    ctx.identityChannel ? { channel: ctx.identityChannel, externalId: ctx.identityExternalId } : null,
    ctx.phone,
  );
  if (!to) throw new InboxSendError("no_phone", "This customer has no phone number or WhatsApp ID to send to");

  let body: string | null = null;
  let templateName: string | null = null;
  if (input.content.type === "template") {
    const [tpl] = await db
      .select()
      .from(inboxTemplate)
      .where(
        and(
          eq(inboxTemplate.name, input.content.name),
          eq(inboxTemplate.language, input.content.language),
          ...(ctx.wabaId ? [eq(inboxTemplate.wabaId, ctx.wabaId)] : []),
        ),
      );
    if (!tpl || tpl.status.toUpperCase() !== "APPROVED") {
      throw new InboxSendError("template_not_approved", `Template ${input.content.name} is not approved`);
    }
    templateName = tpl.name;
    body = renderTemplateBody(tpl.components, input.content.bodyParams ?? []) ?? `Template: ${tpl.name}`;
  } else {
    if (!waWindowOpen(ctx.conv.lastInboundWaAt, now)) {
      throw new InboxSendError(
        "window_closed",
        "More than 24 hours since the customer's last message — send a template instead",
      );
    }
    body = input.content.type === "text" ? input.content.body : (input.content.caption ?? null);
  }

  const type = input.content.type;
  const [queued] = await db
    .insert(inboxMessage)
    .values({
      conversationId: ctx.conv.id,
      direction: "out",
      type,
      body,
      templateName,
      mediaKey: input.mediaKey ?? null,
      mediaMime: input.mediaMime ?? null,
      mediaFilename: "filename" in input.content ? (input.content.filename ?? null) : null,
      status: "queued",
      channel: "whatsapp",
      senderUserId: input.userId,
      createdAt: now,
    })
    .returning();

  let final: SentMessage;
  try {
    const wamid = await sendMessage(cfg, waNumberId, to, input.content);
    [final] = (await db
      .update(inboxMessage)
      .set({ waMessageId: wamid, status: "sent" })
      .where(eq(inboxMessage.id, queued!.id))
      .returning()) as [SentMessage];
  } catch (err) {
    const e = err instanceof MetaApiError ? err : null;
    const metaMessage = err instanceof Error ? err.message : String(err);
    const bsuidRefused = e?.code === BSUID_NOT_SUPPORTED;
    [final] = (await db
      .update(inboxMessage)
      .set({
        status: "failed",
        errorCode: e?.code ?? null,
        errorMessage: bsuidRefused ? BSUID_NOT_SUPPORTED_TEXT : metaMessage,
        // unconfirmed: it may have been delivered — staff should check before
        // resending. retryable: certainly not sent and worth another try.
        payload: {
          unconfirmed: e?.delivery === "unknown",
          retryable: e !== null && e.delivery === "not_sent" && e.retryable,
          ...(bsuidRefused ? { meta_message: metaMessage } : {}),
        },
      })
      .where(eq(inboxMessage.id, queued!.id))
      .returning()) as [SentMessage];
  }

  const isFirstStaffReply = input.userId !== null && !ctx.conv.firstResponseAt && final.status !== "failed";
  // Auto-assign an unassigned thread to whoever replies first.
  const claim = input.userId !== null && !ctx.conv.assigneeId;
  if (isFirstStaffReply || claim) {
    await db
      .update(inboxConversation)
      .set({
        ...(isFirstStaffReply ? { firstResponseAt: now } : {}),
        ...(claim ? { assigneeId: input.userId } : {}),
      })
      .where(eq(inboxConversation.id, ctx.conv.id));
  }
  const conv = await touchConversation(db, ctx.conv.id, { preview: messagePreview(type, body), at: now });
  await publishInboxEvent(db, signalFor("message.created", conv, final.id));
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
  return final;
}

// ── Messenger and Instagram (suite spec 02, 5.5) ────────────────────────────

/** Waits before the second and third try of a temporary Meta failure (rule R19). Exported so tests can shorten them. */
export const META_SEND_RETRY_DELAYS_MS = [1_000, 3_000];

function channelName(channel: "messenger" | "instagram"): string {
  return channel === "messenger" ? "Messenger" : "Instagram";
}

/** "<code>/<subcode>", or just the code. */
function metaErrorCode(e: MetaApiError | null): string | null {
  if (!e?.code) return null;
  return e.subcode ? `${e.code}/${e.subcode}` : e.code;
}

async function sendMetaFromConversation(
  db: DbClient,
  cfg: MetaConfig | null,
  input: SendInput,
  channel: "messenger" | "instagram",
  now: Date,
): Promise<SentMessage> {
  const name = channelName(channel);
  // 1. Meta set up on this server at all?
  if (!cfg) throw new InboxSendError("not_configured", "Meta is not connected on this server");

  // 2. The thread, its line and who it is with.
  const [ctx] = await db
    .select({
      conv: inboxConversation,
      lineId: inboxPhoneNumber.id,
      pageId: inboxPhoneNumber.pageExternalId,
      lineExternalId: inboxPhoneNumber.externalId,
      label: inboxPhoneNumber.label,
      isActive: inboxPhoneNumber.isActive,
      problemText: inboxPhoneNumber.problemText,
      identityChannel: inboxIdentity.channel,
      identityAccount: inboxIdentity.accountExternalId,
      identityExternalId: inboxIdentity.externalId,
    })
    .from(inboxConversation)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .leftJoin(inboxIdentity, eq(inboxIdentity.id, inboxConversation.identityId))
    .where(eq(inboxConversation.id, input.conversationId));
  if (!ctx) throw new InboxSendError("no_recipient", "conversation not found");
  if (!ctx.isActive) {
    throw new InboxSendError("account_off", `${ctx.label} is switched off. Switch it on under Channels to reply.`);
  }
  if (!ctx.pageId || !ctx.lineExternalId) throw new InboxSendError("account_off", `${ctx.label} is not connected to a Facebook Page.`);

  // 3. Recipient: the thread's identity on this channel and account, else the customer's latest one there.
  let recipient: string | null =
    ctx.identityChannel === channel && ctx.identityAccount === ctx.lineExternalId ? ctx.identityExternalId : null;
  if (!recipient) {
    const [latest] = await db
      .select({ externalId: inboxIdentity.externalId })
      .from(inboxIdentity)
      .where(
        and(
          eq(inboxIdentity.customerId, ctx.conv.customerId),
          eq(inboxIdentity.channel, channel),
          eq(inboxIdentity.accountExternalId, ctx.lineExternalId),
        ),
      )
      .orderBy(sql`${inboxIdentity.lastSeenAt} desc nulls last`)
      .limit(1);
    recipient = latest?.externalId ?? null;
  }
  if (!recipient) {
    throw new InboxSendError("no_recipient", `We don't have this person's ${name} details yet. They need to write first.`);
  }

  // 4–6. What this channel can carry (rule R16: refused before anything is written).
  const content = input.content;
  if (content.type === "template") throw new InboxSendError("not_supported", "Templates are only for WhatsApp.");
  if (content.type !== "text" && content.caption) {
    throw new InboxSendError(
      "not_supported",
      `${name} can't send a caption with a file. Send the text as its own message.`,
    );
  }
  if (content.type === "text" && !fitsTextLimit(channel, content.body)) {
    throw new InboxSendError("too_long", `That is too long for ${name}. Shorten it or send it in two parts.`);
  }

  // 7. The reply window (rule R17): 24 hours; up to 7 days by hand with Human Agent on.
  let humanAgent = false;
  if (!waWindowOpen(ctx.conv.lastInboundWaAt, now)) {
    if (cfg.humanAgent === true && input.userId !== null && humanAgentRemainingMs(ctx.conv.lastInboundWaAt, now) > 0) {
      humanAgent = true;
    } else {
      throw new InboxSendError(
        "window_closed",
        `More than 24 hours since the customer last wrote. On ${name} you can reply again once they write.`,
      );
    }
  }

  // 8. The local row first, so a crash mid-send never loses or doubles a message (foundation rule 9).
  const body = content.type === "text" ? content.body : null;
  const basePayload: Record<string, unknown> = humanAgent ? { tag: "HUMAN_AGENT" } : {};
  const [queued] = await db
    .insert(inboxMessage)
    .values({
      conversationId: ctx.conv.id,
      direction: "out",
      type: content.type,
      body,
      mediaKey: input.mediaKey ?? null,
      mediaMime: input.mediaMime ?? null,
      mediaFilename: "filename" in content ? (content.filename ?? null) : null,
      status: "queued",
      channel,
      senderUserId: input.userId,
      payload: humanAgent ? basePayload : null,
      createdAt: now,
    })
    .returning();

  // 9. Send, retrying temporary trouble twice (rule R19). An unknown outcome is never retried.
  const metaContent: MetaSendContent = content.type === "text" ? { type: "text", body: content.body } : { type: content.type, link: content.link };
  const opts = { humanAgent, ...(channel === "messenger" ? { metadata: `suite:${queued!.id}` } : {}) };
  let mid: string | null = null;
  let failure: MetaApiError | Error | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      mid = await sendMetaMessage(cfg, ctx.pageId, recipient, metaContent, opts);
      failure = null;
      break;
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      const e = err instanceof MetaApiError ? err : null;
      const temporary = e !== null && e.delivery === "not_sent" && classifyMessagingError(e, name, ctx.label).cls === "temporary";
      if (!temporary || attempt >= META_SEND_RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, META_SEND_RETRY_DELAYS_MS[attempt]));
    }
  }

  let final: SentMessage;
  if (mid) {
    // 10. The echo may already have filled the mid and moved the status on; never move it back.
    const [row] = (await db
      .update(inboxMessage)
      .set({
        waMessageId: mid,
        status: sql`case when ${inboxMessage.status} in ('queued','failed') then 'sent'::inbox_message_status else ${inboxMessage.status} end`,
      })
      .where(and(eq(inboxMessage.id, queued!.id), or(isNull(inboxMessage.waMessageId), eq(inboxMessage.waMessageId, mid))))
      .returning()) as SentMessage[];
    final = row ?? (await db.select().from(inboxMessage).where(eq(inboxMessage.id, queued!.id)))[0]!;
    if (ctx.problemText !== null) {
      await db
        .update(inboxPhoneNumber)
        .set({ problemCode: null, problemText: null, problemAt: null, updatedAt: now })
        .where(eq(inboxPhoneNumber.id, ctx.lineId));
    }
  } else {
    // 11. Plain words from table 3.5; Meta's own code and message kept for support.
    const e = failure instanceof MetaApiError ? failure : null;
    const cls = e
      ? classifyMessagingError(e, name, ctx.label)
      : { cls: "refusal" as const, staffText: `${name} refused this message.`, retryable: false };
    const code = metaErrorCode(e);
    [final] = (await db
      .update(inboxMessage)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: cls.staffText,
        payload: {
          ...basePayload,
          unconfirmed: e?.delivery === "unknown",
          retryable: cls.retryable,
          meta_message: failure?.message ?? null,
          ...(cls.cls === "config" ? { config: true, account: ctx.lineExternalId } : {}),
        },
      })
      .where(eq(inboxMessage.id, queued!.id))
      .returning()) as [SentMessage];
    if (cls.cls === "config") {
      // Rule R20: mark the line; the caller raises the owner alert (payload.config).
      await db
        .update(inboxPhoneNumber)
        .set({ problemCode: code, problemText: cls.staffText, problemAt: now, updatedAt: now })
        .where(eq(inboxPhoneNumber.id, ctx.lineId));
    }
  }

  // 12. Exactly as the WhatsApp branch.
  const isFirstStaffReply = input.userId !== null && !ctx.conv.firstResponseAt && final.status !== "failed";
  const claim = input.userId !== null && !ctx.conv.assigneeId;
  if (isFirstStaffReply || claim) {
    await db
      .update(inboxConversation)
      .set({
        ...(isFirstStaffReply ? { firstResponseAt: now } : {}),
        ...(claim ? { assigneeId: input.userId } : {}),
      })
      .where(eq(inboxConversation.id, ctx.conv.id));
  }
  const conv = await touchConversation(db, ctx.conv.id, { preview: messagePreview(content.type, body), at: now });
  await publishInboxEvent(db, signalFor("message.created", conv, final.id));
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
  return final;
}
