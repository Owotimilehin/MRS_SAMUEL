import { pgTable, uuid, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

/** Product bundles / gift boxes shown on the shop page (read-only; WhatsApp CTA). */
export const bundle = pgTable("bundle", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceNgn: integer("price_ngn").notNull(),
  description: text("description"),
  contentsLabel: text("contents_label"),
  badge: text("badge"),
  imageUrl: text("image_url"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
