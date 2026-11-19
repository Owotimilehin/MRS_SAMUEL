-- Fixes from the review of money, orders and adverts. Additive only: five new nullable
-- columns on suite tables (ad_*, catalogue_*, channel_chat_setup). No existing shop table is altered, no index is added.
--   ad_account_link.busy_until            one account-wide claim, so two actions at the same moment
--                                         cannot both pass the daily cap; it expires by itself.
--   ad_draft.ad_account_id                the ad account a draft was confirmed and started against.
--   catalogue_link.order_updates_enabled_at   when the owner last switched order updates on, so a
--                                         status that changed before then is never announced.
--   catalogue_chat_order.ask_claimed_at   the one marker "Ask" and the worker both take before
--                                         sending "delivery or pickup?".
--   channel_chat_setup.push_tries         every time a version was sent to Meta, so a "Try again"
--                                         counts towards the 10-minute limit (review M6).
-- Safe to run twice (ADD COLUMN IF NOT EXISTS).
-- Undo: ALTER TABLE "ad_account_link" DROP COLUMN "busy_until";
--       ALTER TABLE "ad_draft" DROP COLUMN "ad_account_id";
--       ALTER TABLE "catalogue_link" DROP COLUMN "order_updates_enabled_at";
--       ALTER TABLE "catalogue_chat_order" DROP COLUMN "ask_claimed_at";
--       ALTER TABLE "channel_chat_setup" DROP COLUMN "push_tries";

ALTER TABLE "ad_account_link" ADD COLUMN IF NOT EXISTS "busy_until" timestamptz;
--> statement-breakpoint
ALTER TABLE "ad_draft" ADD COLUMN IF NOT EXISTS "ad_account_id" text;
--> statement-breakpoint
ALTER TABLE "catalogue_link" ADD COLUMN IF NOT EXISTS "order_updates_enabled_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "catalogue_chat_order" ADD COLUMN IF NOT EXISTS "ask_claimed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "channel_chat_setup" ADD COLUMN IF NOT EXISTS "push_tries" timestamptz[];
