import { pgTable, uuid, text, boolean, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { customer } from "./customer.js";
import { inboxConversation } from "./inbox.js";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";
import { saleOrder } from "./sale-order.js";

/**
 * Catalogue sync and selling in WhatsApp chat (suite spec 08, migration 0077).
 * The CHECK lists on the state columns live in the SQL migration.
 */

/** The exact `data` object sent to Meta's Catalog Batch API for one item. Key order matters for hashing. */
export interface MetaItemData {
  id: string;
  title: string;
  description: string;
  availability: "in stock" | "out of stock";
  condition: "new";
  price: string;
  link: string;
  image: { url: string }[];
  brand: string;
  item_group_id: string;
  size: string;
  google_product_category: string;
}

/** One line of a cart a customer sent from WhatsApp, as Meta gave it. `item_price` is for display only. */
export interface ChatCartLine {
  product_retailer_id: string;
  quantity: number;
  item_price: number | null;
  currency: string | null;
}

/** The one Meta catalogue this shop syncs to. At most one row (a unique index on a constant enforces it). */
export const catalogueLink = pgTable(
  "catalogue_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogId: text("catalog_id").notNull().unique(),
    name: text("name"),
    wabaId: text("waba_id"),
    whatsappConnected: boolean("whatsapp_connected").notNull().default(false),
    isCartEnabled: boolean("is_cart_enabled"),
    isCatalogVisible: boolean("is_catalog_visible"),
    /** false = nothing is ever pushed to Meta. */
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    /** Owner switch, off by default: ask "delivery or pickup?" by itself when a cart arrives. */
    askFulfilmentAuto: boolean("ask_fulfilment_auto").notNull().default(false),
    /** Owner switch, off by default (foundation C6): tell customers when their order is paid, on its way, delivered. */
    orderUpdatesEnabled: boolean("order_updates_enabled").notNull().default(false),
    /** "Something changed in the shop, sync now" flag, set by requestCatalogueSync. */
    syncRequestedAt: timestamp("sync_requested_at", { withTimezone: true }),
    syncRequestReason: text("sync_request_reason"),
    fullSyncRequestedAt: timestamp("full_sync_requested_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastReconcileAt: timestamp("last_reconcile_at", { withTimezone: true }),
    /** 'config' | 'temporary': the last account-level failure, for the banner. */
    problemKind: text("problem_kind"),
    problemCode: text("problem_code"),
    problemMessage: text("problem_message"),
    problemAt: timestamp("problem_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => adminUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => ({
    uqSingle: uniqueIndex("uq_catalogue_link_single").on(sql`(true)`),
  }),
);

/** One call to Meta's items_batch. state: 'queued' | 'open' | 'finished' | 'failed' | 'lost'. */
export const catalogueBatch = pgTable(
  "catalogue_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => catalogueLink.id, { onDelete: "cascade" }),
    handle: text("handle"),
    /** 'changes' | 'full' | 'reconcile' */
    kind: text("kind").notNull(),
    itemCount: integer("item_count").notNull(),
    state: text("state").notNull().default("queued"),
    errorsTotal: integer("errors_total"),
    checks: integer("checks").notNull().default(0),
    result: jsonb("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    idxState: index("idx_catalogue_batch_state").on(t.state, t.createdAt),
  }),
);

/**
 * One row per Meta item we manage (one per size). `desired` is what Meta should
 * hold, or null when the item should not exist there.
 * state: 'pending' | 'sent' | 'live' | 'rejected' | 'blocked' | 'removed'.
 */
export const catalogueItemSync = pgTable(
  "catalogue_item_sync",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => catalogueLink.id, { onDelete: "cascade" }),
    retailerId: text("retailer_id").notNull(),
    variantId: uuid("variant_id").references(() => productVariant.id, { onDelete: "set null" }),
    productId: uuid("product_id").references(() => product.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    desired: jsonb("desired").$type<MetaItemData | null>(),
    desiredHash: text("desired_hash"),
    pushedHash: text("pushed_hash"),
    state: text("state").notNull().default("pending"),
    /** 'no_picture' | 'no_price' */
    blockedReason: text("blocked_reason"),
    reviewStatus: text("review_status"),
    problemCode: text("problem_code"),
    problemMessage: text("problem_message"),
    batchId: uuid("batch_id").references(() => catalogueBatch.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqRetailer: uniqueIndex("uq_catalogue_item_retailer").on(t.linkId, t.retailerId),
    idxState: index("idx_catalogue_item_state").on(t.linkId, t.state),
  }),
);

/**
 * One row per cart a customer sent from WhatsApp. `cart` is Meta's product_items
 * exactly as received. `idempotencyKey` becomes sale_order.idempotency_key, so one
 * cart can never become two orders.
 * state: 'new' | 'asked' | 'awaiting_address' | 'ready' | 'placed' | 'cancelled'.
 */
export const catalogueChatOrder = pgTable(
  "catalogue_chat_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => inboxConversation.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    waMessageId: text("wa_message_id").notNull().unique(),
    catalogId: text("catalog_id"),
    cart: jsonb("cart").$type<ChatCartLine[]>().notNull(),
    cartNote: text("cart_note"),
    state: text("state").notNull().default("new"),
    /** 'delivery' | 'pickup' */
    fulfilment: text("fulfilment"),
    address: text("address"),
    /** 'fulfilment' | 'address' | 'received': the automatic message still to send, if any. */
    nextPrompt: text("next_prompt"),
    promptAttempts: integer("prompt_attempts").notNull().default(0),
    idempotencyKey: uuid("idempotency_key").notNull().defaultRandom().unique(),
    saleOrderId: uuid("sale_order_id")
      .unique()
      .references(() => saleOrder.id, { onDelete: "set null" }),
    placedBy: uuid("placed_by").references(() => adminUser.id, { onDelete: "set null" }),
    paymentLinkSentAt: timestamp("payment_link_sent_at", { withTimezone: true }),
    /** The last sale_order.status the customer was told about. */
    lastNotifiedStatus: text("last_notified_status"),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    problem: text("problem"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxConv: index("idx_catalogue_chat_order_conv").on(t.conversationId, t.createdAt),
    idxOpen: index("idx_catalogue_chat_order_open").on(t.state, t.updatedAt),
  }),
);
