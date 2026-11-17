# Unified inbox (WhatsApp + calls): handoff

Branch `work/olu/unified-inbox`. Built 17 Nov 2026 by Olu with Claude. Nothing has touched production.

## What it is

Staff answer WhatsApp chats and business phone calls in one place, inside the existing admin app at `admin.mrssamuel.com/inbox`. Each customer's messages, calls, recordings, transcripts and AI call summaries sit on one timeline. It is built into the existing stack (Hono API, Drizzle, Vite admin app, worker, R2), not as a new app.

It is all switched off until the Meta and Twilio settings below are filled in. The shop keeps running exactly as before without them.

## What Tes has to do, in order

| # | Step | Who | Undo |
|---|---|---|---|
| 1 | Review and merge the PR | Tes | Revert the merge commit |
| 2 | Apply migration `0070_unified_inbox.sql` | Tes | Drop the `inbox_*` tables and `inbox_*` types. Nothing else depends on them. |
| 3 | Add the env vars below on the server, then restart the api and worker | Tes | Remove the vars; the features switch off again |
| 4 | Point the Meta and Twilio webhooks at the URLs below | Tes / Olu | Clear the webhook URLs |
| 5 | In Inbox settings: add the team(s), the number(s), hours and the phone menu; grant staff access | Owner | Edit in the same screens |

**Migration 0070 is additive only.** It creates new tables and types. It does not change or read any existing table. Customers are matched to existing `customer` rows by phone number. A row is only added when no customer matches, and the only change ever made to an existing customer is filling a blank name.

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

- **Unit tests pass locally:** shared 52, domain 22.
- **Integration tests haven't run here (no Docker on this Mac); CI runs them.** They cover the WhatsApp webhook, the 24-hour rule, access scope and the voice webhooks: `apps/api/test/integration/inbox-whatsapp.test.ts` and `inbox-voice.test.ts`.
- **Never run against real Meta or Twilio.** Please check these against the provider docs on the test number before go-live:
  - Twilio: `<Client><Identity>` with `<Parameter>`, `recordingStatusCallbackEvent` on `<Dial>` and `<Record>`, and `RequestedChannels=2` on dual-channel recording downloads.
  - Meta: the Graph API version, and the `phone_number_quality_update` payload fields.
- **Assumes one worker process.** Recording jobs don't lock rows.
