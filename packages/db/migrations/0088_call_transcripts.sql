-- Fireflies call transcripts. Additive only: four nullable columns on
-- inbox_recording. Safe to run twice (IF NOT EXISTS everywhere).
--   inbox_recording.fireflies_sent_at     when the worker sent the recording to Fireflies; null = not sent
--   inbox_recording.fireflies_meeting_id  Fireflies' id for the transcript (from its webhook)
--   inbox_recording.fireflies_ready_at    set by the webhook when Fireflies says a result is ready;
--                                          cleared by the worker once it has fetched it
--   inbox_recording.transcript_lines      the transcript line by line: [{speaker, text, start_s, end_s}]
-- Undo: ALTER TABLE "inbox_recording" DROP COLUMN "fireflies_sent_at", DROP COLUMN "fireflies_meeting_id",
--         DROP COLUMN "fireflies_ready_at", DROP COLUMN "transcript_lines";
--       DROP INDEX "idx_inbox_rec_fireflies_ready";

ALTER TABLE "inbox_recording" ADD COLUMN IF NOT EXISTS "fireflies_sent_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_recording" ADD COLUMN IF NOT EXISTS "fireflies_meeting_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_recording" ADD COLUMN IF NOT EXISTS "fireflies_ready_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_recording" ADD COLUMN IF NOT EXISTS "transcript_lines" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_rec_fireflies_ready" ON "inbox_recording" ("fireflies_ready_at") WHERE "fireflies_ready_at" IS NOT NULL;
