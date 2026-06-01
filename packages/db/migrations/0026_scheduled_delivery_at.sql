-- scheduled_delivery_at: future delivery time chosen at checkout (NULL = now).
-- delivery_state: destination state (NULL/"Lagos" = in-area). When an order is
-- scheduled OR outside Lagos, the online payment webhook bypasses automated
-- Bolt dispatch and the owner fulfils it out-of-band.
ALTER TABLE "sale_order"
  ADD COLUMN IF NOT EXISTS "scheduled_delivery_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "delivery_state" text;
