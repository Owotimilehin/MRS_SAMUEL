import { pgTable, uuid, integer, timestamp, index } from "drizzle-orm/pg-core";
import { saleOrder } from "./sale-order.js";
import { branch } from "./branch.js";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";

/**
 * Soft holds on branch stock between Confirm and Pay. A reservation that
 * passes its expires_at is swept by the worker so the bottles return to the
 * available pool. On Pay the reservation is deleted and a real ledger row
 * is inserted in the same transaction.
 */
export const stockReservation = pgTable(
  "stock_reservation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleOrderId: uuid("sale_order_id")
      .notNull()
      .references(() => saleOrder.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull().references(() => branch.id),
    productId: uuid("product_id").notNull().references(() => product.id),
    variantId: uuid("variant_id").references(() => productVariant.id),
    quantity: integer("quantity").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxBranchProduct: index("idx_reservation_branch_product").on(t.branchId, t.productId),
    idxExpires: index("idx_reservation_expires").on(t.expiresAt),
    idxVariant: index("idx_reservation_variant").on(t.variantId),
  }),
);
