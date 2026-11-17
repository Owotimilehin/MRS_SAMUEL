/**
 * Send a WhatsApp message from a conversation, always from the business number
 * the conversation belongs to. Enforces the 24-hour window server-side: outside
 * it, only an approved template may go.
 */
import { eq } from "drizzle-orm";
import { customer, inboxConversation, inboxMessage, inboxPhoneNumber, inboxTemplate, type DbClient } from "@ms/db";
import { messagePreview, toE164, waIdFromE164, waWindowOpen } from "@ms/shared";
import { and } from "drizzle-orm";
import { MetaApiError, renderTemplateBody, sendMessage, type MetaConfig, type OutboundContent } from "./meta.js";
import { publishInboxEvent, signalFor, touchConversation } from "./core.js";

export class InboxSendError extends Error {
  constructor(
    public readonly code: "window_closed" | "no_whatsapp" | "template_not_approved" | "no_phone" | "not_configured",
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
  if (!cfg) throw new InboxSendError("not_configured", "WhatsApp is not configured on this server");

  const [ctx] = await db
    .select({
      conv: inboxConversation,
      waPhoneNumberId: inboxPhoneNumber.waPhoneNumberId,
      channels: inboxPhoneNumber.channels,
      wabaId: inboxPhoneNumber.wabaId,
      phone: customer.phone,
    })
    .from(inboxConversation)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
    .where(eq(inboxConversation.id, input.conversationId));
  if (!ctx) throw new InboxSendError("no_phone", "conversation not found");
  if (!ctx.waPhoneNumberId || ctx.channels === "voice") {
    throw new InboxSendError("no_whatsapp", "This business number has no WhatsApp");
  }
  const to = toE164(ctx.phone);
  if (!to) throw new InboxSendError("no_phone", "Customer has no usable phone number");

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
      senderUserId: input.userId,
      createdAt: now,
    })
    .returning();

  let final: SentMessage;
  try {
    const wamid = await sendMessage(cfg, ctx.waPhoneNumberId, waIdFromE164(to), input.content);
    [final] = (await db
      .update(inboxMessage)
      .set({ waMessageId: wamid, status: "sent" })
      .where(eq(inboxMessage.id, queued!.id))
      .returning()) as [SentMessage];
  } catch (err) {
    const e = err instanceof MetaApiError ? err : null;
    [final] = (await db
      .update(inboxMessage)
      .set({
        status: "failed",
        errorCode: e?.code ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
        // unconfirmed: it may have been delivered — staff should check before
        // resending. retryable: certainly not sent and worth another try.
        payload: {
          unconfirmed: e?.delivery === "unknown",
          retryable: e !== null && e.delivery === "not_sent" && e.retryable,
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
