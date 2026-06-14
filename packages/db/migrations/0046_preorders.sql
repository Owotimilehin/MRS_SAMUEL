-- Preorders: prepaid orders for not-yet-made items. A variant can be marked
-- preorder_only (always made-to-order); any sold-out item is also preorderable.
-- The order carries is_preorder + fulfilment metadata; stock is deducted at
-- fulfilment, not at payment.

ALTER TABLE "product_variant"
  ADD COLUMN "preorder_only" boolean NOT NULL DEFAULT false;

-- Preserve today's UX: all 330ml cans were treated as preorder.
UPDATE "product_variant" SET preorder_only = true WHERE size_ml = 330;

ALTER TABLE "sale_order"
  ADD COLUMN "is_preorder"           boolean NOT NULL DEFAULT false,
  ADD COLUMN "fulfilled_at"          timestamptz,
  ADD COLUMN "fulfilled_by_user_id"  uuid REFERENCES "admin_user"("id");

CREATE INDEX "idx_sale_order_preorder_queue"
  ON "sale_order" ("is_preorder", "status", "fulfilled_at");
