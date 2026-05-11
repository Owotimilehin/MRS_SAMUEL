import { pgTable, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { product } from "./product";
import { adminUser } from "./admin-user";

export const productPrice = pgTable("product_price", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull().references(() => product.id, { onDelete: "restrict" }),
  priceNgn: integer("price_ngn").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
