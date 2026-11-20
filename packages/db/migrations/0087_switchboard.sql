-- The live call switchboard (suite /calls/switchboard), plus the call queue and
-- supervisor tools behind the owner's beta switch. Additive only: new nullable columns
-- on two inbox tables. No existing column, index or row is changed, and every new
-- column stays empty until someone uses the switchboard or switches the beta on, so
-- today's calls behave exactly as before. The beta switch itself is a row in
-- app_settings (key "call_features"), not a schema change; no row = OFF.
--   inbox_call.held_at           when the staff member put the call on hold (cleared on resume),
--                                so the board can show "on hold". Hold itself still happens in
--                                the browser only.
--   inbox_call.ring_user_id      the one person a call is ringing for after someone picked it up
--                                from the switchboard (or transferred it to a person), so that
--                                person may accept it even if they are not in the call's team.
--   inbox_call.queued_at         beta: when the caller started waiting in the call queue
--                                (cleared when they leave it).
--   inbox_call.conference_name   beta: the call was moved into this Twilio conference room so a
--                                supervisor could listen in.
--   inbox_call.agent_call_sid    beta: the staff member's leg in that conference (whisper target).
--   inbox_call.monitor_user_id   beta: the supervisor listening in, if any.
--   inbox_call.monitor_call_sid  beta: the supervisor's own leg in the conference.
--   inbox_call.monitor_mode      beta: 'listen' | 'whisper' | 'join'.
--   inbox_presence.away_set_by   the manager who marked this person away from the switchboard;
--                                the person's own heartbeat no longer switches them back on until
--                                they switch calls on again themselves.
--   inbox_presence.away_set_at   when that happened.
-- Safe to run twice (ADD COLUMN IF NOT EXISTS).
-- Undo: ALTER TABLE "inbox_call" DROP COLUMN "held_at";
--       ALTER TABLE "inbox_call" DROP COLUMN "ring_user_id";
--       ALTER TABLE "inbox_call" DROP COLUMN "queued_at";
--       ALTER TABLE "inbox_call" DROP COLUMN "conference_name";
--       ALTER TABLE "inbox_call" DROP COLUMN "agent_call_sid";
--       ALTER TABLE "inbox_call" DROP COLUMN "monitor_user_id";
--       ALTER TABLE "inbox_call" DROP COLUMN "monitor_call_sid";
--       ALTER TABLE "inbox_call" DROP COLUMN "monitor_mode";
--       ALTER TABLE "inbox_presence" DROP COLUMN "away_set_by";
--       ALTER TABLE "inbox_presence" DROP COLUMN "away_set_at";
--       DELETE FROM "app_settings" WHERE "key" = 'call_features';   (only if the owner saved it)

ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "held_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "ring_user_id" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "queued_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "conference_name" text;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "agent_call_sid" text;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "monitor_user_id" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "monitor_call_sid" text;
--> statement-breakpoint
ALTER TABLE "inbox_call" ADD COLUMN IF NOT EXISTS "monitor_mode" text;
--> statement-breakpoint
ALTER TABLE "inbox_presence" ADD COLUMN IF NOT EXISTS "away_set_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_presence" ADD COLUMN IF NOT EXISTS "away_set_at" timestamptz;
