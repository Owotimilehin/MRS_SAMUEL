# Fireflies call transcripts and AI summaries: handoff

Branch `work/olu/fireflies-call-transcripts`. Built 22 Nov 2026 by Olu with Claude. Nothing has touched production.

## What it is

After every recorded phone call or voicemail, the suite sends the recording to Fireflies.ai. Fireflies returns:

- the **full transcript**, line by line, with who spoke and when;
- an **AI summary**: what the call was about, the reason for the call, action items, and the customer's mood.

Both show in the suite under **Calls → Call log** when you open a call, and on the customer's timeline in the inbox. The summary still shows on the **To call back** tab as before.

It replaces the empty speech-to-text slot in the recording pipeline. While Fireflies is on, the Claude call summariser is switched off for calls, so the two never write the same summary.

## How it works

1. A call ends. Twilio's recording is already copied into our private R2 bucket (unchanged).
2. Every 30 seconds the worker sends Fireflies a **signed download link that expires after 24 hours**, tagged with our recording id. The file is never public. The title Fireflies shows is just "Mrs Samuel call <date/time> UTC", with no names or numbers.
3. Fireflies transcribes the call, then calls `https://api.mrssamuel.com/v1/webhooks/fireflies`. The API checks the signature (unsigned or wrongly signed calls get a 401 and nothing changes), then marks the recording "ready". It does no slow work, so it answers in milliseconds.
4. Within 15 seconds the worker fetches the transcript and summary from Fireflies and saves them. The transcript usually arrives first (`meeting.transcribed`) and the summary a little later (`meeting.summarized`). Each one is saved as it arrives.

**Only recordings from the last 2 days are sent.** Switching it on does not bulk-send the old backlog. Older calls can be backfilled later if wanted.

## What Tes has to do, in order

| # | Step | Who | Undo |
|---|---|---|---|
| 1 | Review and merge the PR. **Merging to master deploys at once and the migrator applies `0088_call_transcripts.sql` automatically**, so the merge is the migration. | Tes | Revert the merge commit. The new columns stay behind harmlessly. |
| 2 | Check the two settings below are in `/opt/mrs-samuel/.env` on the server (Olu has added them), then `docker compose up -d` so the api and worker pick them up. | Tes / Olu | Remove the two lines and restart; it switches off. |
| 3 | Add the two names to `.env.production.example` (Claude's guard blocks it from opening that file). | Tes | n/a |
| 4 | Make one test call, leave 30 seconds of talking, hang up. Within about 5 minutes the call should show a transcript and summary under Calls → Call log. | Olu | n/a |

**Migration 0088 is additive only.** It adds four empty columns to `inbox_recording` (`fireflies_sent_at`, `fireflies_meeting_id`, `fireflies_ready_at`, `transcript_lines`) and one index. It does not change any existing data. The undo is written at the top of the file.

## Settings (names only)

| Where | Variable | What |
|---|---|---|
| worker | `FIREFLIES_API_KEY` | Fireflies → Integrations → Fireflies API. Empty = the feature is off. Tested working on the server on 22 Nov. |
| api | `FIREFLIES_WEBHOOK_SECRET` | Must match the signing secret entered in Fireflies → Integrations → API → Webhook. Empty = the webhook answers 401. |

The signing secret must be a freshly generated one (`openssl rand -hex 32`), **not** the one typed into the chat on 22 Nov, which should be treated as exposed.

## Fireflies webhook settings

- URL: `https://api.mrssamuel.com/v1/webhooks/fireflies`
- Events: `meeting.transcribed` and `meeting.summarized`
- Signing secret: the value of `FIREFLIES_WEBHOOK_SECRET`

Meetings recorded in Fireflies for other reasons (for example Olu's own Zoom calls) also reach this webhook. They are ignored, because only recordings the suite sent can be matched.

## Known limits and open decisions

1. **Speaker names.** Fireflies labels speakers itself, usually "Speaker 1 / Speaker 2" on phone audio. The transcript shows those labels. Whether it splits customer and staff correctly on our recordings is untested; check it on the first real calls. If it is poor, a follow-up can name the speakers from what the call record already knows (the customer and the staff member who answered).
2. **Pidgin and Nigerian English.** Fireflies has no Nigerian English or Pidgin language setting. Accuracy on our calls needs checking on real calls before staff rely on it.
3. **Fireflies keeps a copy.** Every call also sits in the Fireflies account as a "meeting", and anyone with access to that account can read it. Deleting a recording in the suite removes our copy only, not Fireflies'. Decision for Tes: accept this, or add a follow-up to delete the Fireflies copy once fetched.
4. **Webhook only.** If Fireflies' webhook never arrives (it retries 5 times over about 2.5 hours), the call stays on "Transcript and summary on the way…". The reason is in `inbox_recording.last_error` / the worker log. A follow-up could poll Fireflies as a fallback.
5. **Plan.** Uploading audio through the API needs Fireflies Pro or higher. Mood (sentiment) also needs Pro; without it, mood shows as neutral.
6. **Privacy.** Call audio now goes to Fireflies (a US company) for transcription. Callers already hear "This call may be recorded for quality and training." Consider whether the privacy policy should mention transcription by a third party.

## Tests

- `apps/worker/src/jobs/inbox-fireflies.test.ts`: the Fireflies client (upload, errors, missing sentiment), converting a Fireflies transcript into lines, text, action items, mood and summary, and the signed link checked against AWS's published example. 11 tests, passing.
- `apps/worker/src/jobs/inbox-fireflies-db.test.ts`: against a real Postgres. Only recent recordings are sent, once; failed uploads are retried; nothing happens while switched off; the transcript is saved first, then the summary; a missing transcript is recorded as a failure. Needs Docker, so it runs in CI.
- `apps/api/test/integration/fireflies-webhook.test.ts`: unsigned and wrongly signed calls are rejected, a sent recording is marked ready, legacy payload names work, and unknown recordings, events and meetings are ignored. Needs Docker, so it runs in CI.
