-- The live call switchboard (suite /calls/switchboard). Additive only: new nullable
-- columns on two inbox tables. No existing column, index or row is changed, and every
-- new column is empty until someone uses the switchboard, so today's calls behave
-- exactly as before.
--   inbox_call.held_at          when the staff member put the call on hold (cleared on resume),
--                               so the board can show "on hold". Hold itself still happens in
--                               the browser only.
--   inbox_call.ring_user_id     the one person a call is ringing for after someone picked it up
--                               from the switchboard (or transferred it to a person), so that
--                               person may accept it even if they are not in the call's team.
--   inbox_presence.away_set_by  the manager who marked this person away from the switchboard;
--                               the person's own heartbeat no longer switches them back on until
--                               they switch calls on again themselves.
--   inbox_presence.away_set_at  when that happened.
-- Safe to run twice (ADD COLUMN IF NOT EXISTS).
-- Undo: ALTER TABLE "inbox_call" DROP COLUMN "held_at";
--       ALTER TABLE "inbox_call" DROP COLUMN "ring_user_id";
--       ALTER TABLE "inbox_presence" DROP COLUMN "away_set_by";
--       ALTER TABLE "inbox_presence" DROP COLUMN "away_set_at";

ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "held_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "ring_user_id" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_presence" ADD COLUMN IF NOT EXISTS "away_set_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_presence" ADD COLUMN IF NOT EXISTS "away_set_at" timestamptz;
