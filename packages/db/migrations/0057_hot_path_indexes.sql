-- Performance: index the busiest tables. sale_order and sale_order_item had NO
-- indexes at all (beyond PK/unique constraints), so every dashboard, report,
-- daily-close and POS-sync query sequential-scanned them. These are purely
-- additive — no data change, no behaviour change — and let the reports/daily
-- date-range queries become index-backed once the predicates are sargable.
--
-- IF NOT EXISTS so a partial/manual prior application is a no-op. Plain (not
-- CONCURRENTLY) because the Drizzle migrator wraps each migration in a
-- transaction; the tables are small enough that the brief build lock is fine.

-- sale_order ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "idx_sale_order_status_created"
  ON "sale_order" ("status", "created_at_local");
CREATE INDEX IF NOT EXISTS "idx_sale_order_channel_created"
  ON "sale_order" ("channel", "created_at_local");
CREATE INDEX IF NOT EXISTS "idx_sale_order_branch_updated"
  ON "sale_order" ("branch_id", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_sale_order_preorder_status"
  ON "sale_order" ("is_preorder", "status");
CREATE INDEX IF NOT EXISTS "idx_sale_order_customer"
  ON "sale_order" ("customer_id");

-- sale_order_item (the critical FK join index) -----------------------------
CREATE INDEX IF NOT EXISTS "idx_sale_order_item_order"
  ON "sale_order_item" ("sale_order_id");

-- sale_return --------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "idx_sale_return_status_created"
  ON "sale_return" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_sale_return_original"
  ON "sale_return" ("original_sale_order_id");

-- production_run_item (backs the batched item load) ------------------------
CREATE INDEX IF NOT EXISTS "idx_production_run_item_run"
  ON "production_run_item" ("production_run_id");
