/**
 * Shapes returned by the unified-inbox API (`/v1/inbox/*`). Kept in one place so
 * the inbox page, settings, reports and the call bar agree on field names.
 * Field casing mirrors the server exactly: list/timeline rows are snake_case,
 * single DB rows (conversation detail, settings rows) come back camelCase.
 */

import type { ChannelKind, IdentityChannel } from "@ms/shared";

export type { ChannelKind, IdentityChannel };

export type Channels = "voice" | "whatsapp" | "both";
export type ConversationStatus = "open" | "pending" | "closed";
export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
export type CallOutcome = "in_progress" | "answered" | "missed" | "voicemail" | "after_hours" | "failed";

/**
 * A line the customer reached us on: a phone line, a Facebook Page or an
 * Instagram account (spec 01, "channel accounts"). Only a phone has e164.
 */
export interface InboxNumberLite {
  id: string;
  label: string;
  e164: string | null;
  /** Meaningful only for kind "phone". */
  channels: Channels;
  /** Older servers leave it out: treat a missing kind as "phone". */
  kind?: ChannelKind;
  /** The Page name, or the Instagram username without "@". */
  external_name?: string | null;
  /** Conversation detail only: false when the line is switched off under Channels. */
  is_active?: boolean;
  /** Conversation detail only (spec 02): why messages on this line are not going out, in plain words. */
  problem_text?: string | null;
}

export interface InboxMe {
  user_id: string;
  capabilities: string[];
  team_ids: string[];
  numbers: InboxNumberLite[];
}

export interface StaffMember {
  id: string;
  name: string;
  team_ids: string[];
}

export interface InboxTeamLite {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface ConversationRow {
  id: string;
  status: ConversationStatus;
  labels: string[];
  unread: number;
  preview: string | null;
  last_activity_at: string;
  last_inbound_wa_at: string | null;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  number_id: string;
  number_label: string;
  number_kind?: ChannelKind;
  channel?: IdentityChannel;
  /** What Meta calls the customer on this thread's channel (name, or "@username"). */
  identity_name?: string | null;
  team_id: string | null;
  team_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  window_remaining_ms: number;
  /** Messenger/Instagram with Human Agent on: ms left of the 7-day window (spec 02). */
  human_agent_remaining_ms?: number;
  /** Suite spec 15: when a snoozed chat comes back (only in the Snoozed list). */
  snoozed_until?: string | null;
  /** When a snooze ended by time; the row looks unread until someone opens it. */
  woke_at?: string | null;
  /** The customer's oldest message since our last reply. */
  waiting_since?: string | null;
  /** Minutes waited inside opening hours; null when off or nothing is waiting. */
  waiting_minutes?: number | null;
}

export interface ConversationPage {
  data: ConversationRow[];
  next_before: string | null;
  /** Suite spec 15: the reply-time target in minutes, or null when off. */
  reply_target_minutes?: number | null;
}

/** A reminder (suite spec 15). */
export interface ReminderRow {
  id: string;
  note: string;
  due_at: string;
  done_at: string | null;
  created_at: string;
  conversation_id: string | null;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  identity_name: string | null;
  channel: IdentityChannel | null;
  assignee_id: string;
  assignee_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
}

export interface ConversationDetail {
  id: string;
  customerId: string;
  phoneNumberId: string;
  teamId: string | null;
  status: ConversationStatus;
  assigneeId: string | null;
  labels: string[];
  lastInboundWaAt: string | null;
  lastActivityAt: string;
  lastPreview?: string | null;
  unreadCount: number;
  customer: { id: string; name: string | null; phone: string | null; email: string | null; notes: string | null } | null;
  number: InboxNumberLite | null;
  assignee: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  window_remaining_ms: number;
  /** Messenger/Instagram with Human Agent on: ms left of the 7-day window (spec 02). */
  human_agent_remaining_ms?: number;
  /** True when the server lets staff answer Messenger/Instagram up to 7 days (META_HUMAN_AGENT_ENABLED). */
  human_agent_enabled?: boolean;
  can_use_number: boolean;
  /** Suite spec 15: when this snoozed chat comes back; null = not snoozed. */
  snoozedUntil?: string | null;
  wokeAt?: string | null;
  channel?: IdentityChannel;
  /** The identity that last wrote in this thread; replies go to it. */
  identity?: {
    id: string;
    channel: IdentityChannel;
    display_name: string | null;
    username: string | null;
    profile_pic_url: string | null;
  } | null;
}

export interface TimelineMessage {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  type: string;
  body: string | null;
  has_media: boolean;
  media_pending: boolean;
  media_mime: string | null;
  media_filename: string | null;
  template_name: string | null;
  status: MessageStatus;
  /**
   * With status "failed": WhatsApp never answered, so the message may have been
   * delivered anyway. Shown in amber, not red. Absent on older servers.
   */
  unconfirmed?: boolean;
  error_message: string | null;
  sender_name: string | null;
  /**
   * Set when no member of staff sent it: "after_hours" (the reply to customers
   * who write when closed) or "system" (e.g. the missed-call follow-up).
   * Absent on older servers.
   */
  auto?: string | null;
  created_at: string;
  // Messenger and Instagram (spec 02); absent on older servers.
  channel?: IdentityChannel;
  /** The customer edited it. */
  edited?: boolean;
  /** The customer unsent it: body and media are gone. */
  deleted?: boolean;
  /** Answered from Meta's own apps, not from the suite. */
  external_sender?: boolean;
  /** A reply to one of our stories. */
  story_reply?: boolean;
  /** A shared post's link, or a story mention's link while the story can still exist. */
  link?: string | null;
  /** The advert the customer came from. */
  advert?: string | null;
  /** A tapped Messenger/Instagram button: "Tapped a starter question" and the like. */
  tap_caption?: string | null;
  /** An outbound form message (spec 07): the form's title and the button text. Absent on older servers. */
  flow_sent?: FlowSent | null;
  /** The customer's answers to a form (spec 07). Absent on older servers. */
  flow_response?: FlowResponseCard | null;
  /** This message is the private reply to a comment (suite spec 03). */
  comment_ref?: { thread_id?: string; comment_id?: string; network?: string; excerpt?: string } | null;
}

export interface FlowSent {
  title: string;
  cta: string;
}

/** One answer on a form card. `value` is already formatted for display by the server. */
export interface FlowCardRow {
  label: string;
  value: string;
  /** text, phone, choice, multi, date, longtext or other. */
  kind: string;
}

export interface FlowResponseCard {
  id: string;
  flow_key: string;
  /** "new" or "handled"; anything else shows no pill. */
  status: string;
  handled_by_name: string | null;
  handled_at: string | null;
  title: string;
  rows: FlowCardRow[];
  /** Delivery-slot answers only: "This time was already full when it arrived". */
  warning?: string | null;
}

/** A form the composer can send (GET /inbox/flows). */
export interface InboxFlow {
  key: string;
  title: string;
  description: string;
  cta: string;
  default_message: string;
  /** Published at WhatsApp for this conversation's account. */
  live: boolean;
  /** A draft exists that someone with templates.manage can send as a test. */
  testable: boolean;
}

export type FlowResponseAction = "handled" | "reopen" | "save_address" | "add_note";

export interface FlowActionResult {
  id: string;
  status: string;
  handled_at: string | null;
  /** save_address: the contact's address before and after. */
  before?: string | null;
  after?: string;
  /** add_note: the note that was added. */
  note_id?: string;
}

export interface CallSummary {
  summary: string;
  call_reason: string;
  action_items: string[];
  sentiment: string;
}

export interface TimelineRecording {
  id: string;
  kind: "call" | "voicemail";
  /** "pending" | "ready" | "failed" | "deleted" (audio, transcript and summary removed). */
  status: string;
  duration_s: number | null;
  playable: boolean;
  transcript: string | null;
  summary: CallSummary | null;
  /** Who said what, line by line (Fireflies). Call log only; absent on older recordings. */
  transcript_lines?: TranscriptLine[] | null;
  /** Sent to Fireflies and the result is not in yet. Call log only. */
  transcribing?: boolean;
}

export interface TranscriptLine {
  speaker: string;
  text: string;
  start_s: number | null;
  end_s: number | null;
}

export interface TimelineCall {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  outcome: CallOutcome;
  ivr_choice: string | null;
  duration_s: number | null;
  started_at: string;
  answered_by: string | null;
  recordings: TimelineRecording[];
}

export interface TimelineNote {
  id: string;
  conversation_id: string;
  body: string;
  author_name: string | null;
  created_at: string;
}

export type TimelineItem =
  | { kind: "message"; at: string; data: TimelineMessage }
  | { kind: "call"; at: string; data: TimelineCall }
  | { kind: "note"; at: string; data: TimelineNote };

/** One page of a conversation's timeline, oldest → newest. */
export interface TimelinePage {
  data: TimelineItem[];
  has_more: boolean;
  /** Pass as `before` to fetch the page just before this one. */
  next_before: string | null;
}

/** A contact found by the "merge with another contact" search. */
export interface ContactSearchHit {
  id: string;
  name: string | null;
  phone: string | null;
  conversations: number;
  /** Up to three "@username" or display names from the contact's identities. */
  handles?: string[];
}

export interface EraseResult {
  conversations: number;
  messages: number;
  calls: number;
  recordings: number;
  identities?: number;
}

/** One way a customer reaches us (WhatsApp number, Facebook name, Instagram username). */
export interface IdentityRow {
  id: string;
  channel: IdentityChannel;
  /** The label of our line ("WhatsApp" for every WhatsApp identity). */
  account_label: string;
  display_name: string | null;
  username: string | null;
  /** "+234…" for a WhatsApp identity that is a phone number; null otherwise. */
  phone: string | null;
  profile_pic_url: string | null;
  last_seen_at: string | null;
}

export interface InboxTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown[];
  param_count: number;
  waba_id: string;
  /** Can the inbox send it? Absent on older servers (the app works it out from `components`). */
  sendable?: boolean;
  unsendable_reason?: string | null;
}

export interface QuickReply {
  id: string;
  title: string;
  body: string;
}

export interface ContactInfo {
  customer: { id: string; name: string | null; phone: string | null; email: string | null; notes: string | null };
  /** Absent on servers before spec 01. */
  identities?: IdentityRow[];
  conversations: Array<{
    id: string;
    status: ConversationStatus;
    number_label: string;
    last_activity_at: string;
    labels: string[];
    /** Absent on servers before spec 02. */
    channel?: IdentityChannel;
  }>;
}

/** Live event pushed on GET /inbox/stream. */
export interface InboxEvent {
  event: string;
  conversationId?: string;
  phoneNumberId?: string;
  teamId?: string | null;
  assigneeId?: string | null;
  id?: string;
  /** On message.created: "in" when the customer wrote. */
  direction?: "in" | "out";
}

/** Which incoming messages alert this person. Saved per user on the server. */
export type NotifyLevel = "all" | "assigned" | "none";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface PhoneNumberRow {
  id: string;
  /** Null for a Facebook Page or Instagram account (only listed with ?kind=all). */
  e164: string | null;
  label: string;
  channels: Channels;
  kind?: ChannelKind;
  externalId?: string | null;
  pageExternalId?: string | null;
  externalName?: string | null;
  wabaId: string | null;
  waPhoneNumberId: string | null;
  waStatus: string | null;
  qualityRating: string | null;
  messagingLimit: string | null;
  waFallbackNumberId: string | null;
  voiceProvider: string | null;
  inboundMatch: string | null;
  maxConcurrentCalls: number | null;
  defaultTeamId: string | null;
  hoursProfileId: string | null;
  ivrMenuId: string | null;
  afterHoursText: string | null;
  /** Uploaded recording callers hear after hours (instead of the computer voice). */
  afterHoursAudioKey?: string | null;
  after_hours_audio_key?: string | null;
  isActive: boolean;
  calls_in_progress: number;
}

export interface TeamWithMembers extends InboxTeamLite {
  members: Array<{ user_id: string; name: string; is_lead: boolean }>;
}

export interface HoursRuleRow {
  id: string;
  profileId: string;
  weekday: number;
  openTime: string;
  closeTime: string;
}

export interface HoursProfileRow {
  id: string;
  name: string;
  timeZone: string;
  rules: HoursRuleRow[];
}

export interface HolidayRow {
  id: string;
  profileId: string | null;
  date: string;
  label: string;
}

export interface IvrOptionRow {
  id: string;
  digit: string;
  label: string;
  action: "ring_team" | "voicemail" | "play";
  teamId: string | null;
  playText: string | null;
  /** Uploaded recording for action "play". */
  audioKey?: string | null;
  audio_key?: string | null;
}

export interface IvrMenuRow {
  id: string;
  name: string;
  greetingText: string;
  /** Uploaded greeting recording; the typed text is the fallback. */
  greetingAudioKey?: string | null;
  greeting_audio_key?: string | null;
  options: IvrOptionRow[];
}

// ── Reports ──────────────────────────────────────────────────────────────────

export interface InboxReport {
  range: { from: string; to: string };
  messages_per_day: Array<{ day: string; inbound: number; outbound: number }>;
  calls_per_day: Array<{ day: string; total: number; answered: number; missed: number; after_hours: number }>;
  response: {
    conversations: number;
    responded: number;
    median_first_response_s: number | null;
    median_resolution_s: number | null;
  } | null;
  staff: Array<{ user_id: string; name: string; replies: number; calls: number; talk_s: number }>;
  staff_calls: Array<{ user_id: string | null; calls: number; talk_s: number }>;
  per_number: Array<{ number_id: string; label: string; conversations: number }>;
}

// ── Selling in chat (suite spec 08) ──────────────────────────────────────────

/** An item staff may send from the catalogue. */
export interface SendableItem {
  retailer_id: string;
  title: string;
  price_ngn: number | null;
  availability: "in stock" | "out of stock" | null;
  picture_url: string | null;
  category: string | null;
}

export interface CatalogueSendable {
  /** Null when no catalogue is connected to WhatsApp: the Products button is then hidden. */
  catalog_id: string | null;
  items: SendableItem[];
}

export type ChatOrderState = "new" | "asked" | "awaiting_address" | "ready" | "placed" | "cancelled";

/** One line of a customer's cart, at the shop's own price. */
export interface ChatOrderLine {
  retailer_id: string;
  variant_id: string | null;
  name: string;
  size_ml: number | null;
  quantity: number;
  shop_price_ngn: number | null;
  line_total_ngn: number | null;
  /** What WhatsApp showed the customer. For display only. */
  meta_price: number | null;
  price_differs: boolean;
  sellable: boolean;
  in_stock: boolean;
}

export interface ChatOrder {
  id: string;
  state: ChatOrderState;
  created_at: string;
  cart_note: string | null;
  fulfilment: "delivery" | "pickup" | null;
  address: string | null;
  problem: string | null;
  payment_link_sent_at: string | null;
  lines: ChatOrderLine[];
  subtotal_ngn: number;
  order: {
    id: string;
    order_number: string;
    status: string;
    payment_status: string;
    total_ngn: number;
    delivery_fee_ngn: number;
    is_preorder?: boolean;
    admin_url: string;
  } | null;
}

export interface ChatOrderList {
  data: ChatOrder[];
  online_branch: { id: string; name: string } | null;
  /** The customer's saved address, to prefill the delivery address. */
  default_address: string | null;
}

export interface PlaceChatOrderInput {
  fulfilment: "delivery" | "pickup";
  address?: string;
  delivery_fee_ngn: number;
  items: { variant_id: string; quantity: number }[];
  notes?: string;
}

export interface PlacedChatOrder {
  order_number: string;
  total_ngn: number;
  is_preorder: boolean;
  payment_link: string | null;
  /** The order exists, but the link or the message did not go: show this to the person. */
  warning?: string;
}
