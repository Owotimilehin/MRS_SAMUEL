import { pgTable, uuid, integer, text, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { product } from "./product.js";

/**
 * A sellable size of a flavor (330ml can, 650ml bottle, ...). product_price,
 * stock_ledger, stock_reservation, and sale_order_item all gain a nullable
 * variant_id alongside their existing product_id; the follow-up PR migrates
 * writers and readers to variant_id and eventually drops product_id from
 * those tables.
 */
export const productVariant = pgTable(
  "product_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => product.id, { onDelete: "restrict" }),
    sizeMl: integer("size_ml").notNull(),
    sku: text("sku").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    idxProduct: index("idx_product_variant_product").on(t.productId),
    uqSku: unique("uq_product_variant_sku").on(t.sku),
    uqProductSize: unique("uq_product_variant_product_size").on(t.productId, t.sizeMl),
  }),
);
