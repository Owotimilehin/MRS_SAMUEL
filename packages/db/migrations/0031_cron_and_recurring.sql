CREATE TABLE "cron_run" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_name"  text NOT NULL,
  "run_for"   text NOT NULL,
  "fired_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_cron_job_run_for" UNIQUE ("job_name", "run_for")
);

CREATE TABLE "recurring_expense" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "category_code"       "business_expense_category" NOT NULL,
  "amount_ngn"          integer NOT NULL,
  "vendor_name"         text,
  "description"         text,
  "reason_note"         text,
  "day_of_month"        integer NOT NULL,
  "starts_on"           date NOT NULL,
  "ends_on"             date,
  "active"              boolean NOT NULL DEFAULT true,
  "recorded_by_user_id" uuid REFERENCES "admin_user"("id"),
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_recurring_active" ON "recurring_expense" ("active");
CREATE INDEX "idx_recurring_dom"    ON "recurring_expense" ("day_of_month");
