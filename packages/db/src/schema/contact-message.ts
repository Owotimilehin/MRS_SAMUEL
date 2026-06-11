import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/** Customer contact-form submissions from the public site. */
export const contactMessage = pgTable("contact_message", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
