CREATE TABLE IF NOT EXISTS "branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"phone" text,
	"manager_user_id" uuid,
	"delivery_zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "branch_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch" ADD CONSTRAINT "branch_manager_user_id_admin_user_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
