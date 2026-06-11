-- Lookup index backing the find-or-create-by-phone customer identity rule
-- (resolveCustomer): repeat customers are matched by their canonical +234 phone
-- so their orders roll up into one record. Non-unique on purpose — pre-existing
-- rows already contain duplicate phones and merging is forward-only — and
-- partial on live rows so soft-deleted customers don't shadow a match.
CREATE INDEX IF NOT EXISTS "customer_phone_idx"
  ON "customer" ("phone")
  WHERE "deleted_at" IS NULL;
