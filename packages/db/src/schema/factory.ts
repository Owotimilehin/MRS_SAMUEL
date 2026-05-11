import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const factory = pgTable("factory", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  address: text("address"),
  phone: text("phone"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
