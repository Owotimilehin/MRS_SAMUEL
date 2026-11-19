/**
 * Turn a Page or Instagram webhook entry into inbox rows (suite spec 02).
 *
 * ingestMetaEntry is the single dispatch point for the shared Meta webhook
 * (foundation ruling 9.2.3): the webhook route and the worker's retry both
 * call it with one stored entry. Later specs (comments, lead forms, adverts)
 * add their handling HERE: entry.changes[] items go through CHANGE_HANDLERS,
 * messaging events through the dispatch in handleMessagingEvent. Neither
 * trusts the stored `kind`; both look at the entry itself.
 *
 * Idempotent: every row is keyed on wa_message_id (Meta's mid, or a made-up
 * repeatable key, spec 02 section 4.3), statuses only move forward.
 *
 * Media is NOT downloaded here: the message is saved with media_url (Meta's
 * short-lived link) and the worker fetches it. Story-mention media is never
 * downloaded or stored (foundation C4).
 */
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { inboxConversation, inboxIdentity, inboxMessage, inboxWebhookEvent, type DbExecutor } from "@ms/db";
import { describeChatSetupPayload, messagePreview } from "@ms/shared";
import { channelAccountByExternalId, type ChannelAccount } from "../meta/accounts.js";
import { findOrCreateCustomerByIdentity, findOrOpenConversation, publishInboxEvent, signalFor, touchConversation, ts } from "./core.js";
import { PARKED_ATTEMPTS } from "./whatsapp-ingest.js";
import { ingestLeadgenChange, type LeadgenChange } from "../meta/leads.js";

export type MetaChannel = "messenger" | "instagram";

// ── Payload shapes (only the parts we read) ─────────────────────────────────

export interface MetaAttachment {
  type?: string;
  payload?: {
    url?: string;
    title?: string;
    sticker_id?: number | string;
    reel_video_id?: string;
    id?: string;
  } | null;
}

export interface MetaReferral {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
  ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string; post_id?: string; product_id?: string };
}

export interface MetaInboundMessagePart {
  mid?: string;
  text?: string;
  is_echo?: boolean;
  app_id?: number | string;
  metadata?: string;
  is_deleted?: boolean;
  is_unsupported?: boolean;
  quick_reply?: { payload?: string };
  reply_to?: { mid?: string; is_self_reply?: boolean; story?: { url?: string; id?: string } };
  attachments?: MetaAttachment[];
  referral?: MetaReferral;
}

export interface MetaMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: MetaInboundMessagePart;
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number; mid?: string };
  postback?: { mid?: string; title?: string; payload?: string; referral?: MetaReferral };
  referral?: MetaReferral;
  reaction?: { mid?: string; action?: "react" | "unreact" | string; reaction?: string; emoji?: string };
  message_edit?: { mid?: string; text?: string; num_edit?: number };
  /** Key name is [unverified] (spec 02, 5.3 step 3); both spellings are accepted. */
  "policy-enforcement"?: unknown;
  policy_enforcement?: unknown;
}

export interface MetaEntry {
  id?: string;
  time?: number;
  messaging?: MetaMessagingEvent[];
  standby?: MetaMessagingEvent[];
  changes?: { field?: string; value?: unknown }[];
}

export interface MetaWebhookPayload {
  object?: "page" | "instagram" | string;
  entry?: MetaEntry[];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** "<object>.<field>" for inbox_webhook_event.kind (foundation D6). A label only: processing never trusts it. */
export function metaEventKind(object: string, entry: MetaEntry): string {
  const field = entry.changes?.[0]?.field;
  if (field) return `${object}.${field}`;
  if (entry.standby?.length) return `${object}.standby`;
  const ev = entry.messaging?.[0];
  const page = object === "page";
  if (!ev) return `${object}.unknown`;
  if (ev.message) return page && ev.message.is_echo ? "page.message_echoes" : `${object}.messages`;
  if (ev.delivery) return "page.message_deliveries";
  if (ev.read) return page ? "page.message_reads" : "instagram.messaging_seen";
  if (ev.postback) return `${object}.messaging_postbacks`;
  if (ev.referral) return page ? "page.messaging_referrals" : "instagram.messaging_referral";
  if (ev.reaction) return `${object}.message_reactions`;
  if (ev.message_edit) return page ? "page.message_edits" : "instagram.message_edit";
  return `${object}.unknown`;
}

/**
 * Time of an event (rule R3): `timestamp` if it is a number; values above
 * 10^12 are milliseconds, others seconds; missing → now.
 */
export function metaEventTime(timestamp: unknown, now: Date = new Date()): Date {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return now;
  return new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
}

export interface ParsedMetaRow {
  idSuffix: string;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
}

function appName(channel: MetaChannel): string {
  return channel === "messenger" ? "Facebook" : "Instagram";
}

function unsupportedText(channel: MetaChannel): string {
  return `This message can't be shown here. Open the ${appName(channel)} app to see it.`;
}

const SHARE_TYPES = new Set(["share", "post", "ig_post", "reel", "ig_reel", "story", "ig_story", "media"]);

function attachmentRow(channel: MetaChannel, a: MetaAttachment, text: string | null): Omit<ParsedMetaRow, "idSuffix"> {
  const type = a.type ?? "";
  const url = a.payload?.url ?? null;
  const title = a.payload?.title ?? null;
  const row = (t: string, body: string | null, mediaUrl: string | null = null) => ({ type: t, body, mediaUrl, mediaMime: null });
  if ((type === "image" && a.payload?.sticker_id != null) || type === "sticker") return row("sticker", null, url);
  if (type === "image" || type === "video" || type === "audio") return row(type, null, url);
  if (type === "file") return row("document", null, url);
  // Meta policy: never store or cache story-mention media. Only the link stays (in payload).
  if (type === "story_mention") return row("story_mention", "Mentioned you in their story");
  if (SHARE_TYPES.has(type)) {
    const what = type === "reel" || type === "ig_reel" ? "Shared a reel" : type === "story" || type === "ig_story" ? "Shared a story" : "Shared a post";
    return row("share", title ? `${what}: ${title}` : what);
  }
  if (type === "fallback") return row("text", text ?? title ?? url ?? "Shared a link");
  return row("unsupported", unsupportedText(channel));
}

/**
 * Flatten one message into rows to insert (spec 02, 5.3 table). Pure; exported
 * for tests. The first row has idSuffix "" and takes the text when it has no
 * body of its own; later rows are "#2", "#3", …; when the first row already
 * has its own body, the text gets a last row of its own.
 */
export function parseMetaMessage(channel: MetaChannel, m: MetaInboundMessagePart): ParsedMetaRow[] {
  const text = m.text ?? null;
  if (m.is_unsupported) {
    return [{ idSuffix: "", type: "unsupported", body: unsupportedText(channel), mediaUrl: null, mediaMime: null }];
  }
  const attachments = m.attachments ?? [];
  if (attachments.length === 0) {
    return [{ idSuffix: "", type: m.quick_reply ? "interactive" : "text", body: text, mediaUrl: null, mediaMime: null }];
  }
  const rows: ParsedMetaRow[] = attachments.map((a, i) => ({
    idSuffix: i === 0 ? "" : `#${i + 1}`,
    ...attachmentRow(channel, a, text),
  }));
  const first = rows[0]!;
  if (text !== null) {
    if (first.body === null) first.body = text;
    else if (first.body !== text) rows.push({ idSuffix: `#${rows.length + 1}`, type: "text", body: text, mediaUrl: null, mediaMime: null });
  }
  return rows;
}

// ── Processing ──────────────────────────────────────────────────────────────

/**
 * An echo of a message we may have just sent arrived before our send saved
 * Meta's mid (rule R6 d). Thrown so the event stays unprocessed and the worker
 * retries it shortly; same idea as StatusBeforeSendError.
 */
export class EchoBeforeSendError extends Error {
  constructor(public readonly mid: string) {
    super(`echo for ${mid} arrived before our send was saved; will retry`);
    this.name = "EchoBeforeSendError";
  }
}

export interface MetaIngestResult {
  messagesCreated: number;
  /** Rows changed by statuses, edits, unsends and echoes of our own sends. */
  updates: number;
  /** "<kind>:<entry id>" for accounts we have no row for (the event is parked). */
  unknownAccounts: string[];
  /** The account exists but is switched off: nothing was written. */
  inactive: boolean;
  /** Nothing in the entry is handled yet (for example entry.changes before spec 03). */
  ignored: boolean;
  /** Meta sent a policy-enforcement event for the Page. */
  policyAlert: boolean;
}

export interface MetaIngestOptions {
  /** Our Meta app's id (META_APP_ID): an echo from another app id was sent elsewhere. */
  appId?: string;
  now?: Date;
}

/** What every handler gets for one entry. */
export interface MetaEntryContext {
  db: DbExecutor;
  object: string;
  kind: MetaChannel;
  /** The connected, switched-on account the entry is for. externalId is never null here. */
  account: ChannelAccount & { externalId: string };
  entry: MetaEntry;
  opts: MetaIngestOptions;
  now: Date;
  result: MetaIngestResult;
}

/**
 * Handlers for entry.changes[] items, keyed "<object>.<field>" (for example
 * "page.feed", "instagram.comments", "page.leadgen"). Specs 03, 12 and 13
 * register theirs here (foundation ruling 9.2.3). Return true when handled.
 */
export type MetaChangeHandler = (ctx: MetaEntryContext, change: { field: string; value: unknown }) => Promise<boolean>;
export const META_CHANGE_HANDLERS: Record<string, MetaChangeHandler> = {
  // Suite spec 13: a filled-in lead form. Only the IDs are stored here (no call to Meta);
  // the worker fetches the lead itself. Safe to process twice (unique leadgen_id).
  "page.leadgen": async (ctx, change) => {
    const value = (change.value ?? {}) as LeadgenChange;
    // The entry is for this Page (ingestMetaEntry matched it to a connected, switched-on account).
    await ingestLeadgenChange(ctx.db, { ...value, page_id: ctx.account.externalId });
    return true;
  },
};

function emptyResult(): MetaIngestResult {
  return { messagesCreated: 0, updates: 0, unknownAccounts: [], inactive: false, ignored: false, policyAlert: false };
}

/**
 * Apply one stored event (one entry). Run inside a transaction so the rows and
 * the live signals land together. Never calls Meta.
 */
export async function ingestMetaEntry(
  db: DbExecutor,
  object: string,
  entry: MetaEntry,
  opts: MetaIngestOptions = {},
): Promise<MetaIngestResult> {
  const result = emptyResult();
  const now = opts.now ?? new Date();
  if (object !== "page" && object !== "instagram") {
    result.ignored = true;
    return result;
  }
  const kind: MetaChannel = object === "page" ? "messenger" : "instagram";
  const entryId = entry.id ? String(entry.id) : "";
  if (!entryId) {
    result.ignored = true;
    return result;
  }

  // 1. Which of our accounts is it for?
  const account = await channelAccountByExternalId(db, kind, entryId);
  if (!account) {
    result.unknownAccounts.push(`${kind}:${entryId}`);
    return result;
  }
  if (!account.isActive) {
    result.inactive = true;
    return result;
  }
  const ctx: MetaEntryContext = {
    db,
    object,
    kind,
    account: { ...account, externalId: account.externalId ?? entryId },
    entry,
    opts,
    now,
    result,
  };

  // 2. Changes (comments, lead forms, …): each change goes to its registered handler.
  let handled = false;
  for (const change of entry.changes ?? []) {
    const field = change.field ?? "";
    const handler = META_CHANGE_HANDLERS[`${object}.${field}`];
    if (handler && (await handler(ctx, { field, value: change.value }))) handled = true;
  }

  // 3. Messaging events, then standby events, oldest first.
  const events = [
    ...(entry.messaging ?? []).map((e) => ({ e, standby: false })),
    ...(entry.standby ?? []).map((e) => ({ e, standby: true })),
  ].sort((a, b) => eventMillis(a.e) - eventMillis(b.e));
  for (const { e, standby } of events) {
    if (await handleMessagingEvent(ctx, e, standby)) handled = true;
  }

  if (!handled && events.length === 0) result.ignored = true;
  return result;
}

function eventMillis(e: MetaMessagingEvent): number {
  return typeof e.timestamp === "number" ? metaEventTime(e.timestamp, new Date(0)).getTime() : 0;
}

/** Dispatch one messaging event on the first key present (spec 02, 5.3 step 3). True when it was recognised. */
async function handleMessagingEvent(ctx: MetaEntryContext, e: MetaMessagingEvent, standby: boolean): Promise<boolean> {
  if (e["policy-enforcement"] !== undefined || e.policy_enforcement !== undefined) {
    ctx.result.policyAlert = true;
    return true;
  }
  const customerSideId = e.message?.is_echo ? e.recipient?.id : e.sender?.id;
  if (!customerSideId || String(customerSideId) === ctx.account.externalId) return false;
  const ev: EventCtx = {
    customerSideId: String(customerSideId),
    at: metaEventTime(e.timestamp, ctx.now),
    payload: (standby ? { ...e, standby: true } : { ...e }) as Record<string, unknown>,
  };
  if (e.message) {
    if (e.message.is_echo) return handleEcho(ctx, e, ev);
    if (e.message.is_deleted) return handleUnsend(ctx, e.message, ev);
    return handleInboundMessage(ctx, e.message, ev);
  }
  if (e.delivery) return handleDelivery(ctx, e.delivery, ev);
  if (e.read) return handleRead(ctx, e.read, ev);
  if (e.postback) return handlePostback(ctx, e, ev);
  if (e.referral) return handleReferral(ctx, e, ev);
  if (e.reaction) return handleReaction(ctx, e, ev);
  if (e.message_edit) return handleEdit(ctx, e.message_edit, ev);
  return false;
}

interface EventCtx {
  /** The customer's Page- or Instagram-scoped ID. */
  customerSideId: string;
  at: Date;
  /** The raw event to store, with standby: true when it came under entry.standby. */
  payload: Record<string, unknown>;
}

/** The customer and their thread on this account, creating either if needed. */
async function customerThread(ctx: MetaEntryContext, ev: EventCtx) {
  const who = await findOrCreateCustomerByIdentity(ctx.db, {
    channel: ctx.kind,
    accountExternalId: ctx.account.externalId,
    externalId: ev.customerSideId,
  });
  const { conversation } = await findOrOpenConversation(ctx.db, who.customerId, ctx.account.id, ev.at, {
    identityId: who.identityId,
  });
  return conversation;
}

async function midExists(db: DbExecutor, mid: string): Promise<boolean> {
  const [row] = await db.select({ id: inboxMessage.id }).from(inboxMessage).where(eq(inboxMessage.waMessageId, mid)).limit(1);
  return !!row;
}

/** Insert inbound rows, then bump the thread and signal (step 4). Returns how many rows were new. */
async function insertInbound(
  ctx: MetaEntryContext,
  ev: EventCtx,
  rows: { key: string; type: string; body: string | null; mediaUrl?: string | null }[],
  how: { inboundWa: boolean; unread: boolean; alert: boolean },
): Promise<number> {
  const conversation = await customerThread(ctx, ev);
  let last: { id: string; type: string; body: string | null } | null = null;
  let inserted = 0;
  for (const r of rows) {
    const [row] = await ctx.db
      .insert(inboxMessage)
      .values({
        conversationId: conversation.id,
        direction: "in",
        type: r.type,
        body: r.body,
        mediaUrl: r.mediaUrl ?? null,
        channel: ctx.kind,
        waMessageId: r.key,
        status: "received",
        payload: ev.payload,
        createdAt: ev.at,
      })
      .onConflictDoNothing({ target: inboxMessage.waMessageId })
      .returning({ id: inboxMessage.id });
    if (row) {
      inserted++;
      last = { id: row.id, type: r.type, body: r.body };
    }
  }
  if (!last) return 0;
  const conv = await touchConversation(ctx.db, conversation.id, {
    preview: messagePreview(last.type, last.body),
    ...(how.inboundWa ? { inboundWa: ev.at } : {}),
    ...(how.unread ? { unreadIncrement: true } : {}),
    at: ev.at,
  });
  const created = signalFor("message.created", conv, last.id);
  // Only a customer's own message carries direction "in", so only it alerts staff.
  await publishInboxEvent(ctx.db, how.alert ? { ...created, direction: "in" } : created);
  await publishInboxEvent(ctx.db, signalFor("conversation.updated", conv));
  ctx.result.messagesCreated += inserted;
  return inserted;
}

/** Step 4: a message from the customer. */
async function handleInboundMessage(ctx: MetaEntryContext, m: MetaInboundMessagePart, ev: EventCtx): Promise<boolean> {
  if (!m.mid) return false;
  if (await midExists(ctx.db, m.mid)) return true; // duplicate
  const rows = parseMetaMessage(ctx.kind, m).map((r) => ({
    key: m.mid + r.idSuffix,
    type: r.type,
    body: r.body,
    mediaUrl: r.mediaUrl,
  }));
  await insertInbound(ctx, ev, rows, { inboundWa: true, unread: true, alert: true });
  return true;
}

/** The raw event time, for made-up keys ("ref:<sender>:<timestamp>"). */
function rawTs(e: MetaMessagingEvent, ev: EventCtx): string {
  return typeof e.timestamp === "number" ? String(e.timestamp) : String(ev.at.getTime());
}

const ECHO_WAIT_MS = 20_000;
const SUITE_METADATA = /^suite:([0-9a-f-]{36})$/i;

async function signalMessage(db: DbExecutor, conversationId: string, messageId: string): Promise<void> {
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
  if (conv) await publishInboxEvent(db, signalFor("message.status", conv, messageId));
}

/** Step 5, rule R6: an echo of a message the Page or Instagram account sent. */
async function handleEcho(ctx: MetaEntryContext, e: MetaMessagingEvent, ev: EventCtx): Promise<boolean> {
  const m = e.message!;
  if (!m.mid) return false;
  const { db } = ctx;

  // (a) We already have it (our send saved its mid, or this is a replay).
  const [known] = await db
    .select({ id: inboxMessage.id, status: inboxMessage.status, conversationId: inboxMessage.conversationId })
    .from(inboxMessage)
    .where(eq(inboxMessage.waMessageId, m.mid))
    .limit(1);
  if (known) {
    if (known.status === "queued") {
      await db.update(inboxMessage).set({ status: "sent" }).where(eq(inboxMessage.id, known.id));
      await signalMessage(db, known.conversationId, known.id);
      ctx.result.updates++;
    }
    return true;
  }

  // (b) Our own send, tagged "suite:<row id>", whose mid is not saved yet.
  const tagged = typeof m.metadata === "string" ? SUITE_METADATA.exec(m.metadata) : null;
  if (tagged) {
    const [row] = await db
      .update(inboxMessage)
      .set({
        waMessageId: m.mid,
        // The echo proves it went: a queued or "unconfirmed" row becomes sent; later states stay.
        status: sql`case when ${inboxMessage.status} in ('queued','failed') then 'sent'::inbox_message_status else ${inboxMessage.status} end`,
      })
      .where(and(eq(inboxMessage.id, tagged[1]!), eq(inboxMessage.direction, "out"), isNull(inboxMessage.waMessageId)))
      .returning({ id: inboxMessage.id, conversationId: inboxMessage.conversationId });
    if (row) {
      await signalMessage(db, row.conversationId, row.id);
      ctx.result.updates++;
      return true;
    }
  }

  // (c) Sent by another app (Meta Business Suite's inbox, the phone app): insert at once.
  const appId = m.app_id != null ? String(m.app_id) : null;
  const fromElsewhere = !!ctx.opts.appId && appId !== null && appId !== ctx.opts.appId;
  // (d) Maybe our own send, still saving its mid: leave it for the worker to retry.
  if (!fromElsewhere && ctx.now.getTime() - ev.at.getTime() < ECHO_WAIT_MS) throw new EchoBeforeSendError(m.mid);

  // (e) An answer someone gave outside the suite: show it so nobody answers twice.
  const conversation = await customerThread(ctx, ev);
  const payload = { ...ev.payload, echo: { app_id: appId } };
  let last: { id: string; type: string; body: string | null } | null = null;
  let inserted = 0;
  for (const r of parseMetaMessage(ctx.kind, m)) {
    const [row] = await db
      .insert(inboxMessage)
      .values({
        conversationId: conversation.id,
        direction: "out",
        type: r.type,
        body: r.body,
        mediaUrl: r.mediaUrl,
        channel: ctx.kind,
        waMessageId: m.mid + r.idSuffix,
        status: "sent",
        senderUserId: null,
        payload,
        createdAt: ev.at,
      })
      .onConflictDoNothing({ target: inboxMessage.waMessageId })
      .returning({ id: inboxMessage.id });
    if (row) {
      inserted++;
      last = { id: row.id, type: r.type, body: r.body };
    }
  }
  if (!last) return true;
  if (!conversation.firstResponseAt) {
    await db
      .update(inboxConversation)
      .set({ firstResponseAt: ev.at })
      .where(and(eq(inboxConversation.id, conversation.id), isNull(inboxConversation.firstResponseAt)));
  }
  const conv = await touchConversation(db, conversation.id, { preview: messagePreview(last.type, last.body), at: ev.at });
  await publishInboxEvent(db, { ...signalFor("message.created", conv, last.id), direction: "out" });
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
  ctx.result.messagesCreated += inserted;
  return true;
}

/** The customer's conversations on this account (by their scoped ID). Creates nothing. */
function customerConversationIds(ctx: MetaEntryContext, customerSideId: string) {
  return ctx.db
    .select({ id: inboxConversation.id })
    .from(inboxConversation)
    .innerJoin(inboxIdentity, eq(inboxIdentity.customerId, inboxConversation.customerId))
    .where(
      and(
        eq(inboxConversation.phoneNumberId, ctx.account.id),
        eq(inboxIdentity.channel, ctx.kind),
        eq(inboxIdentity.accountExternalId, ctx.account.externalId),
        eq(inboxIdentity.externalId, customerSideId),
      ),
    );
}

async function signalRows(ctx: MetaEntryContext, rows: { id: string; conversationId: string }[]): Promise<void> {
  for (const r of rows) await signalMessage(ctx.db, r.conversationId, r.id);
  ctx.result.updates += rows.length;
}

/** Step 6, rule R7: delivered (Messenger only). Forward only; never touches failed. */
async function handleDelivery(
  ctx: MetaEntryContext,
  d: NonNullable<MetaMessagingEvent["delivery"]>,
  ev: EventCtx,
): Promise<boolean> {
  const changed: { id: string; conversationId: string }[] = [];
  const ret = { id: inboxMessage.id, conversationId: inboxMessage.conversationId };
  const mids = (d.mids ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
  if (mids.length) {
    changed.push(
      ...(await ctx.db
        .update(inboxMessage)
        .set({ status: "delivered", deliveredAt: ev.at })
        .where(and(inArray(inboxMessage.waMessageId, mids), eq(inboxMessage.status, "sent"), eq(inboxMessage.direction, "out")))
        .returning(ret)),
    );
  }
  if (typeof d.watermark === "number") {
    const mark = metaEventTime(d.watermark, ev.at);
    changed.push(
      ...(await ctx.db
        .update(inboxMessage)
        .set({ status: "delivered", deliveredAt: ev.at })
        .where(
          and(
            inArray(inboxMessage.conversationId, customerConversationIds(ctx, ev.customerSideId)),
            eq(inboxMessage.direction, "out"),
            eq(inboxMessage.status, "sent"),
            lte(inboxMessage.createdAt, mark),
          ),
        )
        .returning(ret)),
    );
  }
  await signalRows(ctx, changed);
  return true;
}

/** Step 7, rule R8: read. Messenger by watermark; Instagram by mid and every earlier sent one. */
async function handleRead(ctx: MetaEntryContext, r: NonNullable<MetaMessagingEvent["read"]>, ev: EventCtx): Promise<boolean> {
  const ret = { id: inboxMessage.id, conversationId: inboxMessage.conversationId };
  const set = { status: "read" as const, readAt: ev.at, deliveredAt: sql`coalesce(${inboxMessage.deliveredAt}, ${ts(ev.at)})` };
  const notYetRead = inArray(inboxMessage.status, ["sent", "delivered"]);
  let changed: { id: string; conversationId: string }[] = [];
  if (typeof r.watermark === "number") {
    const mark = metaEventTime(r.watermark, ev.at);
    changed = await ctx.db
      .update(inboxMessage)
      .set(set)
      .where(
        and(
          inArray(inboxMessage.conversationId, customerConversationIds(ctx, ev.customerSideId)),
          eq(inboxMessage.direction, "out"),
          notYetRead,
          lte(inboxMessage.createdAt, mark),
        ),
      )
      .returning(ret);
  } else if (r.mid) {
    const [seen] = await ctx.db
      .select({ conversationId: inboxMessage.conversationId, createdAt: inboxMessage.createdAt })
      .from(inboxMessage)
      .where(eq(inboxMessage.waMessageId, r.mid))
      .limit(1);
    if (!seen) return true;
    changed = await ctx.db
      .update(inboxMessage)
      .set(set)
      .where(
        and(
          eq(inboxMessage.conversationId, seen.conversationId),
          eq(inboxMessage.direction, "out"),
          notYetRead,
          lte(inboxMessage.createdAt, seen.createdAt),
        ),
      )
      .returning(ret);
  }
  await signalRows(ctx, changed);
  return true;
}

/**
 * Step 8: a tapped button. Follows spec 04's contract (section 5.6): one
 * inbound "interactive" row, body = title, else the chat set-up fallback
 * title, else "Tapped a button"; it opens the window and counts as unread.
 */
async function handlePostback(ctx: MetaEntryContext, e: MetaMessagingEvent, ev: EventCtx): Promise<boolean> {
  const pb = e.postback!;
  const key = pb.mid ?? `pb:${ev.customerSideId}:${rawTs(e, ev)}`;
  if (await midExists(ctx.db, key)) return true;
  const body = pb.title?.trim() || describeChatSetupPayload(pb.payload)?.fallbackTitle || "Tapped a button";
  await insertInbound(ctx, ev, [{ key, type: "interactive", body }], { inboundWa: true, unread: true, alert: true });
  return true;
}

/** Plain words for where a chat came from (step 9). */
export function referralText(r: MetaReferral | undefined): string {
  if (r?.source === "ADS") {
    const title = r.ads_context_data?.ad_title?.trim();
    return title ? `Came from an advert: ${title}` : "Came from an advert";
  }
  return `Opened the chat from a link${r?.ref ? ` (${r.ref})` : ""}`;
}

/** Step 9: a referral on an existing thread. Opens the window; no unread, no alert (R13, R14). */
async function handleReferral(ctx: MetaEntryContext, e: MetaMessagingEvent, ev: EventCtx): Promise<boolean> {
  const key = `ref:${ev.customerSideId}:${rawTs(e, ev)}`;
  if (await midExists(ctx.db, key)) return true;
  await insertInbound(ctx, ev, [{ key, type: "referral", body: referralText(e.referral) }], {
    inboundWa: true,
    unread: false,
    alert: false,
  });
  return true;
}

/** Step 10: a reaction. "react" opens the window and counts as unread; "unreact" does neither. */
async function handleReaction(ctx: MetaEntryContext, e: MetaMessagingEvent, ev: EventCtx): Promise<boolean> {
  const r = e.reaction!;
  const key = `react:${r.mid ?? ev.customerSideId}:${rawTs(e, ev)}`;
  if (await midExists(ctx.db, key)) return true;
  const react = r.action !== "unreact";
  const body = !react ? "Removed a reaction" : r.emoji ? `Reacted ${r.emoji}` : "Reacted to a message";
  await insertInbound(ctx, ev, [{ key, type: "reaction", body }], { inboundWa: react, unread: react, alert: react });
  return true;
}

const MAX_EDITS_KEPT = 5;

/** Step 11: the customer edited a message. The old text is kept in payload.edits (last 5). */
async function handleEdit(
  ctx: MetaEntryContext,
  edit: NonNullable<MetaMessagingEvent["message_edit"]>,
  ev: EventCtx,
): Promise<boolean> {
  if (!edit.mid || typeof edit.text !== "string") return false;
  const [row] = await ctx.db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, edit.mid)).limit(1);
  if (!row || row.deletedAt) return true;
  if (row.body === edit.text) return true; // a replay of this edit
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const edits = Array.isArray(payload.edits) ? (payload.edits as unknown[]) : [];
  const nextEdits = [...edits, { text: row.body, at: (row.editedAt ?? row.createdAt).toISOString() }].slice(-MAX_EDITS_KEPT);
  await ctx.db
    .update(inboxMessage)
    .set({ body: edit.text, editedAt: ev.at, payload: { ...payload, edits: nextEdits } })
    .where(eq(inboxMessage.id, row.id));
  await signalMessage(ctx.db, row.conversationId, row.id);
  ctx.result.updates++;
  return true;
}

/**
 * Rule R9: the customer unsent a message. Its text goes from the row and from
 * the stored raw copy; a stored file is queued for removal (payload.purge_key).
 */
async function handleUnsend(ctx: MetaEntryContext, m: MetaInboundMessagePart, ev: EventCtx): Promise<boolean> {
  if (!m.mid) return false;
  const rows = await ctx.db
    .select()
    .from(inboxMessage)
    .where(
      and(
        sql`(${inboxMessage.waMessageId} = ${m.mid} or ${inboxMessage.waMessageId} like ${m.mid + "#%"})`,
        isNull(inboxMessage.deletedAt),
      ),
    );
  for (const row of rows) {
    await ctx.db
      .update(inboxMessage)
      .set({
        body: null,
        mediaUrl: null,
        mediaKey: null,
        deletedAt: ev.at,
        payload: row.mediaKey ? { purge_key: row.mediaKey } : {},
      })
      .where(eq(inboxMessage.id, row.id));
    // The list preview says so only when this was the newest message in the thread.
    const [newest] = await ctx.db
      .select({ id: inboxMessage.id })
      .from(inboxMessage)
      .where(eq(inboxMessage.conversationId, row.conversationId))
      .orderBy(desc(inboxMessage.createdAt))
      .limit(1);
    if (newest?.id === row.id) {
      const [conv] = await ctx.db
        .update(inboxConversation)
        .set({ lastPreview: "Message deleted" })
        .where(eq(inboxConversation.id, row.conversationId))
        .returning();
      if (conv) await publishInboxEvent(ctx.db, signalFor("conversation.updated", conv));
    }
    await signalMessage(ctx.db, row.conversationId, row.id);
    ctx.result.updates++;
  }
  return true;
}

/**
 * Close out a stored Meta webhook event after ingestMetaEntry. Events for an
 * account we don't know are parked (not dropped): connecting it later calls
 * unparkEventsForAccount() and the worker replays them.
 */
export async function finishMetaWebhookEvent(db: DbExecutor, eventId: string, r: MetaIngestResult): Promise<void> {
  if (r.unknownAccounts.length > 0) {
    await db
      .update(inboxWebhookEvent)
      .set({ attempts: PARKED_ATTEMPTS, lastError: `unknown_account:${r.unknownAccounts.join(",")}` })
      .where(eq(inboxWebhookEvent.id, eventId));
    return;
  }
  const lastError = r.inactive ? "account_inactive" : r.ignored ? "ignored" : null;
  await db
    .update(inboxWebhookEvent)
    .set({ processedAt: new Date(), attempts: sql`${inboxWebhookEvent.attempts} + 1`, lastError })
    .where(eq(inboxWebhookEvent.id, eventId));
}

/** Re-queue parked events for an account that is now connected. Mirrors unparkEventsForNumber. */
export async function unparkEventsForAccount(db: DbExecutor, kind: MetaChannel, externalId: string): Promise<number> {
  const rows = await db
    .update(inboxWebhookEvent)
    .set({ attempts: 0, lastError: null, receivedAt: sql`now() - interval '1 hour'` })
    .where(
      and(
        sql`${inboxWebhookEvent.processedAt} is null`,
        sql`${inboxWebhookEvent.lastError} like ${`unknown_account:%${kind}:${externalId}%`}`,
      ),
    )
    .returning({ id: inboxWebhookEvent.id });
  return rows.length;
}
