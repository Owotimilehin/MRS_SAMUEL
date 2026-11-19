import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";
import { customer } from "./customer.js";
import { inboxConversation, inboxPhoneNumber } from "./inbox.js";

/**
 * Leads from Meta lead forms ("instant forms"), suite spec 13.
 *
 * lead_form: one row per form on a connected Page, with the wording the person
 * saw and the owner's consent rule for WhatsApp.
 * lead: one row per filled-in form, keyed on Meta's leadgen id. The form's own
 * answers stay here; an existing customer row is never changed by a lead.
 *
 * Contains no token.
 */

/** One question of a form, as Meta returns it. */
export interface LeadQuestion {
  key: string;
  label: string;
  type: string;
  options?: { key: string; value: string }[];
}

/** One tick-box of a form's own consent wording. */
export interface LeadDisclaimer {
  key: string;
  text: string;
  is_required: boolean;
}

/** One answer, in the form's question order, with the label taken from the form at the time. */
export interface LeadAnswer {
  key: string;
  label: string;
  values: string[];
}

/** The wording the person saw and what they ticked. */
export interface LeadConsent {
  form_name: string;
  privacy_policy_url: string | null;
  disclaimers: { key: string; text: string; is_checked: boolean }[];
  captured_at: string;
}

export const leadForm = pgTable("lead_form", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Meta's form ID. */
  formId: text("form_id").notNull().unique(),
  pageId: text("page_id").notNull(),
  name: text("name").notNull(),
  /** Meta's status: ACTIVE | ARCHIVED (when Meta returned it). */
  status: text("status"),
  locale: text("locale"),
  questions: jsonb("questions").$type<LeadQuestion[]>().notNull().default([]),
  privacyPolicyUrl: text("privacy_policy_url"),
  disclaimers: jsonb("disclaimers").$type<LeadDisclaimer[]>().notNull().default([]),
  /** The tick-box whose "ticked" means the person agreed to WhatsApp (rule R18). */
  whatsappConsentKey: text("whatsapp_consent_key"),
  /** The owner says the form's own wording already covers WhatsApp contact (rule R18). */
  consentCoversWhatsapp: boolean("consent_covers_whatsapp").notNull().default(false),
  /** The WhatsApp line used to contact this form's leads. Null = the default line (rule R11). */
  phoneNumberId: uuid("phone_number_id").references(() => inboxPhoneNumber.id, { onDelete: "set null" }),
  /** Off: leads are still stored, but no conversation is opened and nobody is alerted (rule R3). */
  isEnabled: boolean("is_enabled").notNull().default(true),
  backfillRequestedAt: timestamp("backfill_requested_at", { withTimezone: true }),
  backfillCursor: text("backfill_cursor"),
  backfillDoneAt: timestamp("backfill_done_at", { withTimezone: true }),
  backfillCount: integer("backfill_count").notNull().default(0),
  /** Why the last back-fill stopped early ("<code>: <Meta's message>"); null when it finished or has not run. */
  backfillError: text("backfill_error"),
  /** When the form's wording was last read from Meta (at most once every 24 hours, rule R4). */
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const lead = pgTable(
  "lead",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Meta's lead ID. One row per lead, from the webhook or the back-fill, whichever comes first. */
    leadgenId: text("leadgen_id").notNull().unique(),
    /** Meta's form ID (not a foreign key: a lead can be stored before its form is known). */
    formId: text("form_id").notNull(),
    pageId: text("page_id"),
    adId: text("ad_id"),
    adName: text("ad_name"),
    adsetId: text("adset_id"),
    adsetName: text("adset_name"),
    campaignId: text("campaign_id"),
    campaignName: text("campaign_name"),
    /** 'fb' | 'ig' when Meta says. */
    platform: text("platform"),
    isOrganic: boolean("is_organic"),
    isBackfill: boolean("is_backfill").notNull().default(false),
    metaCreatedAt: timestamp("meta_created_at", { withTimezone: true }),
    /** 'pending' | 'fetched' | 'failed' | 'gone' (a database CHECK enforces the list). */
    fetchState: text("fetch_state").notNull().default("pending"),
    fetchAttempts: integer("fetch_attempts").notNull().default(0),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }).notNull().defaultNow(),
    fetchErrorCode: text("fetch_error_code"),
    fetchError: text("fetch_error"),
    answers: jsonb("answers").$type<LeadAnswer[]>().notNull().default([]),
    fullName: text("full_name"),
    phoneRaw: text("phone_raw"),
    phoneE164: text("phone_e164"),
    email: text("email"),
    consent: jsonb("consent").$type<LeadConsent>(),
    whatsappConsent: boolean("whatsapp_consent").notNull().default(false),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => inboxConversation.id, { onDelete: "set null" }),
    /** 'new' | 'contacted' | 'won' | 'lost' (a database CHECK enforces the list). */
    status: text("status").notNull().default("new"),
    /** 'not_interested' | 'no_answer' | 'wrong_number' | 'duplicate' | 'test' | 'other'; only when status is 'lost'. */
    lostReason: text("lost_reason"),
    assigneeId: uuid("assignee_id").references(() => adminUser.id),
    note: text("note"),
    followupSentAt: timestamp("followup_sent_at", { withTimezone: true }),
    firstContactedAt: timestamp("first_contacted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** When the person's details were blanked on request; the row stays so counts stay true. */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxStatusCreated: index("idx_lead_status_created").on(t.status, t.createdAt),
    idxFormCreated: index("idx_lead_form_created").on(t.formId, t.createdAt),
    idxCustomer: index("idx_lead_customer").on(t.customerId),
    idxFetch: index("idx_lead_fetch").on(t.fetchState, t.nextFetchAt),
    idxAssignee: index("idx_lead_assignee").on(t.assigneeId),
  }),
);
