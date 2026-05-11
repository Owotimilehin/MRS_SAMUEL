import { pgTable, uuid, integer, text, timestamp, pgEnum, date } from "drizzle-orm/pg-core";
import { factory } from "./factory";
import { product } from "./product";
import { adminUser } from "./admin-user";

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
  quantityProduced: integer("quantity_produced").notNull(),
  batchCode: text("batch_code"),
});
