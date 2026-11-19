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
import { and, eq, sql } from "drizzle-orm";
import { inboxMessage, inboxWebhookEvent, type DbExecutor } from "@ms/db";
import { messagePreview } from "@ms/shared";
import { channelAccountByExternalId, type ChannelAccount } from "../meta/accounts.js";
import { findOrCreateCustomerByIdentity, findOrOpenConversation, publishInboxEvent, signalFor, touchConversation } from "./core.js";
import { PARKED_ATTEMPTS } from "./whatsapp-ingest.js";

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
export const META_CHANGE_HANDLERS: Record<string, MetaChangeHandler> = {};

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
    return handleInboundMessage(ctx, e.message, ev);
  }
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

/** Step 5: an echo of a message the Page sent (rule R6). Filled in by task 7. */
async function handleEcho(_ctx: MetaEntryContext, _e: MetaMessagingEvent, _ev: EventCtx): Promise<boolean> {
  return false;
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
