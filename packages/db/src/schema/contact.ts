import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { customer } from "./customer.js";
import { inboxMessage } from "./inbox.js";

/**
 * Contacts (suite spec 14, Phase A; migration 0082). Everything lives under the
 * `contact_` prefix. A contact IS a row of the shop's `customer` table; these
 * tables only add to it (a derived summary, labels, lists, imports, consent).
 * Nothing here ever changes or deletes a `customer` row.
 *
 * The CHECK constraints (address_source, colour, kind, status, outcome, origin,
 * channel, purpose, state, method, confirm_state) live in the SQL migration.
 * The jsonb columns hold shapes defined in @ms/shared (ContactFilter,
 * ImportMapping); this package does not depend on @ms/shared, so they are
 * typed loosely here and narrowed where they are read.
 */

/**
 * Derived: one row per live customer who is not an alias. Can be deleted and
 * rebuilt at any time (refreshContactSummary in @ms/domain). `name_sort` is
 * COLLATE "C" in the SQL so '~' (no name) sorts last.
 */
export const contactSummary = pgTable(
  "contact_summary",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customer.id, { onDelete: "cascade" }),
    nameSort: text("name_sort").notNull().default("~"),
    searchText: text("search_text").notNull().default(""),
    /** Digits only, without a leading 234 or 0. */
    phoneDigits: text("phone_digits"),
    hasPhone: boolean("has_phone").notNull().default(false),
    hasEmail: boolean("has_email").notNull().default(false),
    hasAddress: boolean("has_address").notNull().default(false),
    address: text("address"),
    /** 'saved' | 'last_delivery' */
    addressSource: text("address_source"),
    channels: text("channels").array().notNull().default(sql`'{}'::text[]`),
    ordersCount: integer("orders_count").notNull().default(0),
    spentNgn: bigint("spent_ngn", { mode: "number" }).notNull().default(0),
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    /** last_order_at with -infinity for null, so key paging never meets a null. */
    lastOrderKey: timestamp("last_order_key", { withTimezone: true, mode: "string" }).notNull().default(sql`'-infinity'`),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    lastContactKey: timestamp("last_contact_key", { withTimezone: true, mode: "string" }).notNull().default(sql`'-infinity'`),
    createdKey: timestamp("created_key", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** Set when a WhatsApp message failed with 131026; cleared when they next write (Phase B writes it). */
    waUnreachableAt: timestamp("wa_unreachable_at", { withTimezone: true }),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxName: index("idx_contact_summary_name").on(t.nameSort, t.customerId),
    idxLastOrder: index("idx_contact_summary_last_order").on(t.lastOrderKey.desc(), t.customerId.desc()),
    idxSpent: index("idx_contact_summary_spent").on(t.spentNgn.desc(), t.customerId.desc()),
    idxLastContact: index("idx_contact_summary_last_contact").on(t.lastContactKey.desc(), t.customerId.desc()),
    idxCreated: index("idx_contact_summary_created").on(t.createdKey.desc(), t.customerId.desc()),
    idxPhone: index("idx_contact_summary_phone").on(t.phoneDigits),
  }),
);

/** "This customer record is the same person as that one." Written by the inbox merge. */
export const contactAlias = pgTable(
  "contact_alias",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customer.id, { onDelete: "cascade" }),
    intoCustomerId: uuid("into_customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => adminUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ idxInto: index("idx_contact_alias_into").on(t.intoCustomerId) }),
);

/** A label describes the person ("Bulk buyer"). Separate from chat labels on a conversation. */
export const contactLabel = pgTable("contact_label", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** lower(btrim(name)) */
  nameKey: text("name_key").notNull().unique(),
  /** 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'grey' */
  colour: text("colour").notNull().default("green"),
  createdBy: uuid("created_by").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactLabelMember = pgTable(
  "contact_label_member",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => contactLabel.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => adminUser.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.customerId, t.labelId] }),
    idxLabel: index("idx_contact_label_member_label").on(t.labelId, t.customerId),
  }),
);

/** A named group of contacts. 'static' has member rows; 'smart' has a filter and no member rows. */
export const contactList = pgTable(
  "contact_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** lower(btrim(name)); unique among lists that are not archived. */
    nameKey: text("name_key").notNull(),
    /** 'static' | 'smart' */
    kind: text("kind").notNull(),
    description: text("description"),
    /** A ContactFilter (@ms/shared) for a smart list; null for a static one. */
    filter: jsonb("filter").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by").references(() => adminUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    uqName: uniqueIndex("uq_contact_list_name").on(t.nameKey).where(sql`archived_at is null`),
  }),
);

export const contactListMember = pgTable(
  "contact_list_member",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => contactList.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => adminUser.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.listId, t.customerId] }),
    idxCustomer: index("idx_contact_list_member_customer").on(t.customerId),
  }),
);

/** One uploaded spreadsheet. Rows are kept 30 days after it ends, then purged; the counts stay. */
export const contactImport = pgTable("contact_import", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  /** 'uploaded' | 'previewed' | 'applying' | 'applied' | 'failed' | 'cancelled' */
  status: text("status").notNull().default("uploaded"),
  headers: jsonb("headers").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** An ImportMapping (@ms/shared): field -> header text. */
  mapping: jsonb("mapping").$type<Record<string, string>>(),
  sourceLabel: text("source_label"),
  /** One of the five customer_source values (the enum gains none; ruling 9.2.7). */
  customerSource: text("customer_source").notNull().default("phone"),
  /** 'none' | 'marketing_whatsapp' */
  consentDeclared: text("consent_declared").notNull().default("none"),
  consentMethod: text("consent_method"),
  consentWording: text("consent_wording"),
  consentCollectedOn: date("consent_collected_on"),
  fillBlanks: boolean("fill_blanks").notNull().default(false),
  labelId: uuid("label_id").references(() => contactLabel.id, { onDelete: "set null" }),
  listId: uuid("list_id").references(() => contactList.id, { onDelete: "set null" }),
  totalRows: integer("total_rows").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  matchedCount: integer("matched_count").notNull().default(0),
  rejectedCount: integer("rejected_count").notNull().default(0),
  appliedRows: integer("applied_rows").notNull().default(0),
  error: text("error"),
  createdBy: uuid("created_by").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  previewedAt: timestamp("previewed_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  rowsPurgedAt: timestamp("rows_purged_at", { withTimezone: true }),
});

export const contactImportRow = pgTable(
  "contact_import_row",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => contactImport.id, { onDelete: "cascade" }),
    rowNo: integer("row_no").notNull(),
    /** The row as uploaded: { "<header>": "<cell>" }. */
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    name: text("name"),
    phoneE164: text("phone_e164"),
    email: text("email"),
    address: text("address"),
    notes: text("notes"),
    /** 'pending' | 'new' | 'matched' | 'rejected' */
    outcome: text("outcome").notNull().default("pending"),
    reason: text("reason"),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
    /** The blank fields this import filled on a matched contact, with the values, so it can be undone by hand. */
    filled: jsonb("filled").$type<Record<string, string>>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.importId, t.rowNo] }),
    idxCustomer: index("idx_contact_import_row_customer").on(t.customerId),
  }),
);

/** Where a contact created here came from (customer.source cannot say "by hand" or "imported"). */
export const contactOrigin = pgTable("contact_origin", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customer.id, { onDelete: "cascade" }),
  /** 'manual' | 'import' */
  origin: text("origin").notNull(),
  importId: uuid("import_id").references(() => contactImport.id, { onDelete: "set null" }),
  sourceLabel: text("source_label"),
  createdBy: uuid("created_by").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Consent history. Rows are never updated except `is_current` and
 * `confirm_state`. The current answer for (customer, channel, purpose) is the
 * one row with is_current; no row means "not asked".
 */
export const contactConsent = pgTable(
  "contact_consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    /** 'whatsapp' | 'sms' | 'email' | 'phone' */
    channel: text("channel").notNull(),
    /** 'marketing' | 'service' */
    purpose: text("purpose").notNull(),
    /** 'granted' | 'withdrawn' */
    state: text("state").notNull(),
    /** 'staff' | 'import' | 'keyword' | 'whatsapp_setting' | 'meta_refusal' | 'erase_request' | 'carried_over' | 'merge' */
    method: text("method").notNull(),
    wording: text("wording"),
    note: text("note"),
    collectedOn: date("collected_on"),
    recordedBy: uuid("recorded_by").references(() => adminUser.id),
    importId: uuid("import_id").references(() => contactImport.id, { onDelete: "set null" }),
    /** The customer's own STOP or START message. */
    messageId: uuid("message_id").references(() => inboxMessage.id, { onDelete: "set null" }),
    isCurrent: boolean("is_current").notNull().default(true),
    /** 'none' | 'pending' | 'sending' | 'sent' | 'skipped' | 'failed': drives the automatic confirmation. */
    confirmState: text("confirm_state").notNull().default("none"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqCurrent: uniqueIndex("uq_contact_consent_current").on(t.customerId, t.channel, t.purpose).where(sql`is_current`),
    idxHistory: index("idx_contact_consent_history").on(t.customerId, t.recordedAt),
    idxState: index("idx_contact_consent_state").on(t.channel, t.purpose, t.state).where(sql`is_current`),
    idxConfirm: index("idx_contact_consent_confirm").on(t.recordedAt).where(sql`confirm_state = 'pending'`),
  }),
);
