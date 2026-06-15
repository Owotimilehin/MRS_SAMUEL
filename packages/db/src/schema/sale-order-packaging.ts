import { pgTable, uuid, integer, timestamp, index } from "drizzle-orm/pg-core";
import { saleOrder } from "./sale-order.js";
import { packagingMaterial } from "./packaging-material.js";

/**
 * Bags handed out on a sale (Workstream A2c). Tracked-only: the authoritative
 * record of bag usage. The branch packaging ledger is decremented from these
 * rows, but a sale is never blocked on bag stock (warn-but-allow).
 */
export const saleOrderPackaging = pgTable(
  "sale_order_packaging",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleOrderId: uuid("sale_order_id")
      .notNull()
      .references(() => saleOrder.id, { onDelete: "cascade" }),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterial.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOrder: index("idx_sale_order_packaging_order").on(t.saleOrderId),
  }),
);
