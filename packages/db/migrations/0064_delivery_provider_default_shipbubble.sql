-- Retire the Bolt integration: the delivery_order.provider column default was
-- 'bolt'. Move it off 'bolt' to the neutral 'manual' (inserts always set the
-- provider explicitly, so this default is never actually written — this just
-- keeps the schema honest). We use 'manual' rather than 'shipbubble' because
-- 'shipbubble' was added via ALTER TYPE ADD VALUE (0033) and Postgres forbids
-- using a freshly-added enum value in the same migration transaction; 'manual'
-- is an original CREATE TYPE value and is always safe. The 'bolt' enum LABEL is
-- left in place — Postgres cannot drop an enum value in one statement and no
-- rows reference it.
ALTER TABLE "delivery_order" ALTER COLUMN "provider" SET DEFAULT 'manual';
