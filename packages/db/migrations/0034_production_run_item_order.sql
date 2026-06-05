-- Give production_run_item a stable insertion order. The UUID primary key is
-- random, so without this column the draft listed flavours in an arbitrary
-- heap order rather than the sequence in which the factory appended them.
-- Existing rows backfill to created_at = now() (ties broken by id) — harmless
-- since they are already-completed runs.
ALTER TABLE "production_run_item"
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
