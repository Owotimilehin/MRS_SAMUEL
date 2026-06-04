import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Structured vendor record. Used by business_expense.vendor_id (nullable).
 * Soft-delete keeps the reference resolvable for historical expenses.
 */
export const vendor = pgTable(
  "vendor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    notes: text("notes"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxName: index("idx_vendor_name").on(t.name),
    idxDeleted: index("idx_vendor_deleted").on(t.deletedAt),
  }),
);
