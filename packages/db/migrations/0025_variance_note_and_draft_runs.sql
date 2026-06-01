-- Free-text variance note (alongside the canned variance_reason enum) so the
-- branch can explain "other" reasons in detail. The receive endpoint enforces
-- presence when variance_reason = 'other_with_note'.
ALTER TABLE "stock_transfer_item"
  ADD COLUMN IF NOT EXISTS "variance_note" text;
