import { pgTable, uuid, integer, text, timestamp, pgEnum, date, index } from "drizzle-orm/pg-core";
import { factory } from "./factory.js";
import { product } from "./product.js";
import { adminUser } from "./admin-user.js";
import { productVariant } from "./product-variant.js";

export const productionRunStatus = pgEnum("production_run_status", [
  "draft",
  "completed",
  "cancelled",
]);

export const productionRun = pgTable("production_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  factoryId: uuid("factory_id").notNull().references(() => factory.id, { onDelete: "restrict" }),
  runDate: date("run_date").notNull(),
  status: productionRunStatus("status").notNull().default("draft"),
  createdByUserId: uuid("created_by_user_id").references(() => adminUser.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productionRunItem = pgTable("production_run_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  productionRunId: uuid("production_run_id")
    .notNull()
    .references(() => productionRun.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id, { onDelete: "restrict" }),
  variantId: uuid("variant_id").references(() => productVariant.id),
  quantityProduced: integer("quantity_produced").notNull(),
  batchCode: text("batch_code"),
  // Insertion order — the draft lists flavours in the sequence they were added.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // GET /production-runs batches items via inArray(production_run_id); without
  // this the batched item load (and the old per-run N+1) seq-scanned the table.
  idxRun: index("idx_production_run_item_run").on(t.productionRunId),
}));
