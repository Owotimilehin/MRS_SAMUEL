import { pgTable, uuid, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { productVariant } from "./product-variant.js";

/**
 * Anonymous, server-stored shopping cart. The `id` is what we put in the
 * `ms_cart` cookie — no separate `cookie_id` column to keep the model tight.
 * Sliding TTL: every mutation pushes `expires_at` to now() + 30 days.
 */
export const cart = pgTable(
  "cart",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    idxExpires: index("idx_cart_expires").on(t.expiresAt),
  }),
);

export const cartLine = pgTable(
  "cart_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => cart.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariant.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxCart: index("idx_cart_line_cart").on(t.cartId),
    uqVariant: unique("uq_cart_line_variant").on(t.cartId, t.variantId),
  }),
);
