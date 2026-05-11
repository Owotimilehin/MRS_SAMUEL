import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const customerSource = pgEnum("customer_source", [
  "walkup_anonymous",
  "online",
  "phone",
  "glovo",
  "chowdeck",
]);

export const customer = pgTable("customer", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  phone: text("phone"),
  email: text("email"),
  defaultAddress: text("default_address"),
  source: customerSource("source").notNull().default("walkup_anonymous"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
