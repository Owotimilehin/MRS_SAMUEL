/**
 * Shapes returned by the unified-inbox API (`/v1/inbox/*`).
 * COPIED from apps/admin/src/lib/inbox-types.ts (settings/report types left
 * out). The mobile app sits outside the pnpm workspace, so it can't import it.
 * Keep the two in step when the API changes.
 *
 * Field casing mirrors the server exactly: list/timeline rows are snake_case,
 * single DB rows (conversation detail) come back camelCase.
 */

export type Channels = "voice" | "whatsapp" | "both";
export type ConversationStatus = "open" | "pending" | "closed";
export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
export type CallOutcome = "in_progress" | "answered" | "missed" | "voicemail" | "after_hours" | "failed";

export interface InboxNumberLite {
  id: string;
  label: string;
  e164: string;
  channels: Channels;
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
  team_id: string | null;
  team_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  window_remaining_ms: number;
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
  unreadCount: number;
  customer: { id: string; name: string | null; phone: string | null; email: string | null; notes: string | null } | null;
  number: InboxNumberLite | null;
  assignee: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  window_remaining_ms: number;
  can_use_number: boolean;
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
  error_message: string | null;
  sender_name: string | null;
  created_at: string;
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
  conversations: Array<{
    id: string;
    status: ConversationStatus;
    number_label: string;
    last_activity_at: string;
    labels: string[];
  }>;
}

/** Live event pushed on GET /inbox/stream. */
export interface InboxEvent {
  event: string;
  conversationId?: string;
  phoneNumberId?: string;
  id?: string;
}

/** POST /inbox/uploads response. `media_token` must be sent back with the media message. */
export interface UploadTicket {
  upload_url: string;
  object_key: string;
  kind: "image" | "document" | "audio" | "video";
  media_token: string;
}

export type NotifyLevel = "all" | "assigned" | "none";
