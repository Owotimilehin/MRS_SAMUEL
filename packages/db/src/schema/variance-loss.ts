import { pgTable, uuid, integer, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";
import { branch } from "./branch.js";
import { adminUser } from "./admin-user.js";

export const varianceLossSource = pgEnum("variance_loss_source", ["transfer", "shift_close"]);

/**
 * One durable record per genuine stock loss (write-off), valued at retail.
 *
 * Written when an owner settles a transfer variance as "loss", or when a shift
 * close counts short. `unit_price_ngn` is snapshotted from the variant's retail
 * price at record time, so later price changes don't rewrite loss history.
 */
export const varianceLoss = pgTable(
  "variance_loss",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: varianceLossSource("source").notNull(),
    sourceId: uuid("source_id").notNull(),
    branchId: uuid("branch_id").notNull().references(() => branch.id),
    productId: uuid("product_id").notNull().references(() => product.id),
    variantId: uuid("variant_id").references(() => productVariant.id),
    sizeMl: integer("size_ml"),
    quantity: integer("quantity").notNull(), // bottles lost, positive
    unitPriceNgn: integer("unit_price_ngn").notNull(), // retail snapshot
    valueNgn: integer("value_ngn").notNull(), // quantity * unitPriceNgn
    reason: text("reason"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOccurred: index("idx_variance_loss_occurred").on(t.occurredAt),
    idxBranchOccurred: index("idx_variance_loss_branch_occurred").on(t.branchId, t.occurredAt),
  }),
);
