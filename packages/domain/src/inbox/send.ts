/**
 * Send a WhatsApp message from a conversation, always from the business number
 * the conversation belongs to. Enforces the 24-hour window server-side: outside
 * it, only an approved template may go.
 */
import { eq } from "drizzle-orm";
import { customer, inboxConversation, inboxMessage, inboxPhoneNumber, inboxTemplate, type DbClient } from "@ms/db";
import { headerMediaLabel, messagePreview, templateNeeds, toE164, waIdFromE164, waWindowOpen, type TemplateNeeds } from "@ms/shared";
import { and } from "drizzle-orm";
import { MetaApiError, renderTemplateBody, sendMessage, type MetaConfig, type OutboundContent } from "./meta.js";
import { publishInboxEvent, signalFor, touchConversation } from "./core.js";

export class InboxSendError extends Error {
  constructor(
    public readonly code:
      | "window_closed"
      | "no_whatsapp"
      | "template_not_approved"
      /** The template has a part the inbox cannot send (carousel, login code, …). */
      | "template_unsupported"
      /** Something the template needs (a blank, a picture, a link ending) was not given. */
      | "template_incomplete"
      | "no_phone"
      | "not_configured",
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
  /**
   * Set for messages no person sent. Kept on the message (payload.auto) so the
   * timeline can label it and so the same automatic message is not sent twice.
   */
  auto?: "after_hours";
}

type TemplateContent = Extract<OutboundContent, { type: "template" }>;

/**
 * Check a template send against what the template needs, and return exactly
 * what should go to Meta (extras the template has no place for are dropped).
 * Throws a plain-English InboxSendError before anything is sent.
 */
export function prepareTemplateContent(needs: TemplateNeeds, content: TemplateContent): TemplateContent {
  if (!needs.sendable) {
    throw new InboxSendError("template_unsupported", needs.reason ?? "This template can't be sent from the inbox yet");
  }
  const out: TemplateContent = { type: "template", name: content.name, language: content.language };

  const body = (content.bodyParams ?? []).slice(0, needs.bodyParams);
  if (body.length < needs.bodyParams || body.some((p) => !p.trim())) {
    throw new InboxSendError("template_incomplete", "Fill in every blank in the message before sending");
  }
  if (body.length) out.bodyParams = body;

  if (needs.headerMedia) {
    const label = headerMediaLabel(needs.headerMedia);
    if (!content.headerMedia) {
      throw new InboxSendError("template_incomplete", `This template needs a ${label}. Add one, then send`);
    }
    if (content.headerMedia.type !== needs.headerMedia) {
      throw new InboxSendError("template_incomplete", `This template needs a ${label}, not a ${headerMediaLabel(content.headerMedia.type)}`);
    }
    out.headerMedia = content.headerMedia;
  } else if (needs.headerParams > 0) {
    if (!content.headerText?.trim()) {
      throw new InboxSendError("template_incomplete", "Fill in the blank in the heading before sending");
    }
    out.headerText = content.headerText.trim();
  }

  if (needs.urlButtons.length) {
    out.buttonParams = needs.urlButtons.map((b) => {
      const given = content.buttonParams?.find((p) => p.index === b.index)?.text.trim();
      if (!given) {
        throw new InboxSendError("template_incomplete", `Fill in the end of the link for the "${b.text}" button before sending`);
      }
      return { index: b.index, text: given };
    });
  }
  return out;
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
  let content = input.content;
  // A file is only kept on the message when it is really part of what is sent.
  let mediaKey = input.mediaKey ?? null;
  let mediaMime = input.mediaMime ?? null;
  let mediaFilename = "filename" in content ? (content.filename ?? null) : null;
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
    // Refuse what the inbox can't send, or what is missing, before calling Meta.
    const prepared = prepareTemplateContent(templateNeeds(tpl.components, tpl.category), input.content);
    content = prepared;
    if (prepared.headerMedia) {
      mediaFilename = prepared.headerMedia.filename ?? null;
    } else {
      mediaKey = null;
      mediaMime = null;
    }
    templateName = tpl.name;
    body = renderTemplateBody(tpl.components, prepared.bodyParams ?? []) ?? `Template: ${tpl.name}`;
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
      mediaKey,
      mediaMime,
      mediaFilename,
      status: "queued",
      senderUserId: input.userId,
      // Written with the row, before Meta is called: a crash mid-send leaves
      // the marker behind, so an automatic message is never sent twice.
      ...(input.auto ? { payload: { auto: input.auto } } : {}),
      createdAt: now,
    })
    .returning();

  let final: SentMessage;
  try {
    const wamid = await sendMessage(cfg, ctx.waPhoneNumberId, waIdFromE164(to), content);
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
          ...(input.auto ? { auto: input.auto } : {}),
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
  // An automatic reply leaves the list preview alone, so staff still see what
  // the customer wrote rather than our own canned text.
  const conv = await touchConversation(db, ctx.conv.id, input.auto ? { at: now } : { preview: messagePreview(type, body), at: now });
  await publishInboxEvent(db, signalFor("message.created", conv, final.id));
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
  return final;
}
