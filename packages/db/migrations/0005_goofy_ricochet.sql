DO $$ BEGIN
 CREATE TYPE "public"."ledger_location_type" AS ENUM('factory', 'branch');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ledger_source_type" AS ENUM('production_run', 'transfer_dispatch', 'transfer_receive', 'transfer_reject_reverse', 'sale', 'sale_cancelled', 'return_restock', 'waste', 'adjustment', 'count_correction', 'opening_balance');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_type" "ledger_location_type" NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"source_type" "ledger_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_user_id" uuid,
	"note" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_recorded_by_user_id_admin_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ledger_loc_product" ON "stock_ledger" USING btree ("location_type","location_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ledger_occurred" ON "stock_ledger" USING btree ("occurred_at");