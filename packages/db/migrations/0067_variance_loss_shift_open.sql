-- Opening shift counts now reconcile branch on-hand to the physical count (like
-- the close already does), so the till stops selling against a stale expected
-- balance. A shortfall found at open is a genuine loss — record it under a new
-- 'shift_open' source. Only ADD the value here; Postgres rejects USING a freshly
-- added enum value in the same transaction, and Drizzle runs all pending
-- migrations in one transaction. The value is used only at runtime.
ALTER TYPE "variance_loss_source" ADD VALUE IF NOT EXISTS 'shift_open';
