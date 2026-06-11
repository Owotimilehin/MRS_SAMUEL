import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { mediaAsset } from "./media-asset.js";

export const productCategory = pgEnum("product_category", ["regular", "special", "punch"]);

/** Per-flavour colour palette. surface = card background (admin "primary"),
 *  accent = chips/price/badges (admin "secondary"), text = body colour on the
 *  surface (auto-derived for contrast, overridable). Matches DESIGN_SYSTEM.md. */
export type ProductPalette = { surface: string; accent: string; text: string };

/** One ingredient + its one-line benefit, rendered on the juice detail page. */
export type IngredientDetail = { name: string; benefit: string };

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
  // ---- Storefront marketing content (customer site) ----
  tagline: text("tagline"),
  story: text("story"),
  pairing: text("pairing"),
  note: text("note"),
  benefits: jsonb("benefits").$type<string[]>().notNull().default([]),
  bestFor: jsonb("best_for").$type<string[]>().notNull().default([]),
  ingredientDetails: jsonb("ingredient_details").$type<IngredientDetail[]>().notNull().default([]),
  palette: jsonb("palette").$type<ProductPalette>(),
  // ---- Visual assets (media library references) ----
  bottleAssetId: uuid("bottle_asset_id").references(() => mediaAsset.id),
  clusterAssetId: uuid("cluster_asset_id").references(() => mediaAsset.id),
  fruitAssetId: uuid("fruit_asset_id").references(() => mediaAsset.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
