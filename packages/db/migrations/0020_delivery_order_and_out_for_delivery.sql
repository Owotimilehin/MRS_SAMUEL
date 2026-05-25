-- Adds the delivery_order table, the delivery enums, and inserts
-- 'out_for_delivery' into the sale_status enum.
--
-- TEXT-detour used for sale_status so this whole migration runs in a single
-- transaction (Drizzle migrator default). Same pattern as 0017.

------------------------------------------------------------------
-- 1) New enums
------------------------------------------------------------------
CREATE TYPE "delivery_provider" AS ENUM ('bolt', 'manual');
--> statement-breakpoint
CREATE TYPE "delivery_status" AS ENUM (
  'searching_rider', 'assigned', 'picked_up', 'in_transit',
  'delivered', 'failed', 'cancelled'
);
--> statement-breakpoint

------------------------------------------------------------------
-- 2) Insert 'out_for_delivery' into sale_status without breaking
--    same-transaction enum rule (PG won't let us ADD VALUE then USE).
------------------------------------------------------------------
ALTER TABLE "sale_order" ALTER COLUMN "status" TYPE TEXT;
--> statement-breakpoint
ALTER TABLE "sale_order" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
DROP TYPE "sale_status";
--> statement-breakpoint
CREATE TYPE "sale_status" AS ENUM (
  'draft', 'confirmed', 'paid', 'handed_over', 'out_for_delivery',
  'delivered', 'failed', 'cancelled', 'reconcile_needed'
);
--> statement-breakpoint
ALTER TABLE "sale_order"
  ALTER COLUMN "status" TYPE "sale_status" USING "status"::"sale_status";
--> statement-breakpoint
ALTER TABLE "sale_order" ALTER COLUMN "status" SET DEFAULT 'draft'::"sale_status";
--> statement-breakpoint

------------------------------------------------------------------
-- 3) New sale_order columns (mirror Bolt linkage at the order level)
------------------------------------------------------------------
ALTER TABLE "sale_order"
  ADD COLUMN IF NOT EXISTS "out_for_delivery_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sale_order"
  ADD COLUMN IF NOT EXISTS "delivery_provider_ref" text;
--> statement-breakpoint

------------------------------------------------------------------
-- 4) delivery_order table
------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "delivery_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sale_order_id" uuid NOT NULL REFERENCES "sale_order"("id") ON DELETE CASCADE,
  "provider" "delivery_provider" NOT NULL DEFAULT 'bolt',
  "external_ref" text,
  "status" "delivery_status" NOT NULL DEFAULT 'searching_rider',
  "pickup_branch_id" uuid NOT NULL REFERENCES "branch"("id"),
  "pickup_address" text NOT NULL,
  "pickup_lat" numeric(10, 6),
  "pickup_lng" numeric(10, 6),
  "dropoff_address" text NOT NULL,
  "dropoff_lat" numeric(10, 6),
  "dropoff_lng" numeric(10, 6),
  "quoted_fee_ngn" integer NOT NULL,
  "actual_fee_ngn" integer,
  "eta_minutes" integer,
  "rider_name" text,
  "rider_phone" text,
  "rider_vehicle" text,
  "tracking_url" text,
  "raw_webhook_json" jsonb,
  "fail_reason" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "assigned_at" timestamp with time zone,
  "picked_up_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_sale" ON "delivery_order" ("sale_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_status" ON "delivery_order" ("status", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_external_ref" ON "delivery_order" ("external_ref");
