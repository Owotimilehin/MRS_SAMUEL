-- The courier option the customer chose at checkout, encoded
-- `requestToken::courierId::serviceCode`. Threaded into dispatch so the worker
-- creates the label with the exact courier the customer paid for, rather than
-- re-picking the cheapest. NULL for orders with no delivery (pickup-less ₦0,
-- scheduled, outside-Lagos) and for all pre-existing rows.
ALTER TABLE "sale_order"
  ADD COLUMN IF NOT EXISTS "delivery_quote_ref" text;
