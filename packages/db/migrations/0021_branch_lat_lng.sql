-- Branch pickup coordinates for third-party delivery providers (Bolt).
-- Optional; null means the provider must geocode from the address text.

ALTER TABLE "branch"
  ADD COLUMN IF NOT EXISTS "lat" numeric(10, 6),
  ADD COLUMN IF NOT EXISTS "lng" numeric(10, 6);
--> statement-breakpoint

-- Seed the Ajao Estate branch with its known coordinates so the first
-- quote run has real lat/lng without manual data entry.
UPDATE "branch"
   SET "lat" = 6.554400, "lng" = 3.346900
 WHERE "code" = 'AJAO' AND "lat" IS NULL;
