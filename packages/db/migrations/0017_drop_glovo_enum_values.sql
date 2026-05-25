-- Drop all glovo enum values via TEXT detour: cast column to TEXT, move
-- legacy rows to their replacement, drop the old enum, create the new one,
-- cast column back.
------------------------------------------------------------------
-- 1) sale_channel: drop glovo_pickup, rename to whatsapp
------------------------------------------------------------------
ALTER TABLE sale_order ALTER COLUMN channel TYPE TEXT;
--> statement-breakpoint
UPDATE sale_order SET channel = 'whatsapp' WHERE channel = 'glovo_pickup';
--> statement-breakpoint
DROP TYPE sale_channel;
--> statement-breakpoint
CREATE TYPE sale_channel AS ENUM ('walkup', 'online', 'phone', 'whatsapp', 'chowdeck_pickup');
--> statement-breakpoint
ALTER TABLE sale_order
  ALTER COLUMN channel TYPE sale_channel USING channel::sale_channel;
--> statement-breakpoint

------------------------------------------------------------------
-- 2) payment_method: drop glovo_external entirely
-- Used by both sale_order.payment_method and payment.method.
------------------------------------------------------------------
ALTER TABLE sale_order ALTER COLUMN payment_method TYPE TEXT;
--> statement-breakpoint
ALTER TABLE payment ALTER COLUMN method TYPE TEXT;
--> statement-breakpoint
UPDATE sale_order SET payment_method = 'chowdeck_external' WHERE payment_method = 'glovo_external';
--> statement-breakpoint
UPDATE payment SET method = 'chowdeck_external' WHERE method = 'glovo_external';
--> statement-breakpoint
DROP TYPE payment_method;
--> statement-breakpoint
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'transfer', 'chowdeck_external', 'replacement');
--> statement-breakpoint
ALTER TABLE sale_order
  ALTER COLUMN payment_method TYPE payment_method USING payment_method::payment_method;
--> statement-breakpoint
ALTER TABLE payment
  ALTER COLUMN method TYPE payment_method USING method::payment_method;
--> statement-breakpoint

------------------------------------------------------------------
-- 3) return_refund_method: drop glovo_external entirely
------------------------------------------------------------------
ALTER TABLE sale_return ALTER COLUMN refund_method TYPE TEXT;
--> statement-breakpoint
UPDATE sale_return SET refund_method = 'chowdeck_external' WHERE refund_method = 'glovo_external';
--> statement-breakpoint
DROP TYPE return_refund_method;
--> statement-breakpoint
CREATE TYPE return_refund_method AS ENUM (
  'cash', 'card_reversal', 'transfer', 'store_credit',
  'replacement', 'chowdeck_external', 'none'
);
--> statement-breakpoint
ALTER TABLE sale_return
  ALTER COLUMN refund_method TYPE return_refund_method USING refund_method::return_refund_method;
--> statement-breakpoint

------------------------------------------------------------------
-- 4) customer_source: glovo -> whatsapp
------------------------------------------------------------------
ALTER TABLE customer ALTER COLUMN source DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE customer ALTER COLUMN source TYPE TEXT;
--> statement-breakpoint
UPDATE customer SET source = 'whatsapp' WHERE source = 'glovo';
--> statement-breakpoint
DROP TYPE customer_source;
--> statement-breakpoint
CREATE TYPE customer_source AS ENUM ('walkup_anonymous', 'online', 'phone', 'whatsapp', 'chowdeck');
--> statement-breakpoint
ALTER TABLE customer
  ALTER COLUMN source TYPE customer_source USING source::customer_source;
--> statement-breakpoint
ALTER TABLE customer
  ALTER COLUMN source SET DEFAULT 'walkup_anonymous'::customer_source;
