import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { customer } from "./customer.js";

/**
 * Unified inbox: WhatsApp (Meta Cloud API) + voice (Twilio) in one timeline per
 * customer. Everything lives under the `inbox_` prefix so it stays clearly apart
 * from the shop's order/stock tables.
 *
 * The existing `customer` table is the contact record. A conversation is one
 * thread per customer per business number; messages, calls and notes hang off it.
 *
 * Nothing here is ever hard-deleted from the app: messages and calls are kept
 * for history; conversations are closed, numbers deactivated.
 */

export const inboxChannels = pgEnum("inbox_channels", ["voice", "whatsapp", "both"]);
export const inboxConversationStatus = pgEnum("inbox_conversation_status", [
  "open",
  "pending",
  "closed",
]);
export const inboxDirection = pgEnum("inbox_direction", ["in", "out"]);
export const inboxMessageStatus = pgEnum("inbox_message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);
export const inboxCallOutcome = pgEnum("inbox_call_outcome", [
  "in_progress",
  "answered",
  "missed",
  "voicemail",
  "after_hours",
  // Caller picked a menu option that only plays a message (no follow-up needed).
  "information",
  "failed",
]);
export const inboxRecordingKind = pgEnum("inbox_recording_kind", ["call", "voicemail"]);
export const inboxRecordingStatus = pgEnum("inbox_recording_status", [
  "pending",
  "stored",
  "transcribed",
  "summarised",
  "failed",
  // Audio, transcript and summary removed on purpose by staff.
  "deleted",
]);
export const inboxIvrAction = pgEnum("inbox_ivr_action", ["ring_team", "voicemail", "play"]);
export const inboxWebhookSource = pgEnum("inbox_webhook_source", ["meta", "twilio"]);

// ── Teams ────────────────────────────────────────────────────────────────────

export const inboxTeam = pgTable("inbox_team", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxTeamMember = pgTable(
  "inbox_team_member",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => inboxTeam.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUser.id, { onDelete: "cascade" }),
    isLead: boolean("is_lead").notNull().default(false),
  },
  (t) => ({ pk: primaryKey({ columns: [t.teamId, t.userId] }) }),
);

// ── Hours and phone menu ─────────────────────────────────────────────────────

export const inboxHoursProfile = pgTable("inbox_hours_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** IANA zone; the business runs on Lagos time. */
  timeZone: text("time_zone").notNull().default("Africa/Lagos"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per open window. weekday 0 = Sunday … 6 = Saturday; times "HH:MM". */
export const inboxHoursRule = pgTable(
  "inbox_hours_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => inboxHoursProfile.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    openTime: text("open_time").notNull(),
    closeTime: text("close_time").notNull(),
  },
  (t) => ({ idxProfile: index("idx_inbox_hours_rule_profile").on(t.profileId) }),
);

/** Closed all day. profile_id null = applies to every profile. */
export const inboxHoliday = pgTable("inbox_holiday", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id").references(() => inboxHoursProfile.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  label: text("label").notNull(),
});

export const inboxIvrMenu = pgTable("inbox_ivr_menu", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** Spoken (TTS) when no greeting recording is uploaded. */
  greetingText: text("greeting_text").notNull(),
  greetingAudioKey: text("greeting_audio_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxIvrOption = pgTable(
  "inbox_ivr_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    menuId: uuid("menu_id")
      .notNull()
      .references(() => inboxIvrMenu.id, { onDelete: "cascade" }),
    digit: text("digit").notNull(),
    label: text("label").notNull(),
    action: inboxIvrAction("action").notNull(),
    teamId: uuid("team_id").references(() => inboxTeam.id),
    /** For action=play: the text read out (or audio_key if uploaded). */
    playText: text("play_text"),
    audioKey: text("audio_key"),
  },
  (t) => ({ uqDigit: uniqueIndex("uq_inbox_ivr_option_digit").on(t.menuId, t.digit) }),
);

// ── Business phone numbers and other channel accounts (a Facebook Page, an Instagram account) ──

/**
 * One row per "channel account" (foundation D1). `kind` is 'phone' (a phone
 * line: WhatsApp and/or calls), 'messenger' (a Facebook Page) or 'instagram'
 * (an Instagram account). A phone row always has `e164`; any other kind always
 * has `external_id` and `page_external_id` (database CHECK
 * inbox_phone_number_shape_chk). `channels` is meaningful only for phones and
 * is 'whatsapp' on every other row.
 */
export const inboxPhoneNumber = pgTable(
  "inbox_phone_number",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'phone' | 'messenger' | 'instagram' (CHANNEL_KINDS in @ms/shared). */
    kind: text("kind").notNull().default("phone"),
    /** Null for any kind other than 'phone'. */
    e164: text("e164").unique(),
    /** messenger: the Page ID. instagram: the Instagram account ID. phone: null. */
    externalId: text("external_id"),
    /** The Page that owns this account (same as external_id for messenger). phone: null. */
    pageExternalId: text("page_external_id"),
    /** What Meta calls it: the Page name, or the Instagram username without "@". */
    externalName: text("external_name"),
    label: text("label").notNull(),
    channels: inboxChannels("channels").notNull().default("both"),
    wabaId: text("waba_id"),
    waPhoneNumberId: text("wa_phone_number_id").unique(),
    waStatus: text("wa_status"),
    qualityRating: text("quality_rating"),
    messagingLimit: text("messaging_limit"),
    waFallbackNumberId: uuid("wa_fallback_number_id"),
    voiceProvider: text("voice_provider"),
    /** The value that identifies this number on an incoming call (Twilio "To"). */
    inboundMatch: text("inbound_match"),
    maxConcurrentCalls: integer("max_concurrent_calls"),
    defaultTeamId: uuid("default_team_id").references(() => inboxTeam.id),
    hoursProfileId: uuid("hours_profile_id").references(() => inboxHoursProfile.id),
    ivrMenuId: uuid("ivr_menu_id").references(() => inboxIvrMenu.id),
    afterHoursText: text("after_hours_text"),
    afterHoursAudioKey: text("after_hours_audio_key"),
    isActive: boolean("is_active").notNull().default(true),
    /** Messenger/Instagram: when the Page was last subscribed to our app's webhooks (spec 02). */
    webhookSubscribedAt: timestamp("webhook_subscribed_at", { withTimezone: true }),
    /** When the subscription was last checked at Meta. */
    webhookCheckedAt: timestamp("webhook_checked_at", { withTimezone: true }),
    /** The last configuration problem Meta reported for this account ("<code>/<subcode>"); cleared by the next success. */
    problemCode: text("problem_code"),
    /** That problem in plain English, shown as a banner. */
    problemText: text("problem_text"),
    problemAt: timestamp("problem_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqKindExternal: uniqueIndex("uq_inbox_number_kind_external")
      .on(t.kind, t.externalId)
      .where(sql`external_id is not null`),
  }),
);

export const inboxUserNumberAccess = pgTable(
  "inbox_user_number_access",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUser.id, { onDelete: "cascade" }),
    phoneNumberId: uuid("phone_number_id")
      .notNull()
      .references(() => inboxPhoneNumber.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.phoneNumberId] }) }),
);

// ── Customer identities ──────────────────────────────────────────────────────

/**
 * "This customer is this ID on this channel" (foundation D2). One customer can
 * have many. Unique on (channel, account_external_id, external_id).
 * whatsapp: account_external_id = 'global', external_id = wa_id (digits) or a
 * BSUID. messenger: Page ID + Page-scoped ID. instagram: Instagram account ID +
 * Instagram-scoped ID.
 */
export const inboxIdentity = pgTable(
  "inbox_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    /** 'whatsapp' | 'messenger' | 'instagram' (IDENTITY_CHANNELS in @ms/shared). */
    channel: text("channel").notNull(),
    accountExternalId: text("account_external_id").notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    username: text("username"),
    profilePicUrl: text("profile_pic_url"),
    profileFetchedAt: timestamp("profile_fetched_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_inbox_identity").on(t.channel, t.accountExternalId, t.externalId),
    idxCustomer: index("idx_inbox_identity_customer").on(t.customerId),
  }),
);

// ── Conversations and timeline ───────────────────────────────────────────────

export const inboxConversation = pgTable(
  "inbox_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    phoneNumberId: uuid("phone_number_id")
      .notNull()
      .references(() => inboxPhoneNumber.id),
    teamId: uuid("team_id").references(() => inboxTeam.id),
    status: inboxConversationStatus("status").notNull().default("open"),
    assigneeId: uuid("assignee_id").references(() => adminUser.id),
    labels: text("labels").array().notNull().default([]),
    /** 'whatsapp' | 'messenger' | 'instagram'; copied from the line when the thread is created, never changes. */
    channel: text("channel").notNull().default("whatsapp"),
    /** The identity that most recently wrote in this conversation; replies go to it. */
    identityId: uuid("identity_id").references(() => inboxIdentity.id, { onDelete: "set null" }),
    /** When the customer last wrote on this conversation's channel. Drives the 24-hour reply window on WhatsApp, Messenger and Instagram (foundation D4). */
    lastInboundWaAt: timestamp("last_inbound_wa_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    lastPreview: text("last_preview"),
    unreadCount: integer("unread_count").notNull().default(0),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxActivity: index("idx_inbox_conv_activity").on(t.status, t.lastActivityAt),
    idxCustomer: index("idx_inbox_conv_customer").on(t.customerId, t.phoneNumberId),
    // At most one live thread per customer per business number.
    uqLive: uniqueIndex("uq_inbox_conv_live").on(t.customerId, t.phoneNumberId).where(sql`status <> 'closed'`),
    idxAssignee: index("idx_inbox_conv_assignee").on(t.assigneeId),
    idxChannel: index("idx_inbox_conv_channel").on(t.channel, t.status, t.lastActivityAt),
  }),
);

export const inboxMessage = pgTable(
  "inbox_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversation.id),
    direction: inboxDirection("direction").notNull(),
    /** text | image | audio | video | document | sticker | location | template | interactive | reaction | unsupported | share | story_mention | referral | system */
    type: text("type").notNull(),
    body: text("body"),
    mediaId: text("media_id"),
    /** Meta's link to a received file. Short-lived: the worker downloads it to storage and sets this back to null. Never the durable copy (foundation D11). */
    mediaUrl: text("media_url"),
    mediaKey: text("media_key"),
    mediaMime: text("media_mime"),
    mediaFilename: text("media_filename"),
    mediaAttempts: integer("media_attempts").notNull().default(0),
    /** When push notifications for this inbound message were handled. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    templateName: text("template_name"),
    /** 'whatsapp' | 'messenger' | 'instagram'; copied from the conversation. */
    channel: text("channel").notNull().default("whatsapp"),
    /** Provider message id for every channel: WhatsApp `wamid…`, Messenger and Instagram `mid…` (foundation D3). Do not rename. */
    waMessageId: text("wa_message_id").unique(),
    status: inboxMessageStatus("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    senderUserId: uuid("sender_user_id").references(() => adminUser.id),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** When the customer last edited this message (Messenger/Instagram). */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** When the customer unsent this message; body and media are cleared. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    idxConv: index("idx_inbox_msg_conv").on(t.conversationId, t.createdAt),
    idxMediaUrl: index("idx_inbox_msg_media_url")
      .on(t.createdAt)
      .where(sql`media_url is not null and media_key is null`),
  }),
);

export const inboxNote = pgTable(
  "inbox_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversation.id),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => adminUser.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ idxConv: index("idx_inbox_note_conv").on(t.conversationId, t.createdAt) }),
);

export const inboxCall = pgTable(
  "inbox_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversation.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    phoneNumberId: uuid("phone_number_id")
      .notNull()
      .references(() => inboxPhoneNumber.id),
    teamId: uuid("team_id").references(() => inboxTeam.id),
    twilioCallSid: text("twilio_call_sid").notNull().unique(),
    direction: inboxDirection("direction").notNull(),
    fromE164: text("from_e164").notNull(),
    toE164: text("to_e164").notNull(),
    ivrChoice: text("ivr_choice"),
    outcome: inboxCallOutcome("outcome").notNull().default("in_progress"),
    answeredByUserId: uuid("answered_by_user_id").references(() => adminUser.id),
    startedByUserId: uuid("started_by_user_id").references(() => adminUser.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationS: integer("duration_s"),
    followupSentAt: timestamp("followup_sent_at", { withTimezone: true }),
  },
  (t) => ({
    idxConv: index("idx_inbox_call_conv").on(t.conversationId, t.startedAt),
    idxStarted: index("idx_inbox_call_started").on(t.startedAt),
  }),
);

export const inboxRecording = pgTable(
  "inbox_recording",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => inboxCall.id),
    twilioRecordingSid: text("twilio_recording_sid").notNull().unique(),
    twilioRecordingUrl: text("twilio_recording_url"),
    kind: inboxRecordingKind("kind").notNull(),
    status: inboxRecordingStatus("status").notNull().default("pending"),
    storageKey: text("storage_key"),
    durationS: integer("duration_s"),
    channels: integer("channels"),
    transcript: text("transcript"),
    summaryJson: jsonb("summary_json").$type<{
      summary: string;
      call_reason: string;
      action_items: string[];
      sentiment: string;
    }>(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({ idxStatus: index("idx_inbox_rec_status").on(t.status) }),
);

// ── Templates, quick replies, raw webhooks, presence, push ───────────────────

export const inboxTemplate = pgTable(
  "inbox_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wabaId: text("waba_id").notNull(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category"),
    status: text("status").notNull(),
    components: jsonb("components").$type<unknown[]>().notNull().default([]),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    // ── Template authoring (suite spec 06, migration 0075). Status gains one local value, 'DRAFT'.
    metaTemplateId: text("meta_template_id"),
    parameterFormat: text("parameter_format"),
    qualityScore: text("quality_score"),
    rejectedReason: text("rejected_reason"),
    reviewInfo: jsonb("review_info").$type<TemplateReviewInfo>(),
    correctCategory: text("correct_category"),
    previousCategory: text("previous_category"),
    categoryChangeAt: timestamp("category_change_at", { withTimezone: true }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    /** The editable copy (TemplateDraft in @ms/shared). On a Meta-known row: changes not yet sent. */
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }),
    draftUpdatedBy: uuid("draft_updated_by").references(() => adminUser.id),
    createdBy: uuid("created_by").references(() => adminUser.id),
    submittedBy: uuid("submitted_by").references(() => adminUser.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** ISO times of our successful edits of an approved template, newest last (30 days kept). */
    metaEditTimes: jsonb("meta_edit_times").$type<string[]>(),
    lastError: text("last_error"),
    starterKey: text("starter_key"),
  },
  (t) => ({
    uq: uniqueIndex("uq_inbox_template").on(t.wabaId, t.name, t.language),
    uqMetaId: uniqueIndex("uq_inbox_template_meta_id")
      .on(t.metaTemplateId)
      .where(sql`meta_template_id is not null`),
    idxStatus: index("idx_inbox_template_status").on(t.status),
  }),
);

export interface TemplateReviewInfo {
  rejection?: { reason?: string; recommendation?: string };
  pause?: { title?: string; description?: string };
  disableDate?: string;
  flagged?: boolean;
  locked?: boolean;
}

export const inboxQuickReply = pgTable("inbox_quick_reply", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: uuid("created_by").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Raw log of every webhook received, for debugging and replay. */
export const inboxWebhookEvent = pgTable(
  "inbox_webhook_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: inboxWebhookSource("source").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({ idxPending: index("idx_inbox_webhook_pending").on(t.processedAt, t.receivedAt) }),
);

/** Who can be rung right now. Heartbeat from the web/mobile app. */
export const inboxPresence = pgTable("inbox_presence", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => adminUser.id, { onDelete: "cascade" }),
  available: boolean("available").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxPushToken = pgTable(
  "inbox_push_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUser.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    token: text("token").notNull().unique(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ idxUser: index("idx_inbox_push_user").on(t.userId) }),
);

/** Per-user notification preference: all | assigned | none. */
export const inboxNotifyPref = pgTable("inbox_notify_pref", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => adminUser.id, { onDelete: "cascade" }),
  level: text("level").notNull().default("assigned"),
});
