-- Subscriptions are retired. Recurring billing existed only on Payaza's saved-card
-- API (chargePayazaToken); OPay — the live provider — has no merchant-initiated
-- equivalent, so the feature cannot be carried forward and the business does not
-- use it. Dropping it also unblocks removing Payaza entirely.
--
-- SAFETY GUARD FIRST. This migration destroys billing history, so it refuses to
-- run if any subscription was ever really used. The expectation is zero rows; if
-- that is wrong the deploy fails loudly HERE, before anything is dropped, rather
-- than silently deleting a customer's paid plan. Clear the data deliberately (or
-- drop this guard) if you truly intend to discard it.
DO $$
DECLARE
  live_subs   bigint;
  live_charge bigint;
BEGIN
  SELECT count(*) INTO live_subs   FROM customer_subscription;
  SELECT count(*) INTO live_charge FROM subscription_charge;
  IF live_subs > 0 OR live_charge > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop subscriptions: % subscription row(s) and % charge row(s) exist. Export or clear them first.',
      live_subs, live_charge;
  END IF;
END $$;

-- The enquiry inbox survives, repurposed. subscription_lead only ever captured
-- "someone tapped a plan CTA" (name, phone, slug) and had no writer at all, so no
-- lead was ever recorded. Rename rather than recreate so any historical row is
-- preserved, and widen the meaning of the slug column: it now records WHICH
-- enquiry this is — white_label or bulk_order.
ALTER TABLE "subscription_lead" RENAME TO "enquiry_lead";
ALTER TABLE "enquiry_lead" RENAME COLUMN "plan_slug" TO "enquiry_type";

-- Existing rows (if any) came from the subscription CTA; label them so the
-- column never carries an unexplained legacy value.
UPDATE "enquiry_lead" SET "enquiry_type" = 'legacy_subscription'
  WHERE "enquiry_type" NOT IN ('white_label', 'bulk_order');

-- Owner reads the inbox newest-first.
CREATE INDEX IF NOT EXISTS "idx_enquiry_lead_created" ON "enquiry_lead" ("created_at" DESC);

-- Drop in FK order: charge → subscription → plan.
DROP TABLE IF EXISTS "subscription_charge";
DROP TABLE IF EXISTS "customer_subscription";
DROP TABLE IF EXISTS "subscription_plan";
