/**
 * Send a WhatsApp message from a conversation, always from the business number
 * the conversation belongs to. Enforces the 24-hour window server-side: outside
 * it, only an approved template may go.
 */
import { eq } from "drizzle-orm";
import {
  appSetting,
  broadcast,
  broadcastRecipient,
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
  BROADCAST_CALLBACK_PREFIX,
  BROADCAST_CATEGORIES,
  BROADCAST_SETTINGS_KEY,
  fitsTextLimit,
  flowDef,
  headerMediaLabel,
  humanAgentRemainingMs,
  isBsuid,
  messagePreview,
  readBroadcastSettings,
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
      | "account_off"
      /** A broadcast send while the owner switch is off, or while the broadcast is not sending (suite spec 14). */
      | "broadcast_off"
      /** A broadcast send for a recipient that is not claimed, or that already has a message: never sent twice. */
      | "broadcast_duplicate",
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
   * "opt_out" / "opt_in": the one answer to a customer's own STOP or START (suite spec 14, R29).
   * "broadcast": one recipient's turn in a WhatsApp broadcast (suite spec 14, Phase B); needs `broadcast`.
   */
  auto?: "after_hours" | "opt_out" | "opt_in" | "broadcast";
  /**
   * Which broadcast and which recipient row this send is for. The message goes to the number
   * fixed on that row at confirmation. The send is refused, before Meta is called, unless the
   * owner switch is on, the broadcast is sending, and the row is claimed and has no message yet.
   * `noCallback`: leave out the callback value (Meta refused it earlier in this broadcast).
   */
  broadcast?: { broadcastId: string; recipientId: string; route: "cloud" | "mm"; noCallback?: boolean };
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

const BROADCASTS_OFF_TEXT = "Broadcasts are switched off. The owner can switch them on in Broadcast settings.";

/**
 * The gate every broadcast send passes (suite spec 14, rules R40, R56, R57). Reads only; throws
 * before anything is written or sent. Returns the number fixed on the recipient row.
 */
async function broadcastGate(
  db: DbClient,
  input: SendInput,
  linePhoneNumberId: string,
): Promise<{ to: WaRecipient; broadcastId: string; recipientId: string; route: "cloud" | "mm"; noCallback: boolean }> {
  const b = input.broadcast;
  if (!b) throw new InboxSendError("broadcast_off", "A broadcast send must name its broadcast and recipient");
  if (input.userId !== null) throw new InboxSendError("not_supported", "A broadcast send is made by the worker, not in a person's name");
  if (input.content.type !== "template") throw new InboxSendError("not_supported", "A broadcast can only send an approved template");
  const [setting] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, BROADCAST_SETTINGS_KEY));
  if (!readBroadcastSettings(setting?.value).enabled) throw new InboxSendError("broadcast_off", BROADCASTS_OFF_TEXT);
  const [row] = await db.select().from(broadcast).where(eq(broadcast.id, b.broadcastId));
  if (!row || row.status !== "sending" || row.phoneNumberId !== linePhoneNumberId) {
    throw new InboxSendError("broadcast_off", "This broadcast is not sending");
  }
  const [r] = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.id, b.recipientId));
  if (!r || r.broadcastId !== row.id || r.state !== "sending" || r.messageId) {
    throw new InboxSendError("broadcast_duplicate", "This person's message has already been handled; it is not sent again");
  }
  const toWa = r.toWa ?? "";
  const to: WaRecipient | null = /^\d{8,15}$/.test(toWa) ? toWa : isBsuid(toWa) ? { bsuid: toWa } : null;
  if (!to) throw new InboxSendError("no_phone", "This person has no WhatsApp number to send to");
  return { to, broadcastId: row.id, recipientId: r.id, route: b.route, noCallback: b.noCallback === true };
}

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
  // A broadcast send (suite spec 14, Phase B) goes to the number fixed on its recipient row at
  // confirmation, and is refused here, before anything is written or sent, unless the owner
  // switch is on, the broadcast is sending and the row is claimed with no message yet.
  const bc = input.auto === "broadcast" ? await broadcastGate(db, input, ctx.conv.phoneNumberId) : null;
  if (input.broadcast && !bc) throw new InboxSendError("not_supported", "Only a broadcast send may name a broadcast");
  const to = bc
    ? bc.to
    : whatsappRecipient(
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
  let templateCategory = "";
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
    // A broadcast carries promotions and updates only (rule R41); anything else is refused before Meta is called.
    if (bc && !(BROADCAST_CATEGORIES as readonly string[]).includes((tpl.category ?? "").toUpperCase())) {
      throw new InboxSendError("template_unsupported", "Only promotion and update templates can be broadcast");
    }
    templateCategory = (tpl.category ?? "").toUpperCase();
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
      input.content.type === "text" || input.content.type === "flow"
        ? input.content.body
        : input.content.type === "interactive"
          ? input.content.preview
          : (input.content.caption ?? null);
  }
  const payloadExtra: Record<string, unknown> = {
    ...(input.payloadExtra ?? {}),
    ...(templateFlow ? { flow: templateFlow } : {}),
    // Which broadcast and recipient this message belongs to, kept from the moment it is queued.
    ...(bc ? { broadcast_id: bc.broadcastId, recipient_id: bc.recipientId } : {}),
  };
  const hasExtra = (): boolean => Object.keys(payloadExtra).length > 0;

  const type = input.content.type;
  const carriesForm = type === "flow" || "flow" in payloadExtra;
  const queuedValues: typeof inboxMessage.$inferInsert = {
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
      // the marker behind, so an automatic message is never sent twice. An
      // interactive message keeps what was sent, so the timeline can draw it later.
      ...(input.auto || hasExtra() || content.type === "interactive"
        ? {
            payload: {
              ...payloadExtra,
              ...(input.auto ? { auto: input.auto } : {}),
              ...(content.type === "interactive" ? { interactive: content.interactive } : {}),
            },
          }
        : {}),
      createdAt: now,
  };
  let queued: SentMessage | undefined;
  if (bc) {
    // The queued message and its link to the recipient row are written together and committed
    // BEFORE Meta is called (foundation rule 9). The row is locked and checked again, so two
    // callers for the same recipient can never both get past this point. No Meta call is made
    // inside this transaction.
    queued = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(broadcastRecipient).where(eq(broadcastRecipient.id, bc.recipientId)).for("update");
      if (!r || r.broadcastId !== bc.broadcastId || r.state !== "sending" || r.messageId) {
        throw new InboxSendError("broadcast_duplicate", "This person's message has already been handled; it is not sent again");
      }
      const [row] = await tx.insert(inboxMessage).values(queuedValues).returning();
      await tx.update(broadcastRecipient).set({ messageId: row!.id }).where(eq(broadcastRecipient.id, bc.recipientId));
      return row;
    });
  } else {
    [queued] = await db.insert(inboxMessage).values(queuedValues).returning();
  }

  let final: SentMessage;
  try {
    let wamid: string;
    let callbackRefused = false;
    if (bc) {
      const endpoint = bc.route === "mm" && templateCategory === "MARKETING" ? ("marketing_messages" as const) : ("messages" as const);
      const callbackData = bc.noCallback ? undefined : BROADCAST_CALLBACK_PREFIX + bc.recipientId;
      try {
        wamid = await sendMessage(cfg, waNumberId, to, content, { endpoint, ...(callbackData ? { callbackData } : {}) });
      } catch (err) {
        // Meta answered "invalid parameter" (code 100) and so did NOT send: the callback value is the one
        // thing here Meta's reference does not list (suite spec 14, Q-B8). Ask once more without it.
        // Never done after a timeout or any answer that leaves the outcome unknown.
        const refused = err instanceof MetaApiError && err.code === "100" && err.delivery === "not_sent" && err.status < 500;
        if (!callbackData || !refused) throw err;
        wamid = await sendMessage(cfg, waNumberId, to, content, { endpoint });
        callbackRefused = true;
      }
    } else {
      wamid = await sendMessage(cfg, waNumberId, to, content);
    }
    [final] = (await db
      .update(inboxMessage)
      .set(
        bc
          ? {
              waMessageId: wamid,
              // A delivery report can arrive before this line runs (rule R58): never move the status back.
              status: sql`case when ${inboxMessage.status} in ('queued','failed') then 'sent'::inbox_message_status else ${inboxMessage.status} end`,
              ...(callbackRefused
                ? { payload: sql`coalesce(${inboxMessage.payload}, '{}'::jsonb) || '{"callback_refused":true}'::jsonb` }
                : {}),
            }
          : { waMessageId: wamid, status: "sent" },
      )
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
        // Merged with what the queued row already holds (the automatic marker, an interactive object), never replacing it.
        payload: {
          ...((queued!.payload as Record<string, unknown> | null) ?? {}),
          unconfirmed: e?.delivery === "unknown",
          retryable: e !== null && e.delivery === "not_sent" && e.retryable,
          ...(bsuidRefused || flowRefused ? { meta_message: metaMessage } : {}),
          // The broadcast engine sorts a refusal by Meta's code and the HTTP status (suite spec 14, section 3).
          ...(bc && e ? { http_status: e.status } : {}),
        },
      })
      .where(eq(inboxMessage.id, queued!.id))
      .returning()) as [SentMessage];
  }

  // A broadcast must not disturb the inbox (suite spec 14, 5.10): it assigns nobody, is not a
  // first reply, does not change the preview or the order of the list, and signals no screen.
  // The message is in the thread when someone opens it.
  if (bc) return final;

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
  // Products, the menu and buttons (suite spec 08) exist on WhatsApp only.
  if (content.type === "interactive") throw new InboxSendError("no_whatsapp", "Products and buttons can only be sent on WhatsApp.");
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
    // The echo may have confirmed this send while its answer was lost: only a row with no Meta id is failed.
    const [failedRow] = (await db
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
      .where(and(eq(inboxMessage.id, queued!.id), isNull(inboxMessage.waMessageId)))
      .returning()) as SentMessage[];
    final = failedRow ?? (await db.select().from(inboxMessage).where(eq(inboxMessage.id, queued!.id)))[0]!;
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
