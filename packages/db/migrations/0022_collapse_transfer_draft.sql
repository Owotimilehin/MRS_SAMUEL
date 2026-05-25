-- Collapse the factory-side two-step (draft → dispatched) into a single
-- "send" action: POST /v1/transfers now creates rows already in `dispatched`.
-- The `draft` enum value is no longer reachable by the API.
--
-- Postgres enums can't drop values in place, so we use the cast-to-TEXT detour
-- (same pattern as migration 0017). Existing `draft` rows are moved to
-- `cancelled` first — no stock has moved for them, so this is safe.

ALTER TABLE stock_transfer ALTER COLUMN status DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE stock_transfer ALTER COLUMN status TYPE TEXT;
--> statement-breakpoint
UPDATE stock_transfer SET status = 'cancelled' WHERE status = 'draft';
--> statement-breakpoint
DROP TYPE stock_transfer_status;
--> statement-breakpoint
CREATE TYPE stock_transfer_status AS ENUM (
  'dispatched',
  'in_transit',
  'arrived',
  'received',
  'received_with_variance',
  'rejected',
  'completed',
  'cancelled'
);
--> statement-breakpoint
ALTER TABLE stock_transfer
  ALTER COLUMN status TYPE stock_transfer_status USING status::stock_transfer_status;
--> statement-breakpoint
ALTER TABLE stock_transfer
  ALTER COLUMN status SET DEFAULT 'dispatched'::stock_transfer_status;
