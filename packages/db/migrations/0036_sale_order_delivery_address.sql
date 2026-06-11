-- The courier-validated dropoff captured at quote time. `delivery_address_code`
-- is Shipbubble's reusable address_code (stored as text) — reused at dispatch so
-- the rider routes to exactly the address that was quoted and confirmed, with no
-- re-geocoding of a raw string. `delivery_address_formatted` is the canonical
-- address we show the customer and store as the delivery address. Both NULL for
-- pickup-less / scheduled / outside-Lagos orders and all pre-existing rows.
ALTER TABLE "sale_order"
  ADD COLUMN IF NOT EXISTS "delivery_address_code" text,
  ADD COLUMN IF NOT EXISTS "delivery_address_formatted" text;
