-- Recurring subscriptions. Today's subscription_plan is catalog-only and
-- public-subscriptions was lead-capture; this adds real per-customer
-- subscription instances + a charge ledger. Billing is self-managed: the first
-- payment (checkout SDK, save-card) yields a reusable Payaza token that the
-- worker charges each period.

-- Optional native-plan hint + fulfilment hint on the catalog row.
ALTER TABLE "subscription_plan"
  ADD COLUMN "payaza_plan_code"   text,
  ADD COLUMN "bottles_per_cycle"  integer;

CREATE TABLE "customer_subscription" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"          uuid NOT NULL REFERENCES "customer"("id"),
  "plan_id"              uuid NOT NULL REFERENCES "subscription_plan"("id"),
  "branch_id"            uuid NOT NULL REFERENCES "branch"("id"),
  "price_ngn"            integer NOT NULL,
  "period"               text NOT NULL,
  "status"               text NOT NULL DEFAULT 'pending',
  "payaza_token"         text,
  "payaza_customer_ref"  text,
  "current_period_start" timestamptz,
  "current_period_end"   timestamptz,
  "next_charge_at"       timestamptz,
  "last_charge_at"       timestamptz,
  "failed_attempts"      integer NOT NULL DEFAULT 0,
  "past_due_since"       timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "activated_at"         timestamptz,
  "cancelled_at"         timestamptz,
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

-- The worker sweeps for subscriptions whose next charge is due.
CREATE INDEX "idx_customer_subscription_due"
  ON "customer_subscription" ("status", "next_charge_at");
CREATE INDEX "idx_customer_subscription_customer"
  ON "customer_subscription" ("customer_id");

CREATE TABLE "subscription_charge" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id"      uuid NOT NULL REFERENCES "customer_subscription"("id") ON DELETE CASCADE,
  "period_start"         timestamptz NOT NULL,
  "period_end"           timestamptz NOT NULL,
  "amount_ngn"           integer NOT NULL,
  "status"               text NOT NULL,
  "processor_reference"  text,
  "sale_order_id"        uuid REFERENCES "sale_order"("id"),
  "failure_reason"       text,
  "attempted_at"         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_subscription_charge_subscription"
  ON "subscription_charge" ("subscription_id");
