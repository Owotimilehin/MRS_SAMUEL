ALTER TABLE "sale_order" ADD COLUMN "produced_at" timestamptz;
ALTER TABLE "sale_order" ADD COLUMN "produced_by_user_id" uuid REFERENCES "admin_user"("id");
CREATE INDEX IF NOT EXISTS "idx_sale_order_preorder_produced" ON "sale_order" ("is_preorder","produced_at");
