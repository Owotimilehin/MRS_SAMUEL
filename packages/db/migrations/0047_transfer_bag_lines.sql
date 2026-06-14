-- Bags on transfers (Workstream A2b). A transfer line is now EITHER a product
-- (juice, moved through stock_ledger) OR a packaging material (a bag, moved
-- through packaging_stock_ledger). product_id becomes nullable and a new
-- packaging_material_id is added, with a CHECK enforcing exactly one is set.
-- Legacy/in-flight lines all carry product_id, so the XOR holds for them.

-- Packaging ledger gains transfer movement source types (was: purchase,
-- consumption, adjustment, opening_balance). ADD VALUE IF NOT EXISTS is
-- re-runnable; the new values are only USED at runtime, never in this file.
ALTER TYPE "packaging_ledger_source_type" ADD VALUE IF NOT EXISTS 'transfer_dispatch';
--> statement-breakpoint
ALTER TYPE "packaging_ledger_source_type" ADD VALUE IF NOT EXISTS 'transfer_receive';
--> statement-breakpoint
ALTER TYPE "packaging_ledger_source_type" ADD VALUE IF NOT EXISTS 'transfer_reject_reverse';
--> statement-breakpoint

ALTER TABLE "stock_transfer_item" ALTER COLUMN "product_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_transfer_item"
  ADD COLUMN "packaging_material_id" uuid REFERENCES "packaging_material"("id");
--> statement-breakpoint
ALTER TABLE "stock_transfer_item"
  ADD CONSTRAINT "stock_transfer_item_product_xor_material"
  CHECK (("product_id" IS NOT NULL) <> ("packaging_material_id" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transfer_item_packaging_material"
  ON "stock_transfer_item" ("packaging_material_id");
