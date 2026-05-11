import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const productCategory = pgEnum("product_category", ["regular", "special", "punch"]);

export const product = pgTable("product", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  category: productCategory("category").notNull(),
  ingredients: jsonb("ingredients").$type<string[]>().notNull().default([]),
  sizeMl: integer("size_ml"),
  shelfLifeHours: integer("shelf_life_hours").notNull().default(48),
  displayOrder: integer("display_order").notNull().default(0),
  imageUrl: text("image_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
