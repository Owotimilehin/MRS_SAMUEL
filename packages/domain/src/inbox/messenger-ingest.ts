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
