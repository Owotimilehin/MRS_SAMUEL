# Unified inbox (WhatsApp + calls): handoff

Branch `work/olu/unified-inbox`. Built 17 Nov 2026 by Olu with Claude. Nothing has touched production.

## What it is

Staff answer WhatsApp chats and business phone calls in one place, inside the existing admin app at `admin.mrssamuel.com/inbox`. Each customer's messages, calls, recordings, transcripts and AI call summaries sit on one timeline. It is built into the existing stack (Hono API, Drizzle, Vite admin app, worker, R2), not as a new app.

It is all switched off until the Meta and Twilio settings below are filled in. The shop keeps running exactly as before without them.

## What Tes has to do, in order

| # | Step | Who | Undo |
|---|---|---|---|
| 1 | Review and merge the PR. **Merging to master deploys at once and the migrator applies `0070_unified_inbox.sql` automatically**, so the merge is the migration. | Tes | Revert the merge commit. The new tables stay behind harmlessly. |
| 2 | Only if the tables must go: drop the `inbox_*` tables and `inbox_*` types. Nothing else depends on them. | Tes | n/a |
| 3 | Add the env vars below on the server, then restart the api and worker | Tes | Remove the vars; the features switch off again |
| 4 | Point the Meta and Twilio webhooks at the URLs below | Tes / Olu | Clear the webhook URLs |
| 5 | In Inbox settings: add the team(s), the number(s), hours and the phone menu; grant staff access | Owner | Edit in the same screens |

**Migration 0070 is additive only.** It creates new tables and types. It does not change or read any existing table. Customers are matched to existing `customer` rows by phone number. A row is only added when no customer matches, and the inbox never changes an existing customer row. A per-phone lock stops two messages arriving together from creating duplicates.

## Env vars (names only)

| Where | Variables |
|---|---|
| api + worker | `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_SYSTEM_USER_TOKEN`, `META_GRAPH_VERSION` (e.g. `v23.0`) |
| api + worker | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_TWIML_APP_SID` |
| worker | `ANTHROPIC_API_KEY` (AI call summaries; off without it), optional `INBOX_SUMMARY_MODEL`, `INBOX_TEMPLATE_LANGUAGE` (default `en`) |
| existing | `PUBLIC_API_URL` must exactly match the URL Twilio calls, or every call is rejected. The `R2_*` vars are reused (the bucket is private). |

## Webhook URLs

- Meta (WhatsApp Manager → Configuration): `{PUBLIC_API_URL}/v1/webhooks/whatsapp`. Subscribe to `messages` and `phone_number_quality_update`.
- Twilio, each business number: "A call comes in" → `{PUBLIC_API_URL}/v1/voice/incoming`; status callback → `/v1/voice/status`.
- Twilio TwiML App (outbound calls from the browser): Voice URL → `/v1/voice/outbound`; status callback → `/v1/voice/status`.

## WhatsApp templates to create in WhatsApp Manager

| Name | Category | Used when |
|---|---|---|
| `missed_call_followup` | Utility | A call is missed, goes to voicemail or comes in after hours. Body variable `{{1}}` = customer's first name. |
| `conversation_reopen` | Utility | Staff need to reply more than 24 hours after the customer's last message |

## Who sees what

New permissions are added to the existing roles:

- Owner and Admin see every conversation on every number.
- Manager sees their teams' conversations, but only on the numbers they're granted.
- Branch staff get no inbox access by default.

Give a customer-care person inbox access with a per-user grant. A sensible set: `inbox.view`, `inbox.reply`, `inbox.notes`, `inbox.close`, `inbox.templates`, `calls.answer`, `calls.outbound`, `recordings.listen`, `transcripts.view`. Then add them to a team and grant them the number(s).

Someone who can't see a conversation gets "not found" (404), even through the API. Live updates and recording links follow the same rule. Recording plays, downloads and exports are written to the audit log.

## Decisions for Tes

1. **AI summary model.** The default is Claude Opus 5.5. Claude Haiku 5.5 costs about 1/40th as much per call and is probably good enough for short calls. Set `INBOX_SUMMARY_MODEL=claude-haiku-5-5` to switch. My recommendation is Haiku for v1.
2. **Transcription provider.** None is wired yet. Recordings are stored and playable, but there is no transcript, so there is no summary yet. Choosing a speech-to-text provider is a paid-service decision.
3. **Mobile app.** Not built yet. The web inbox works on a phone browser, but a closed phone can't ring or get a push until there's a native app (Expo) and Apple and Google developer accounts.

## Checked, and what still needs checking

- **Unit tests pass locally:** shared 52, domain 22, admin 153, mobile 29.
- **Integration tests ran locally against a throwaway Postgres 16** (no Docker here, so a stand-in replaced the test container): the 18 inbox tests pass, and 489 of the 500 API tests pass. The failing ones are in stock-transfer, date-window and migration-count tests that the inbox does not touch; CI is the real check for those.
- **First real run found a bug the type checker missed** (every inbound message failed to save); fixed in `a92fd62`. Migration 0070 applied cleanly on Postgres 16.
- **Smoke-tested on a local preview:** every inbox page endpoint, live updates, and each worker job once.
- **Never run against real Meta or Twilio.** Please check these against the provider docs on the test number before go-live:
  - Twilio: `<Client><Identity>` with `<Parameter>`, `recordingStatusCallbackEvent` on `<Dial>` and `<Record>`, and `RequestedChannels=2` on dual-channel recording downloads.
  - Meta: the Graph API version, and the `phone_number_quality_update` payload fields.
- **Assumes one worker process.** Recording jobs don't lock rows.

## Added in the second pass (17 Nov)

- **Calls:** transfer to another team; Hold (in the browser only: the customer hears silence, not music, and the call is still recorded); uploaded MP3/WAV greetings for the menu, the after-hours message and "play a message" options.
- **Records:** recordings are kept until someone deletes them. Staff with `recordings.delete` (Owner, Admin) can delete one recording. Staff with `inbox.erase` (Owner only) can erase a customer's whole inbox history on request, or merge a duplicate contact's chats into another contact. Neither touches the customer record or orders.
- **Long chats:** the timeline loads the newest 100 items and pages back.
- **Sending:** when WhatsApp never answers, the message shows amber "not confirmed" instead of red "failed". Missed-call follow-ups retry up to 3 times, only when the message certainly did not go out.
- **Worker:** inbox jobs run on their own loop beside the shop's jobs, and each takes a database lock, so a second worker is safe.
- **Phones:** a closed phone keeps ringing for 30 days after the app was last opened; dead push tokens are removed.
- **Staging:** `docker-compose.staging.yml` and `docs/runbooks/inbox-staging.md` (not yet run).
- **Load test:** `scripts/inbox-load-test.mjs`. Local result: 20 messages a second for 60 seconds with 50 live connections, 0 lost, 0 duplicated, 95% within 14 ms, about 15% of one core.
- **Shop fix included in this branch:** database rule errors now show their proper message instead of a server error in six places (see `2026-11-17-app-and-payments-audit.md`, A2).

Still to check on a real test call: that redirecting a call for transfer does not also trigger the old ring's result callback, and the Twilio details listed above.
