CREATE TABLE IF NOT EXISTS "device_status" (
	"device_id" text PRIMARY KEY NOT NULL,
	"branch_id" uuid,
	"app_version" text,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_status" ADD CONSTRAINT "device_status_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
