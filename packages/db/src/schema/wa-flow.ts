import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { inboxConversation, inboxMessage } from "./inbox.js";

/**
 * WhatsApp Flows: in-chat forms (suite spec 07, migration 0076). On screen a Flow is
 * always called a "form". No key material and no token secret is stored here.
 */

export interface FlowValidationError {
  error?: string;
  error_type?: string;
  message?: string;
  line_start?: number;
  column_start?: number;
}

export interface FlowResponseAction {
  action: string;
  by: string;
  at: string;
  detail?: string;
}

/** One row per form version created at Meta. */
export const waFlow = pgTable(
  "wa_flow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wabaId: text("waba_id").notNull(),
    /** Our name for the form, from the registry in @ms/shared (delivery_address, complaint, …). */
    key: text("key").notNull(),
    /** 1, 2, 3… A new row only when Meta will not accept a change to a published form. */
    version: integer("version").notNull().default(1),
    metaFlowId: text("meta_flow_id"),
    metaName: text("meta_name").notNull(),
    /** DRAFT | PUBLISHED | DEPRECATED | BLOCKED | THROTTLED (Meta's words). */
    status: text("status").notNull().default("DRAFT"),
    usesEndpoint: boolean("uses_endpoint").notNull().default(false),
    jsonVersion: text("json_version"),
    /** SHA-256 (hex) of the exact JSON text Meta last accepted. */
    uploadedHash: text("uploaded_hash"),
    /** The hash that was live when it was published. */
    publishedHash: text("published_hash"),
    validationErrors: jsonb("validation_errors").$type<FlowValidationError[]>().notNull().default([]),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => adminUser.id),
    publishedBy: uuid("published_by").references(() => adminUser.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqKeyVersion: uniqueIndex("uq_wa_flow_key_version").on(t.wabaId, t.key, t.version),
    uqMetaId: uniqueIndex("uq_wa_flow_meta_id")
      .on(t.metaFlowId)
      .where(sql`meta_flow_id is not null`),
  }),
);

/** One row per completed form, hanging off the customer's inbound message. */
export const waFlowResponse = pgTable(
  "wa_flow_response",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .unique()
      .references(() => inboxMessage.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversation.id, { onDelete: "cascade" }),
    /** The form message the customer answered, when we sent it. */
    requestMessageId: uuid("request_message_id").references(() => inboxMessage.id, { onDelete: "set null" }),
    flowId: uuid("flow_id").references(() => waFlow.id, { onDelete: "set null" }),
    /** A registry key, or "unknown". */
    flowKey: text("flow_key").notNull(),
    flowToken: text("flow_token"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    /** new | handled */
    status: text("status").notNull().default("new"),
    handledBy: uuid("handled_by").references(() => adminUser.id),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    actions: jsonb("actions").$type<FlowResponseAction[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxConv: index("idx_wa_flow_response_conv").on(t.conversationId, t.createdAt),
    idxKey: index("idx_wa_flow_response_key").on(t.flowKey, t.createdAt),
    idxSlot: index("idx_wa_flow_response_slot")
      .on(sql`(data->>'day')`, sql`(data->>'slot')`)
      .where(sql`flow_key = 'delivery_slot'`),
  }),
);
