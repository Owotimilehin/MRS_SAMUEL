-- shift_open becomes a session
ALTER TABLE "shift_open" ADD COLUMN "status" text NOT NULL DEFAULT 'open';
ALTER TABLE "shift_open" ADD COLUMN "closed_at" timestamptz;
ALTER TABLE "shift_open" ADD COLUMN "closed_by_user_id" uuid REFERENCES "admin_user"("id");
ALTER TABLE "shift_open" ADD COLUMN "shift_number" integer NOT NULL DEFAULT 1;
ALTER TABLE "shift_open" ADD CONSTRAINT "shift_open_status_check" CHECK ("status" IN ('open','closed'));

-- daily_close links to its shift
ALTER TABLE "daily_close" ADD COLUMN "shift_id" uuid REFERENCES "shift_open"("id");

-- backfill: close shifts that already have a daily_close; link the close (idempotent)
UPDATE "shift_open" so SET
  "status" = 'closed',
  "closed_at" = dc."submitted_at",
  "closed_by_user_id" = dc."submitted_by_user_id"
FROM "daily_close" dc
WHERE dc."branch_id" = so."branch_id" AND dc."business_date" = so."business_date";

UPDATE "daily_close" dc SET "shift_id" = so."id"
FROM "shift_open" so
WHERE so."branch_id" = dc."branch_id" AND so."business_date" = dc."business_date"
  AND dc."shift_id" IS NULL;

-- drop the one-per-day uniques
ALTER TABLE "shift_open" DROP CONSTRAINT IF EXISTS "shift_open_branch_id_business_date_unique";
ALTER TABLE "daily_close" DROP CONSTRAINT IF EXISTS "daily_close_branch_id_business_date_unique";

-- collapse any pre-existing multiple open shifts per branch. Prod accumulated
-- one shift_open row per business_date (the old one-per-day unique); days
-- without a daily_close stayed 'open' after the backfill above, so a branch can
-- hold several open rows. Keep the latest open shift per branch open and close
-- the rest, so the partial unique index below can be created.
UPDATE "shift_open" SET "status" = 'closed', "closed_at" = COALESCE("closed_at", now())
WHERE "status" = 'open'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("branch_id") "id"
    FROM "shift_open"
    WHERE "status" = 'open'
    ORDER BY "branch_id", "business_date" DESC, "id" DESC
  );

-- enforce one OPEN shift per branch
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shift_open_one_open_per_branch" ON "shift_open" ("branch_id") WHERE "status" = 'open';
