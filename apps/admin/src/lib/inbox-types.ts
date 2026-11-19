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
}

export interface ConversationPage {
  data: ConversationRow[];
  next_before: string | null;
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
