-- Owner-initiated inventory adjustments. Header groups N stock_ledger rows.
-- See spec: docs/superpowers/specs/2026-06-03-inventory-edit-design.md

CREATE TYPE "stock_adjustment_reason" AS ENUM (
  'physical_recount',
  'damaged',
  'spoilage',
  'theft',
  'found',
  'opening_balance',
  'other_with_note'
);

CREATE TABLE "stock_adjustment" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "location_type"         "ledger_location_type" NOT NULL,
  "location_id"           uuid NOT NULL,
  "reason_code"           "stock_adjustment_reason" NOT NULL,
  "reason_note"           text,
  "recorded_by_user_id"   uuid REFERENCES "admin_user"("id"),
  "created_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_stock_adj_location"
  ON "stock_adjustment" ("location_type", "location_id");

CREATE INDEX "idx_stock_adj_created"
  ON "stock_adjustment" ("created_at");
