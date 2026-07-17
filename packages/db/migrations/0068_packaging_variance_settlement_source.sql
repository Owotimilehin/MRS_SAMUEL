-- Owner-settled transfer variance can now relocate a short/over-shipped BAG
-- line back to the factory or branch. That packaging-ledger movement needs its
-- own source type. Bags are tracked-only, so a "loss" settlement writes no
-- ledger row (and no variance_loss, which is product-only) — the deliberate
-- choice is captured in the audit log instead. Only ADD the value here:
-- Postgres rejects USING a freshly added enum value in the same transaction,
-- and Drizzle runs all pending migrations in one transaction. The value is used
-- only at runtime.
ALTER TYPE "packaging_ledger_source_type" ADD VALUE IF NOT EXISTS 'transfer_variance_settlement';
