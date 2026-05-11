DO $$ BEGIN
 CREATE TYPE "public"."stock_transfer_status" AS ENUM('draft', 'dispatched', 'in_transit', 'arrived', 'received', 'received_with_variance', 'rejected', 'completed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."stock_transfer_variance_reason" AS ENUM('short_shipped', 'damaged_in_transit', 'wrong_item', 'extra_received', 'count_error_at_branch', 'other_with_note');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_number" text NOT NULL,
	"factory_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" "stock_transfer_status" DEFAULT 'draft' NOT NULL,
	"dispatched_by_user_id" uuid,
	"dispatched_at" timestamp with time zone,
	"received_by_user_id" uuid,
	"received_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" uuid,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"vehicle_info" text,
	"driver_name" text,
	"manifest_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_transfer_number_unique" UNIQUE("transfer_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_transfer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_sent" integer NOT NULL,
	"quantity_received" integer,
	"variance_reason" "stock_transfer_variance_reason",
	"unit_cost_ngn" integer,
	"notes" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_factory_id_factory_id_fk" FOREIGN KEY ("factory_id") REFERENCES "public"."factory"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_dispatched_by_user_id_admin_user_id_fk" FOREIGN KEY ("dispatched_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_received_by_user_id_admin_user_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_approved_by_user_id_admin_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_rejected_by_user_id_admin_user_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_stock_transfer_id_stock_transfer_id_fk" FOREIGN KEY ("stock_transfer_id") REFERENCES "public"."stock_transfer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
