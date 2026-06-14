-- Size-aware transfers: each transfer line may name the exact can size.
-- Nullable so legacy/in-flight transfers keep NULL (no-size bucket) and stay
-- balanced across dispatch/receive. New dispatches always set it.
ALTER TABLE stock_transfer_item
  ADD COLUMN variant_id uuid REFERENCES product_variant(id);

CREATE INDEX IF NOT EXISTS idx_transfer_item_variant
  ON stock_transfer_item (variant_id);
