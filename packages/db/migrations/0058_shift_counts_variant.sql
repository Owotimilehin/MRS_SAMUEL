ALTER TABLE "daily_close_stock_count"
  ADD COLUMN "variant_id" uuid REFERENCES "product_variant"("id");

ALTER TABLE "shift_open_stock_count"
  ADD COLUMN "variant_id" uuid REFERENCES "product_variant"("id");
