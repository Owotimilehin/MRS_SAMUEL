-- Add Shipbubble as a delivery provider option (switching off Bolt).
-- ADD VALUE IF NOT EXISTS is safe to re-run and does not require the value to
-- be used in the same transaction.
ALTER TYPE "delivery_provider" ADD VALUE IF NOT EXISTS 'shipbubble';
