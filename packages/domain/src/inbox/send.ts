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
  waFlow,
  type DbClient,
} from "@ms/db";
import {
  fitsTextLimit,
  flowDef,
  headerMediaLabel,
  humanAgentRemainingMs,
  isBsuid,
  messagePreview,
  templateNeeds,
  toE164,
  waIdFromE164,
  waWindowOpen,
  type TemplateNeeds,
} from "@ms/shared";
import { and, isNull, or, sql } from "drizzle-orm";
import { classifyMessagingError, sendMetaMessage, type MetaSendContent } from "../meta/messaging.js";
import { explainFlowError } from "../meta/flows.js";
import { makeFlowToken } from "../meta/flow-token.js";
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

/** Meta refusals of a form message that have a plain sentence of their own (suite spec 07, 5.3). */
const FLOW_SEND_CODES = new Set(["132068", "132069", "131047", "131026"]);

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
      /** The template has a part the inbox cannot send (carousel, login code, …). */
      | "template_unsupported"
      /** Something the template needs (a blank, a picture, a link ending) was not given. */
      | "template_incomplete"
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
  /**
   * Set for messages no person sent. Kept on the message (payload.auto) so the
   * timeline can label it and so the same automatic message is not sent twice.
   */
  auto?: "after_hours";
  /**
   * Extra facts kept on the message's payload from the moment it is queued, and kept if the send
   * fails (suite spec 07: `flow` says which form a message carries, so its answer can be matched).
   */
  payloadExtra?: Record<string, unknown>;
  /**
   * The secret that signs form tokens (the API's JWT_SIGNING_KEY). Needed only to send a template
   * whose button opens a form; without it such a template is refused before Meta is called.
   */
  flowTokenSecret?: string;
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
  // Form buttons carry our token (set by sendFromConversation); only the template's own form buttons are kept.
  if (needs.flowButtons.length && content.flowButtons?.length) {
    const kept = needs.flowButtons.flatMap((b) => content.flowButtons!.filter((f) => f.index === b.index).slice(0, 1));
    if (kept.length) out.flowButtons = kept;
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
  let content = input.content;
  // A file is only kept on the message when it is really part of what is sent.
  let mediaKey = input.mediaKey ?? null;
  let mediaMime = input.mediaMime ?? null;
  let mediaFilename = "filename" in content ? (content.filename ?? null) : null;
  // Set when a template's button opens a form: kept on the message so the answer is matched to the form.
  let templateFlow: Record<string, unknown> | null = null;
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
    const needs = templateNeeds(tpl.components, tpl.category);
    let templateContent = input.content;
    const formButton = needs.sendable ? needs.flowButtons[0] : undefined;
    if (formButton) {
      // A button that opens a form (suite spec 07, 5.5a): it must be one of ours and live, and it carries our token.
      const [flowRow] = formButton.flowId ? await db.select().from(waFlow).where(eq(waFlow.metaFlowId, formButton.flowId)) : [];
      const def = flowRow ? flowDef(flowRow.key) : null;
      if (!flowRow || !def) {
        throw new InboxSendError(
          "template_unsupported",
          "This template opens a form the suite does not know. Sync forms under Templates and forms, or use another template.",
        );
      }
      if (flowRow.status !== "PUBLISHED") {
        throw new InboxSendError("template_unsupported", "The form behind this template is not live at WhatsApp.");
      }
      if (!input.flowTokenSecret) {
        throw new InboxSendError("template_unsupported", "This template opens a form, so it can only be sent by a person from the inbox.");
      }
      const token = makeFlowToken(input.flowTokenSecret, def.key, ctx.conv.id, now);
      templateContent = { ...input.content, flowButtons: [{ index: formButton.index, flowToken: token }] };
      templateFlow = { key: def.key, flow_row_id: flowRow.id, token, title: def.title, cta: formButton.text };
    }
    const prepared = prepareTemplateContent(needs, templateContent);
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
    body =
      input.content.type === "text" || input.content.type === "flow" ? input.content.body : (input.content.caption ?? null);
  }
  const payloadExtra: Record<string, unknown> = { ...(input.payloadExtra ?? {}), ...(templateFlow ? { flow: templateFlow } : {}) };
  const hasExtra = (): boolean => Object.keys(payloadExtra).length > 0;

  const type = input.content.type;
  const carriesForm = type === "flow" || "flow" in payloadExtra;
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
      channel: "whatsapp",
      senderUserId: input.userId,
      // Written with the row, before Meta is called: a crash mid-send leaves
      // the marker behind, so an automatic message is never sent twice.
      ...(input.auto || hasExtra() ? { payload: { ...payloadExtra, ...(input.auto ? { auto: input.auto } : {}) } } : {}),
      createdAt: now,
    })
    .returning();

  let final: SentMessage;
  try {
    const wamid = await sendMessage(cfg, waNumberId, to, content);
    [final] = (await db
      .update(inboxMessage)
      .set({ waMessageId: wamid, status: "sent" })
      .where(eq(inboxMessage.id, queued!.id))
      .returning()) as [SentMessage];
  } catch (err) {
    const e = err instanceof MetaApiError ? err : null;
    const metaMessage = err instanceof Error ? err.message : String(err);
    const bsuidRefused = e?.code === BSUID_NOT_SUPPORTED;
    // A form that Meta blocked, throttled or could not show: say so in plain words, keep Meta's own.
    const flowRefused = carriesForm && e !== null && e.code !== null && FLOW_SEND_CODES.has(e.code);
    [final] = (await db
      .update(inboxMessage)
      .set({
        status: "failed",
        errorCode: e?.code ?? null,
        errorMessage: bsuidRefused ? BSUID_NOT_SUPPORTED_TEXT : flowRefused ? explainFlowError(e) : metaMessage,
        // unconfirmed: it may have been delivered — staff should check before
        // resending. retryable: certainly not sent and worth another try.
        payload: {
          ...payloadExtra,
          ...(input.auto ? { auto: input.auto } : {}),
          unconfirmed: e?.delivery === "unknown",
          retryable: e !== null && e.delivery === "not_sent" && e.retryable,
          ...(bsuidRefused || flowRefused ? { meta_message: metaMessage } : {}),
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
  if (content.type === "flow") throw new InboxSendError("not_supported", "Forms are only for WhatsApp.");
  // The out-of-hours reply (inbox-gaps) is WhatsApp-only; its job never picks these threads, and this keeps it so.
  if (input.auto) throw new InboxSendError("not_supported", "Automatic replies are only for WhatsApp.");
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
