DO $$ BEGIN
 CREATE TYPE "public"."daily_close_status" AS ENUM('draft', 'submitted', 'approved', 'disputed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_close" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" "daily_close_status" DEFAULT 'draft' NOT NULL,
	"cash_counted_ngn" integer DEFAULT 0 NOT NULL,
	"transfers_counted_ngn" integer DEFAULT 0 NOT NULL,
	"system_cash_total_ngn" integer DEFAULT 0 NOT NULL,
	"variance_ngn" integer DEFAULT 0 NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_close_branch_id_business_date_unique" UNIQUE("branch_id","business_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_close_stock_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"daily_close_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"system_quantity" integer NOT NULL,
	"counted_quantity" integer NOT NULL,
	"variance" integer NOT NULL,
	"variance_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_close" ADD CONSTRAINT "daily_close_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_close" ADD CONSTRAINT "daily_close_submitted_by_user_id_admin_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_close" ADD CONSTRAINT "daily_close_approved_by_user_id_admin_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_close_stock_count" ADD CONSTRAINT "daily_close_stock_count_daily_close_id_daily_close_id_fk" FOREIGN KEY ("daily_close_id") REFERENCES "public"."daily_close"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_close_stock_count" ADD CONSTRAINT "daily_close_stock_count_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
