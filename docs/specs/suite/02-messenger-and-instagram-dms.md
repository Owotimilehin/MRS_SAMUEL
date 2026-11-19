# Suite build spec 02 — Messenger and Instagram direct messages

Read `00-foundation.md` and spec 01 first. This spec makes direct messages on Facebook Messenger and Instagram arrive in the same inbox as WhatsApp, and lets staff answer them. Size L. Suggested model: Opus.

Meta facts are marked **[verified: URL, 19 Nov 2026]** or **[unverified]**. Three pages (the Send API reference, message tags, and Instagram sender actions) would not load without signing in; facts from them were read through a search-engine extract of the page and say so. Re-read those pages before coding against them.

---

## 1. Outcome

When this is finished, staff can say:

- "A message sent to our Facebook Page or our Instagram account shows up in the Inbox within seconds, with a small Facebook or Instagram mark, next to the WhatsApp chats."
- "I can filter the list to WhatsApp, Messenger or Instagram."
- "I can reply with text, a photo, a video, a voice clip or a PDF. The box tells me what this channel allows before I send."
- "If someone on the team answers from the Facebook or Instagram app instead, that answer shows in the chat too, so nobody answers twice."
- "I can see when my reply was delivered and read."
- "When a customer replies to our story, mentions us in their story, taps a button, reacts, edits or deletes a message, or arrives from an advert or a link, the chat says so in plain words."
- "After 24 hours without a message from the customer the reply box closes and tells me exactly what I can do."
- "I get the same sound, pop-up and phone notification as for WhatsApp, and it says which app the message came from."

## 2. Depends on

- **Spec 01**, merged or as the base branch: `kind` / `external_id` / `page_external_id` on `inbox_phone_number`, `inbox_identity`, `channel` and `identity_id` on conversations, `channel` on messages, `pageAccessToken()`, `findOrCreateCustomerByIdentity()`, `updateIdentityProfile()`, the `/v1/channels` routes and the Channels page.
- **People must do these in Meta before testing** (none is code):

| # | Step | Who | Check |
|---|---|---|---|
| P1 | Add the **Messenger** product and the **Instagram** product to the Meta app | Owner | Both show in the app dashboard |
| P2 | In the app dashboard → Webhooks → object **Page**: callback `https://api.mrssamuel.com/v1/webhooks/meta`, verify token = the value of `META_VERIFY_TOKEN`; subscribe the fields in M2 | Technical lead | Meta shows the callback as verified |
| P3 | Same for object **Instagram**, fields in M3 | Technical lead | Verified |
| P4 | Put the app in **Live** mode | Technical lead | Dashboard shows "Live" |
| P5 | In the Instagram app: Settings → Messages and story replies → Message controls → Connected tools → **Allow access to messages** | Owner | Toggle is on |
| P6 | Add two or three staff as **testers** on the Meta app, and have them accept | Technical lead | They appear under App roles |
| P7 | Set `META_APP_ID` on the server (the app's numeric ID; not a secret). Leave `META_HUMAN_AGENT_ENABLED` unset | Technical lead | `[ -n "$META_APP_ID" ] && echo set` |
| P8 | Connect the Page and Instagram on the suite's Channels page (spec 01) | Owner | Both rows say "On" |

- **Not needed to build and test:** app review, business verification. They are needed before real customers; see 3.7.

## 3. Meta reference

### 3.1 Webhooks

| # | Fact | Status |
|---|---|---|
| M1 | Messenger events arrive as `{"object":"page","entry":[{"id":"<PAGE_ID>","time":…,"messaging":[{ "sender":{"id":"<PSID>"},"recipient":{"id":"<PAGE_ID>"},"timestamp":…, … }]}]}`. Answer `200 OK` within 5 seconds. Meta retries a failed delivery; after 1 hour of failures it disables the webhook and **unsubscribes the app from the Page**, and we must subscribe again. Events can arrive out of order; sort by `timestamp` | [verified: https://developers.facebook.com/docs/messenger-platform/webhooks, 19 Nov 2026] |
| M2 | Page fields we subscribe to: `messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries`, `message_reads`, `messaging_referrals`, `message_reactions`, `message_edits`, `standby`, `messaging_handovers`, `messaging_policy_enforcement`. `message_echoes`, `message_deliveries`, `message_reads`, `message_edits` are Messenger only | [verified: https://developers.facebook.com/docs/messenger-platform/webhooks, 19 Nov 2026]; all eleven are in the allowed `subscribed_fields` list [verified: https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/, 19 Nov 2026] |
| M3 | Instagram events arrive with `"object":"instagram"`, `entry[].id` = the Instagram professional account ID, the customer in `sender.id` (Instagram-scoped ID) and our account in `recipient.id`. Fields: `messages`, `messaging_postbacks`, `messaging_seen`, `message_reactions`, `messaging_referral`, `standby`. On Instagram, messages **we** send also arrive on `messages`, with `is_echo: true` | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook, 19 Nov 2026]. A `message_edit` field with `mid`, `text`, `num_edit` is shown in [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples, 19 Nov 2026] |
| M4 | Meta's permission table for the Facebook-Login set-up lists only `messages` (and comments, mentions, story insights) for Instagram and marks `message_reactions`, `messaging_postbacks`, `messaging_referral`, `messaging_seen`, `standby` with "x" | [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields, 19 Nov 2026]. **This disagrees with M3.** Subscribe to all of them; code must work if only `messages` ever arrives (rule R22) |
| M5 | Whether `entry[].id` on Instagram events is the same number as `instagram_business_account.id` read from the Page (what spec 01 stores) | [unverified]. See section 14, Q3 |
| M6 | Subscribe a Page: `POST /{page-id}/subscribed_apps?subscribed_fields=<comma list>` with a Page token; needs `pages_manage_metadata` (and `pages_messaging` for messaging fields); answers `{"success": true}`. `GET` on the same edge lists subscribed apps, each with `subscribed_fields` | [verified: https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/, 19 Nov 2026] |
| M7 | Instagram fields cannot be set through `subscribed_fields` ("You cannot use the `subscribed_fields` parameter to configure or subscribe to Instagram Webhooks"). They are chosen in the app dashboard (P3). The linked Page must still have the app subscribed: Meta's Instagram set-up shows `POST /<FACEBOOK_PAGE_ID>/subscribed_apps?subscribed_fields=…` with the Page token | [verified: https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/ and https://developers.facebook.com/documentation/instagram-platform/webhooks/setup, 19 Nov 2026] |
| M8 | Instagram webhooks: the app must be Live; payloads are signed with `X-Hub-Signature-256` (`sha256=` + HMAC of the body with the app secret); unacknowledged notifications are retried for up to 36 hours, then dropped | [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup, 19 Nov 2026] |
| M9 | Timestamps in `messaging` events are milliseconds (example values have 13 digits) | [verified by example values: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages, 19 Nov 2026]; the unit is not stated in words, so rule R3 accepts both |

### 3.2 Event shapes (only the keys we read)

| # | Event | Shape and notes | Status |
|---|---|---|---|
| E1 | Message, text | `message: { mid, text, quick_reply?: { payload }, reply_to?: { mid, is_self_reply } }` | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages, 19 Nov 2026] |
| E2 | Message, attachments (Messenger) | `message.attachments: [{ type, payload }]`. Types: `image`, `video`, `audio`, `file` (`payload.url`); `sticker` (`url`, `sticker_id`); `fallback` (`url`, `title`; made when a person shares a link); `reel`, `ig_reel` (`url`, `title`, `reel_video_id`); `post`, `ig_post` (`url`, `title`, `id`); `template` (product); `appointment_booking`. Until 30 Aug 2026 a sticker also arrives as `image` with `sticker_id` | same page |
| E3 | Message, Instagram | Same envelope. Attachment types named: `image`, `video`, `audio`, `file`, `share`, `ig_post`, `story_mention`, `ig_reel`, `reel`, `story`, `ig_story`, `media`. Flags on `message`: `is_echo`, `is_deleted` (the customer unsent it), `is_unsupported`. `quick_reply.payload`. `reply_to: { mid }` or `reply_to: { story: { url, id } }` (a reply to our story). `referral` on a message from an advert: `ref`, `ad_id`, `source: "ADS"`, `type: "OPEN_THREAD"`, `ads_context_data` | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook and https://developers.facebook.com/documentation/instagram-platform/webhooks/examples, 19 Nov 2026] |
| E4 | Story mention | `message.attachments: [{ "type": "story_mention", "payload": { "url": "<CDN_URL>" } }]`. The story "disappears after 24 hours or when deleted"; then the link stops working. **"You must not store or cache the media content on your server."** Storing the link is allowed. Arrives only if the mentioning account is public, or follows us | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/story-mention, 19 Nov 2026] |
| E5 | Echo (Messenger) | `message: { is_echo: true, app_id, metadata?, mid, text?, attachments? }`; `sender.id` is the Page, `recipient.id` is the customer. `metadata` is the string we passed to the Send API. A message sent from the Page inbox carries `app_id` `26390203743090` | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-echoes, 19 Nov 2026] |
| E6 | Delivery (Messenger only) | `delivery: { mids?: [..], watermark }`. `mids` "may not be present"; everything sent before `watermark` was delivered | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-deliveries, 19 Nov 2026] |
| E7 | Read | Messenger: `read: { watermark }`, "all messages that were sent before or at this timestamp were read". Instagram (`messaging_seen`): `read: { mid }` | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-reads and https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook, 19 Nov 2026] |
| E8 | Postback | `postback: { mid, title, payload, referral?: { ref, source, type } }`. `payload` is sent only to the app that sent the button | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_postbacks, 19 Nov 2026] |
| E9 | Referral (existing thread) | `referral: { ref?, source: "SHORTLINK" \| "ADS", type: "OPEN_THREAD", ad_id?, ads_context_data?: { ad_title, photo_url?, video_url?, post_id, product_id? } }`. For a brand-new thread the referral comes inside the first postback or message instead | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_referrals, 19 Nov 2026] |
| E10 | Reaction | `reaction: { mid, action: "react" \| "unreact", reaction?: "love" \| "smile" \| …, emoji? }` | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-reactions, 19 Nov 2026] |
| E11 | Edit | `message_edit: { mid, text, num_edit }`; a person can edit at most five times | [verified: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-edits, 19 Nov 2026] |
| E12 | Standby | When our app is not the one in control of a conversation, its events arrive under `entry[].standby` instead of `entry[].messaging` (messages, deliveries, reads, postbacks without `payload`) | [verified: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/standby, 19 Nov 2026] |
| E13 | Who is in control | Answering in Meta Business Suite's inbox takes control for that inbox; control lapses after 24 hours without a customer message. With one connected app and no "default app" set, "all connected applications receive messaging webhooks" | [verified: https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing, 19 Nov 2026] |
| E14 | Instagram message requests | A first message from a stranger sits in the Instagram app's Requests folder. Whether the webhook fires for it before anyone accepts: [unverified]; Meta only says request conversations inactive for 30 days are not returned by the Conversations API | [verified for the 30-day note: https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversations, 19 Nov 2026] |
| E15 | Links to received media stop "returning media after content is deleted or expired" | [verified: https://developers.facebook.com/docs/messenger-platform/overview, 19 Nov 2026]. How long they last: [unverified]; we download at once (6.2) |

### 3.3 Sender profile

| # | Fact | Status |
|---|---|---|
| U1 | Messenger: `GET /{PSID}?fields=first_name,last_name,profile_pic` with the Page token. `name`, `first_name`, `last_name`, `profile_pic` need the feature **Business Asset User Profile Access** at advanced access. `profile_pic`: "The URL will expire." No profile → an empty object. Accounts made with a phone number → error `2018218` "No profile available for this user" | [verified: https://developers.facebook.com/docs/messenger-platform/identity/user-profile, 19 Nov 2026] |
| U2 | Whether U1 returns names for app testers before that feature is approved | [unverified]; rule R18 copes either way |
| U3 | Instagram: `GET /{IGSID}?fields=name,username,profile_pic` with the Page token. `name` and `profile_pic` can be null. `profile_pic` "expires after a few days". Works only after the person has messaged us (consent); otherwise the error "User consent is required to access the user profile". Needs `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/user-profile, 19 Nov 2026] |

### 3.4 Sending

| # | Fact | Status |
|---|---|---|
| S1 | `POST /{PAGE-ID}/messages` with the Page token, for Messenger **and** Instagram. Body `{"recipient":{"id":"<PSID or IGSID>"},"messaging_type":"RESPONSE","message":{"text":"…"}}`. Success: `{"recipient_id":"…","message_id":"…"}` | [verified: https://developers.facebook.com/docs/messenger-platform/send-messages and https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message, 19 Nov 2026] |
| S2 | A file by link: `"message":{"attachment":{"type":"image","payload":{"url":"…","is_reusable":true}}}`; `audio`, `video`, `file` use the same form. There is no caption | same pages |
| S3 | `messaging_type` values: `RESPONSE`, `UPDATE`, `MESSAGE_TAG` | [verified: https://developers.facebook.com/docs/messenger-platform/reference/send-api/, 19 Nov 2026, read through a search-engine extract] |
| S4 | Standard window: "For most user actions, it lasts 24 hours." It is opened by the person sending a message, tapping a button such as Get Started, clicking an m.me or ig.me link with a `ref` on an existing thread, or reacting to a message. After a click-to-message advert it "may last up to 7 days" | [verified: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview, 19 Nov 2026] |
| S5 | Human agent: `"messaging_type":"MESSAGE_TAG","tag":"HUMAN_AGENT"` lets a person answer "within 7 days of the person's message"; automated messages are not allowed; "your app must be approved before you can use the human agent tag" | [verified: https://developers.facebook.com/docs/messenger-platform/reference/send-api/, 19 Nov 2026, read through a search-engine extract]. The feature needs app review and business verification [verified: https://developers.facebook.com/docs/features-reference/human-agent, 19 Nov 2026] |
| S6 | From 27 Apr 2026 the tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` are refused with error 100. We use none of them | [verified: https://developers.facebook.com/docs/messenger-platform/send-messages, 19 Nov 2026] |
| S7 | Messenger text "must be UTF-8 and less than 2000 characters"; attachments at most 25 MB | [verified: https://developers.facebook.com/docs/messenger-platform/reference/send-api/, 19 Nov 2026, read through a search-engine extract]. Which file formats Messenger accepts: [unverified] (5.5 uses a cautious list) |
| S8 | Instagram limits: text "1,000 bytes or less" (the same page also says "less than 1,000 characters"); image `png`, `jpeg`, 8 MB; audio `aac`, `m4a`, `wav`, `mp4`, 25 MB; video `mp4`, `ogg`, `avi`, `mov`, `webm`, 25 MB; file `pdf`, 25 MB | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message, 19 Nov 2026] |
| S9 | Sender actions: `{"recipient":{"id":"…"},"sender_action":"typing_on" \| "typing_off" \| "mark_seen"}`, sent alone (no `message`) | [verified: https://developers.facebook.com/docs/messenger-platform/send-messages/sender-actions, 19 Nov 2026]. Typing switches off by itself after 20 seconds, and Instagram supports typing and seen since 23 Sep 2025: [verified through a search-engine extract of https://developers.facebook.com/docs/graph-api/reference/page/messages/ and https://developers.facebook.com/documentation/business-messaging/instagram-messaging/changelog, 19 Nov 2026] |
| S10 | Meta fetches a linked video for at most 75 seconds (error 100 / 2018294) | [verified: https://developers.facebook.com/docs/messenger-platform/error-codes, 19 Nov 2026] |
| S11 | Rate limits: 300 calls a second per Page (or Instagram account) for text; 10 a second for audio or video | [verified: https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting, 19 Nov 2026]. Far above this shop's volume; no throttle is built |
| S12 | The Send API accepts a `metadata` string that comes back on the echo | [verified for the echo side, E5]. That Instagram accepts and returns `metadata`: [unverified]; we send it on Messenger only |

### 3.5 Errors and how each maps to foundation D10

`MetaApiError` gains a `subcode` (5.1). Classification is by code **and** subcode; the first matching row wins. "Config" = stop, raise one owner alert per account per day, show the banner (R20). "Temporary" = retry (R19). "Refusal" = record on the message, show the sentence, do not retry.

| Code / subcode | Meta's meaning | Class | Sentence shown to staff |
|---|---|---|---|
| 190 | Token invalid | Config (after one retry with a fresh Page token) | "Our connection to Meta has expired. The owner has been told." |
| 10 / 2018278, 10 / 2018065, 10 / 2534022 | Sent outside the allowed window | Refusal | "{Channel} refused this: it is more than 24 hours since the customer last wrote." |
| 10 / 2018108, 200 / 1545041, 551 (any subcode) | The person can't receive our messages now | Refusal | "This person can't receive messages from us right now. They may have blocked us or closed their account." |
| 10 / 2018300, 100 / 2534037 | Another app controls the conversation | Refusal | "Another app is handling this chat for the Page. Ask the owner to check Conversation routing in Meta Business Suite." |
| 10 / 1893063, 2022 | Temporarily restricted for breaking a policy | Config | "Meta has paused messaging on {label}. The owner has been told." |
| 10 / 2534077, 100 / 2534013 | Can't verify the Instagram account is linked to the Page | Config | "Instagram is no longer linked to the Facebook Page. The owner has been told." |
| 200 / 2534041 | The account owner switched off message access | Config | "Message access is switched off in the Instagram app. The owner has been told." |
| 200 / 2018028, 200 (no subcode) | `pages_messaging` not approved for people outside the app's team | Config | "Meta has not yet approved us to message people outside the test team." |
| 10 (other), 299, 36103 | Permission problem | Config | "Meta says we are not allowed to do this. The owner has been told." |
| 100 / 2018001, 100 / 2534014 | No matching user | Refusal | "{Channel} can't find this person any more." |
| 100 / 2018008, 100 / 2018294 | Could not fetch the file from our link / video timed out | Refusal, `payload.retryable = true` | "{Channel} couldn't collect the file. Try sending it again." |
| 100 / 2018047, 100 / 2018109 | Wrong file type / too big | Refusal | "{Channel} doesn't accept this file (wrong type or too large)." |
| 100 (other) | Bad request | Refusal | "{Channel} refused this message." |
| 4, 17, 32, 613, 80007, 1, 2, HTTP 429, HTTP 5xx with an error body | Throttled or Meta-side trouble | Temporary | after retries: "{Channel} is busy. Try again in a minute." |
| No answer (timeout, dropped connection) | Unknown outcome | Existing "unconfirmed" state | existing amber text |
| anything else | — | Refusal | "{Channel} refused this message." |

Source for every code and subcode above: [verified: https://developers.facebook.com/docs/messenger-platform/error-codes, 19 Nov 2026], except `299` and `80007`, which come from foundation D10 and are [unverified] for these two APIs. In every case Meta's own code, subcode and message are kept in `error_code` (as `"<code>/<subcode>"`) and `payload.meta_message`.

### 3.6 Per-channel limits used by this spec

| | WhatsApp (unchanged) | Messenger | Instagram |
|---|---|---|---|
| Text | 4096 characters | 1999 characters | 1000 bytes of UTF-8 |
| Templates | yes | no | no |
| Caption on a file | yes | no | no |
| Reply after 24 h | approved template | only with Human Agent on, up to 7 days | same as Messenger |
| Delivered / read ticks | both | both | read only |

### 3.7 Access levels and app review

- **Standard access** (now): every permission works for people with a role on the Meta app; "Business apps are automatically approved for Standard Access for all permissions and features" [verified: https://developers.facebook.com/docs/graph-api/overview/access-levels, 19 Nov 2026]. So testers (P6) can message the Page and Instagram and be answered. Everything in this spec except Human Agent must work this way.
- **Advanced access** (before real customers): needs app review per permission and business verification [verified: same page]. Meta's Messenger overview also says app review is not needed "if you only message for your own Facebook Page" [verified: https://developers.facebook.com/docs/messenger-platform/overview, 19 Nov 2026], while error 200 / 2018028 says non-admins can't be messaged until `pages_messaging` is reviewed. These disagree; see section 14, Q1.

**Submit for advanced access:** `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_messages`, `business_management` (a dependency Meta asks to be noted), and the features **Human Agent** and **Business Asset User Profile Access**.

**What the submission needs** [verified: https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide, 19 Nov 2026]: one written description per permission and feature; at least one successful API call per permission in the 30 days before submitting; a screen recording for each (1080p or better, English screens, no sound needed, mouse not keyboard); a way for the reviewer to get in (a test login for the suite, never a personal account); app icon, privacy policy address (`https://mrssamuel.com/privacy`), category and contact e-mail. Meta's Messenger review page adds: the Page must be published and the webhook must answer `200` within 20 seconds [verified: https://developers.facebook.com/docs/messenger-platform/app-review, 19 Nov 2026].

**The screen recording must show, in this order** (one take per permission is acceptable if each is named on screen):

1. Signing in to `suite.mrssamuel.com` as a staff member.
2. *(pages_show_list, pages_manage_metadata, instagram_basic)* Channels → "Connect Facebook or Instagram": the Page and its Instagram account listed by name; connecting them; the row showing "On" and "Receiving messages".
3. *(pages_messaging)* A test Facebook user sends "Hello" to the Page in Messenger (phone beside the screen or a second window); the message appears in the Inbox with the Facebook mark; the staff member types a reply and sends; the reply arrives in Messenger; the "Read" tick appears.
4. *(instagram_manage_messages)* The same with a test Instagram user and a direct message, then a reply to a story.
5. *(pages_read_engagement, Business Asset User Profile Access)* The contact panel showing the sender's name and picture under "Reaches you on".
6. *(Human Agent)* A chat whose last customer message is older than 24 hours: the notice "a person can still answer for 7 days", the staff member typing an answer by hand and sending it; a sentence on screen: "Only staff write these replies. Nothing is sent automatically."
7. *(business_management)* Meta Business settings showing the Page and Instagram account assigned to the system user (this replaces a log-in consent screen, which this app does not have). Whether reviewers accept that in place of a consent screen: [unverified].

## 4. Data

### 4.1 Migration `packages/db/migrations/0072_meta_messaging.sql`

```sql
-- Suite spec 02: Messenger and Instagram direct messages. Additive only.
-- inbox_message: where to fetch a received file from (cleared once stored), and when the
-- customer edited or deleted the message. inbox_phone_number: webhook subscription state
-- and the last configuration problem Meta reported for the account.
-- Undo: DROP INDEX idx_inbox_msg_media_url;
--   ALTER TABLE inbox_message DROP COLUMN media_url, DROP COLUMN edited_at, DROP COLUMN deleted_at;
--   ALTER TABLE inbox_phone_number DROP COLUMN webhook_subscribed_at, DROP COLUMN webhook_checked_at,
--     DROP COLUMN problem_code, DROP COLUMN problem_text, DROP COLUMN problem_at.

ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "media_url" text;
--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "edited_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_msg_media_url" ON "inbox_message" ("created_at")
  WHERE "media_url" IS NOT NULL AND "media_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "webhook_subscribed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "webhook_checked_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "problem_code" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "problem_text" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "problem_at" timestamptz;
```

Journal entry: `{ "idx": 71, "version": "7", "when": 1786300000000, "tag": "0072_meta_messaging", "breakpoints": true }`.

### 4.2 Drizzle (`packages/db/src/schema/inbox.ts`)

- `inboxMessage`: `mediaUrl: text("media_url")` with the comment "Meta's link to a received file. Short-lived: the worker downloads it to storage and sets this back to null. Never the durable copy (foundation D11)."; `editedAt`, `deletedAt` (`timestamp(..., { withTimezone: true })`). Extend the comment on `type` with the new values: `share | story_mention | referral | system`.
- `inboxPhoneNumber`: `webhookSubscribedAt`, `webhookCheckedAt`, `problemCode`, `problemText`, `problemAt`.

### 4.3 Values stored (no new columns needed)

| What | Where |
|---|---|
| Provider message ID | `inbox_message.wa_message_id` = `mid` (D3). Extra rows that have no `mid` of their own use a made-up, repeatable key: second and later attachments `"<mid>#2"`, `"<mid>#3"`; reaction `"react:<mid>:<timestamp>"`; referral `"ref:<sender id>:<timestamp>"`; postback without `mid` `"pb:<sender id>:<timestamp>"` |
| Raw event | `inbox_message.payload` = the `messaging[]` item (inbound) |
| Sent from another app | `payload.echo = { app_id }` on an outbound row with `sender_user_id = null` |
| Arrived while another app was in control | `payload.standby = true` |
| Story reply, advert, link, shared post | `payload.reply_to.story`, `payload.referral`, `payload.share = { url, title }` (these are parts of the raw event already) |
| Earlier text of an edited message | `payload.edits = [{ text, at }]`, newest last, at most 5 |
| File to remove from storage after the customer deleted the message | `payload.purge_key` |
| Human-agent send | `payload.tag = "HUMAN_AGENT"` on the outbound row |

## 5. Server

### 5.1 `packages/domain/src/inbox/meta.ts`

- `MetaApiError`: add a sixth constructor parameter `public readonly subcode: string | null = null`. In `graph()`, read `error.error_subcode` and pass it.
- `MetaConfig`: add `appId?: string` and `humanAgent?: boolean`. `metaConfigFromEnv` sets `appId` from `META_APP_ID` and `humanAgent` from `META_HUMAN_AGENT_ENABLED === "true"`. Add both names to `apps/api/src/env.ts` (optional strings).
- `graph()` network-error text: replace "Could not reach WhatsApp" / "No answer from WhatsApp" with "Could not reach Meta" / "No answer from Meta" (update any test that asserts the old words).

### 5.2 New file `packages/domain/src/meta/messaging.ts` (re-exported from the package index)

```ts
export const PAGE_WEBHOOK_FIELDS = ["messages","messaging_postbacks","message_echoes","message_deliveries",
  "message_reads","messaging_referrals","message_reactions","message_edits","standby",
  "messaging_handovers","messaging_policy_enforcement"] as const;

/** POST {pageId}/subscribed_apps?subscribed_fields=…  with the Page token. Throws MetaApiError. */
export function subscribePage(cfg: MetaConfig, pageId: string): Promise<void>;
/** GET {pageId}/subscribed_apps. True when an app with id cfg.appId lists every PAGE_WEBHOOK_FIELDS entry.
 *  When cfg.appId is unset: true when any app lists them all. */
export function isPageSubscribed(cfg: MetaConfig, pageId: string): Promise<boolean>;

export type MetaSendContent =
  | { type: "text"; body: string }
  | { type: "image" | "video" | "audio" | "document"; link: string };
export function buildMetaSendPayload(recipientId: string, content: MetaSendContent,
  opts: { humanAgent: boolean; metadata?: string }): Record<string, unknown>;
/** POST {pageId}/messages with the Page token; returns message_id. Retries once with a fresh token on code 190. */
export function sendMetaMessage(cfg: MetaConfig, pageId: string, recipientId: string,
  content: MetaSendContent, opts: { humanAgent: boolean; metadata?: string }): Promise<string>;
/** typing_on | mark_seen. Best effort: callers catch and ignore every error. */
export function sendSenderAction(cfg: MetaConfig, pageId: string, recipientId: string,
  action: "typing_on" | "mark_seen"): Promise<void>;

export interface SenderProfile { displayName: string | null; username: string | null; profilePicUrl: string | null }
/** Messenger: fields first_name,last_name,profile_pic. Instagram: name,username,profile_pic.
 *  Returns all-null (never throws) for: an empty object, code 2018218, a consent error, any non-retryable refusal.
 *  Throws only retryable errors, so the worker tries again later. */
export function fetchSenderProfile(cfg: MetaConfig, channel: "messenger" | "instagram",
  pageId: string, scopedId: string): Promise<SenderProfile>;

export type MetaErrorClass = "config" | "temporary" | "refusal";
/** Table 3.5. `channelName` is "Messenger" or "Instagram"; `label` is the account's label. */
export function classifyMessagingError(err: MetaApiError, channelName: string, label: string):
  { cls: MetaErrorClass; staffText: string; retryable: boolean };
```

`buildMetaSendPayload` output, exactly:

- text: `{ recipient: { id }, messaging_type, message: { text: body, metadata? } }`
- file: `{ recipient: { id }, messaging_type, message: { attachment: { type: <image|video|audio|file>, payload: { url: link, is_reusable: false } }, metadata? } }` (`document → "file"`)
- `messaging_type` is `"RESPONSE"`; when `opts.humanAgent` it is `"MESSAGE_TAG"` and a top-level `tag: "HUMAN_AGENT"` is added.
- `metadata` is included only when given.

### 5.3 New file `packages/domain/src/inbox/messenger-ingest.ts`

```ts
export interface MetaMessagingEvent { sender?: { id?: string }; recipient?: { id?: string }; timestamp?: number;
  message?: {...}; delivery?: {...}; read?: {...}; postback?: {...}; referral?: {...}; reaction?: {...}; message_edit?: {...} }
export interface MetaEntry { id?: string; time?: number; messaging?: MetaMessagingEvent[]; standby?: MetaMessagingEvent[]; changes?: { field?: string; value?: unknown }[] }
export interface MetaWebhookPayload { object?: "page" | "instagram" | string; entry?: MetaEntry[] }

/** "<object>.<field>" for inbox_webhook_event.kind (D6). */
export function metaEventKind(object: string, entry: MetaEntry): string;
/** Flatten one message into rows to insert. Pure; exported for tests. */
export function parseMetaMessage(channel: "messenger" | "instagram", m: NonNullable<MetaMessagingEvent["message"]>):
  Array<{ idSuffix: string; type: string; body: string | null; mediaUrl: string | null; mediaMime: string | null }>;
export class EchoBeforeSendError extends Error {}          // same idea as StatusBeforeSendError
export interface MetaIngestResult { messagesCreated: number; updates: number; unknownAccounts: string[]; inactive: boolean; ignored: boolean; policyAlert: boolean }
/** Apply one stored event (one entry). Run inside a transaction. */
export function ingestMetaEntry(db: DbExecutor, object: string, entry: MetaEntry, opts: { appId?: string; now?: Date }): Promise<MetaIngestResult>;
export function finishMetaWebhookEvent(db: DbExecutor, eventId: string, r: MetaIngestResult): Promise<void>;
export function unparkEventsForAccount(db: DbExecutor, kind: "messenger" | "instagram", externalId: string): Promise<number>;
```

**`metaEventKind`**: `entry.changes?.[0]?.field` → `"<object>.<field>"`. Else `entry.standby?.length` → `"<object>.standby"`. Else look at `entry.messaging?.[0]`: `message` → `"page.message_echoes"` when `object === "page"` and `message.is_echo`, otherwise `"<object>.messages"`; `delivery` → `"page.message_deliveries"`; `read` → `"page.message_reads"` / `"instagram.messaging_seen"`; `postback` → `"<object>.messaging_postbacks"`; `referral` → `"page.messaging_referrals"` / `"instagram.messaging_referral"`; `reaction` → `"<object>.message_reactions"`; `message_edit` → `"page.message_edits"` / `"instagram.message_edit"`; anything else → `"<object>.unknown"`.

**`ingestMetaEntry`**, step by step:

1. `kind = object === "page" ? "messenger" : "instagram"`. `account = channelAccountByExternalId(db, kind, entry.id)`. None → return with `unknownAccounts: ["<kind>:<entry.id>"]`. Found but `isActive === false` → return `inactive: true` and write nothing.
2. If `entry.changes` is present → return `ignored: true` (specs 03 and 13 add their handlers here).
3. For each event in `entry.messaging ?? []`, then each in `entry.standby ?? []` (standby events get `payload.standby = true`), in ascending `timestamp`:
   - `customerSideId` = `recipient.id` when `message?.is_echo`, else `sender.id`. Skip the event if it is missing or equals `entry.id`.
   - `at` = rule R3.
   - Dispatch on the first key present: `message` (echo or inbound) → 4 or 5; `delivery` → 6; `read` → 7; `postback` → 8; `referral` → 9; `reaction` → 10; `message_edit` → 11; none → skip. An event that has a key named `policy-enforcement` or `policy_enforcement` sets `policyAlert: true` and writes nothing else (the exact key name is [unverified]; accept both).
4. **Inbound message.**
   - `message.is_deleted` → rule R9, then next event.
   - If a row with `wa_message_id = mid` exists → skip (duplicate).
   - `who = findOrCreateCustomerByIdentity(db, { channel: kind, accountExternalId: account.externalId, externalId: customerSideId })`; `findOrOpenConversation(db, who.customerId, account.id, at, { identityId: who.identityId })`.
   - `rows = parseMetaMessage(kind, message)`; insert each with `direction: "in"`, `status: "received"`, `channel: kind`, `wa_message_id = mid + idSuffix`, `payload = event`, `created_at = at`, `media_url`, `.onConflictDoNothing({ target: waMessageId })`.
   - If at least one row was inserted: `touchConversation(…, { preview: messagePreview(type, body) of the last row, inboundWa: at, unreadIncrement: true, at })`, then `publishInboxEvent` `message.created` with `direction: "in"` for the last row and `conversation.updated`.
5. **Echo** (`message.is_echo`). Rule R6.
6. **Delivery.** Rule R7.
7. **Read.** Rule R8.
8. **Postback.** As an inbound message with one row: `type: "interactive"`, `body = postback.title ?? "Tapped a button"`, key `postback.mid ?? "pb:<sender>:<timestamp>"`. Opens the window (`inboundWa`), counts as unread.
9. **Referral on an existing thread.** One row: `type: "referral"`, `direction: "in"`, `body` = `"Came from an advert: " + ad_title` when `source === "ADS"` (without the title: `"Came from an advert"`), else `"Opened the chat from a link"` + (`ref` ? ` (${ref})` : ""). Key `"ref:<sender>:<timestamp>"`. `touchConversation` with `inboundWa: at` (S4) and the preview, **no** unread increment; publish `message.created` **without** `direction` (so nobody is alerted) and `conversation.updated`.
10. **Reaction.** One row: `type: "reaction"`, `body` = `"Reacted " + emoji` for `action === "react"` (no emoji: `"Reacted to a message"`), `"Removed a reaction"` for `unreact`. Key `"react:<mid>:<timestamp>"`. `react` opens the window and counts as unread (as WhatsApp reactions do today); `unreact` does neither.
11. **Edit.** Find the row by `mid`. Not found → skip. Else push `{ text: <old body>, at: <old edited_at ?? created_at> }` onto `payload.edits` (keep the last 5), set `body = message_edit.text`, `edited_at = at`; publish `message.status`.

**`parseMetaMessage`** (first matching rule per attachment; `text` = `message.text ?? null`):

| Input | Rows |
|---|---|
| `is_unsupported` | one: `unsupported`, body "This message can't be shown here. Open the Instagram app to see it." |
| no attachments | one: `text`, body `text`. If `quick_reply` is present the type is `interactive` |
| attachment `image` with `payload.sticker_id`, or `sticker` | `sticker`, `mediaUrl = payload.url` |
| `image`, `video`, `audio` | same type, `mediaUrl = payload.url` |
| `file` | `document`, `mediaUrl = payload.url` |
| `story_mention` | `story_mention`, body "Mentioned you in their story", `mediaUrl = null` (E4: never downloaded; the link stays in `payload`) |
| `share`, `post`, `ig_post`, `reel`, `ig_reel`, `story`, `ig_story`, `media` | `share`, body = `"Shared a reel"` for the two reel types, `"Shared a story"` for the two story types, else `"Shared a post"`, plus `": " + title` when there is one; `mediaUrl = null` |
| `fallback` | `text`, body = `text ?? payload.title ?? payload.url ?? "Shared a link"` |
| anything else (`template`, `appointment_booking`, `location`, unknown) | `unsupported`, body "This message can't be shown here. Open the {Facebook\|Instagram} app to see it." |

The first row has `idSuffix: ""` and, when its body would otherwise be null, takes `text`; rows after it have `"#2"`, `"#3"`, …. If there are attachments **and** text and the first row already has a body of its own, add a final `text` row for `text`. `mediaMime` is always null here (the worker learns it from the download).

**`finishMetaWebhookEvent`**: `unknownAccounts` non-empty → `attempts = PARKED_ATTEMPTS`, `lastError = "unknown_account:" + list` (not processed). `inactive` → processed, `lastError = "account_inactive"`. `ignored` → processed, `lastError = "ignored"`. Otherwise processed, `lastError = null`. **`unparkEventsForAccount`** mirrors `unparkEventsForNumber` with `like 'unknown_account:%<kind>:<externalId>%'`.

### 5.4 New file `apps/api/src/routes/webhooks-meta.ts`, mounted as `app.route("/v1/webhooks/meta", metaWebhookRoutes(db));` after the WhatsApp line in `test-app.ts`

Copy `webhooks-whatsapp.ts` and change only what follows.

- `GET /`: identical handshake (`META_VERIFY_TOKEN`).
- `POST /`: 1 MB body limit; same signature check with `META_APP_SECRET`; bad signature → `401`, nothing stored. Unparseable JSON, or `object` other than `"page"` / `"instagram"` → `200 { ok: true }`, nothing stored.
- For **each** `entry`: insert one `inbox_webhook_event` row `{ source: "meta", kind: metaEventKind(object, entry), payload: { object, entry: [entry] } }`. Then, for each row in order, `processStoredMetaEvent(db, eventId, payload)`. Then `200 { ok: true }`. Total time must stay well under Meta's 5 seconds: no Graph call is made on this path.
- `export async function processStoredMetaEvent(db, eventId, payload)`: in one transaction `ingestMetaEntry(tx, payload.object, payload.entry[0], { appId: env.META_APP_ID })` then `finishMetaWebhookEvent`. On a thrown error: `attempts + 1`, `lastError = message`, leave unprocessed (the worker retries). After the transaction: for each unknown account call `alertOnce(db, "inbox.unknown_channel_account", { account: "<kind>:<id>", webhook_event_id })`; if `policyAlert`, `alertOnce(db, "inbox.meta_policy", { account: entry.id })`.
- `alertOnce(db, eventType, payload)`: the `alertUnknownNumbers` pattern, generalised and moved to `apps/api/src/lib/inbox-alerts.ts`: skip when an `outbox_event` of that type with the same `payload->>'account'` exists from the last 24 hours.

### 5.5 Sending: `packages/domain/src/inbox/send.ts`

`sendFromConversation(db, cfg, input, now)` keeps its signature and stays the **only** send function. It reads `conv.channel` and branches. The WhatsApp branch is the body it has after spec 01, unchanged. `InboxSendError` codes gain `"not_supported" | "too_long" | "no_recipient" | "account_off"`.

Messenger / Instagram branch, in order:

1. `!cfg` → `not_configured`, "Meta is not connected on this server".
2. Load conversation, line (`kind`, `page_external_id`, `label`, `is_active`), and the conversation's identity. Line inactive → `account_off`, "{label} is switched off. Switch it on under Channels to reply."
3. Recipient = the conversation's identity `external_id` when its `channel` equals the conversation's; else the customer's most recently seen identity for `(channel, account_external_id = line.external_id)`; none → `no_recipient`, "We don't have this person's {Channel} details yet. They need to write first."
4. `content.type === "template"` → `not_supported`, "Templates are only for WhatsApp."
5. A file with `caption` → `not_supported`, "{Channel} can't send a caption with a file. Send the text as its own message."
6. Text length: Messenger more than 1999 characters, or Instagram more than 1000 UTF-8 bytes (`Buffer.byteLength`) → `too_long`, "That is too long for {Channel}. Shorten it or send it in two parts."
7. Window: `age = now − last_inbound_wa_at`. Under 24 h → `humanAgent = false`. Otherwise, if `cfg.humanAgent === true` **and** `input.userId !== null` **and** age under 7 days → `humanAgent = true`. Otherwise → `window_closed`, "More than 24 hours since the customer last wrote. On {Channel} you can reply again once they write."
8. Insert the queued row (`channel`, `direction: "out"`, `status: "queued"`, `payload: humanAgent ? { tag: "HUMAN_AGENT" } : null`, media fields as today).
9. `sendMetaMessage(cfg, line.page_external_id, recipient, content, { humanAgent, metadata: channel === "messenger" ? "suite:" + row.id : undefined })`.
10. Success → `UPDATE … SET wa_message_id = :mid, status = 'sent' WHERE id = :row AND (wa_message_id IS NULL OR wa_message_id = :mid)`; then clear the line's `problem_*` columns if set.
11. Failure → rule R19 for temporary errors; otherwise store `status: "failed"`, `error_code = "<code>/<subcode>"`, `error_message = staffText`, `payload = { …, unconfirmed, retryable, meta_message }`. For class `config`: set the line's `problem_code`, `problem_text = staffText`, `problem_at = now` (the caller raises the alert: the route and the worker call `alertOnce(db, "inbox.meta_config", { account: line.external_id, code, text })` when the returned message has `payload.config === true`; set that flag here).
12. First-reply time, auto-assign, `touchConversation`, and the two signals: exactly as the WhatsApp branch.

### 5.6 Route changes

`apps/api/src/routes/inbox.ts`:

| Route | Change |
|---|---|
| `POST /conversations/:id/messages` | No new fields. `InboxSendError` → `409` with `details.reason` as today (new reasons included). After a send whose message has `payload.config === true`, call `alertOnce`. |
| `POST /uploads` | Body gains optional `conversation_id` (uuid). When given, load the conversation through `visibleConversation` and pick the rules for its channel (table below); without it, WhatsApp rules as today. Refusal text: "This kind of file can't be sent on {Channel}: {content_type}" / "This file is too large for {Channel} (limit {n} MB)". |
| `POST /conversations/:id/read` | For Messenger and Instagram conversations, instead of `markRead`: best-effort `sendSenderAction(cfg, pageId, recipient, "mark_seen")`; errors are logged at `warn` and ignored. |
| `POST /conversations/:id/typing` | After publishing the staff signal: if the conversation is Messenger or Instagram, the window is open, and no `typing_on` went to Meta for this conversation in the last 10 seconds (in-memory `Map<conversationId, number>`), fire `sendSenderAction(…, "typing_on")` without awaiting; ignore errors. |
| `GET /conversations` rows, `GET /conversations/:id` | Add `human_agent_remaining_ms` (0 unless `META_HUMAN_AGENT_ENABLED`; else ms left of the 7 days) and, on the detail's `number`, `problem_text`. |
| Timeline message rows | Add `channel`, `edited` (`edited_at is not null`), `deleted` (`deleted_at is not null`), `external_sender` (`direction = 'out' and sender_user_id is null and payload ? 'echo'`), `story_reply` (`payload #> '{message,reply_to,story}' is not null`), `link` (`payload->'share'->>'url'`, or the story-mention link `payload #>> '{message,attachments,0,payload,url}'` when `type = 'story_mention'` and the message is under 24 hours old, else null), `advert` (`payload #>> '{message,referral,ads_context_data,ad_title}'` when the referral source is `ADS`). `media_pending` becomes `(media_id is not null or media_url is not null) and media_key is null`. |

Upload rules (constant `UPLOAD_RULES` in `packages/shared/src/inbox.ts`, used by the server and by the composer; WhatsApp's entry is today's `INBOX_UPLOAD_TYPES`, moved):

| Channel | Type → limit |
|---|---|
| Messenger | `image/jpeg`, `image/png`, `image/gif` → image, 25 MB; `audio/mpeg`, `audio/mp4`, `audio/aac` → audio, 25 MB; `video/mp4` → video, 25 MB; `application/pdf`, `.docx`, `.xlsx` MIME types, `text/plain` → document, 25 MB (formats are [unverified], S7) |
| Instagram | `image/jpeg`, `image/png` → image, 8 MB; `audio/aac`, `audio/mp4`, `audio/wav`, `audio/x-wav` → audio, 25 MB; `video/mp4`, `video/quicktime`, `video/webm` → video, 25 MB; `application/pdf` → document, 25 MB (S8) |

`apps/api/src/routes/channels.ts` (from spec 01):

- `POST /connect`, at the marked place: `await subscribePage(cfg, page_id)`; on success set `webhook_subscribed_at = now` on every row of that Page; on `MetaApiError` keep the rows, set their `problem_text` = "Connected, but Meta would not switch on message delivery: {plain sentence}" and return `201` with them (the page shows the problem). Then `unparkEventsForAccount` for each connected row.
- `POST /:id/check`: additionally `isPageSubscribed`; if false, `subscribePage` and check again. Result `ok: false, problem: "Meta is not sending us messages for this Page. We tried to switch it back on; check again in a minute."` when still false. On success clear `problem_*`, set `webhook_checked_at`.
- `GET /` rows gain `webhook_subscribed_at`, `problem_text`, `problem_at`.

Audit: no new actions for sends (existing `inbox.message_send`). `channels.check` is not audited.

## 6. Worker

### 6.1 Jobs

All in `apps/worker/src/inbox-loop.ts`, each under `withJobLock`.

| Job | Every | What |
|---|---|---|
| `inbox_webhook_retry` (existing `retryWebhookEvents`) | 30 s | Branch on `payload.object`: `"whatsapp_business_account"` → today's path; `"page"` / `"instagram"` → `ingestMetaEntry` + `finishMetaWebhookEvent` in a transaction. Same back-off, same `MAX_WEBHOOK_ATTEMPTS`, same `inbox.webhook_dead` alert. Parked events are skipped by the existing `attempts < MAX` filter |
| `inbox_media` (existing `downloadPendingMedia`) | 10 s | 6.2 |
| `inbox_identity_profiles` (new, `apps/worker/src/jobs/inbox-meta.ts` → `refreshIdentityProfiles`) | 30 s | 6.3 |
| `inbox_meta_subscriptions` (new, same file → `ensureMetaSubscriptions`) | 60 min | 6.4 |

### 6.2 Media

- Add `delete(key: string): Promise<void>` to `RecordingStore` and `R2RecordingStore`.
- Second pass in `downloadPendingMedia`, after the WhatsApp pass: up to 10 rows where `media_url is not null and media_key is null and media_attempts < 5 and created_at > now() − 14 days and deleted_at is null`, oldest first. For each: `fetch(media_url, { signal: AbortSignal.timeout(60_000) })` with **no** authorization header. Refuse (`media_attempts = 5`, `error_message = "media download: too large"`) when `content-length` is over 26 MB (26 × 1024 × 1024). On `200`: read the bytes, MIME = the `content-type` header up to `;`, store at `inbox/media/<yyyy>/<mm>/<message id>.<ext>`, set `media_key`, `media_mime`, `media_url = null`, attempts + 1, publish `message.status`. On `403`, `404`, `410`: `media_attempts = 5`, `media_url = null`, `error_message = "media download: the link expired"`. Other failures: attempts + 1.
- Add to `EXT_BY_MIME`: `image/gif → gif`, `video/quicktime → mov`, `video/webm → webm`, `audio/wav → wav`, `audio/x-wav → wav`, `audio/x-m4a → m4a`.
- Third pass (purge): up to 20 messages where `payload ? 'purge_key'`: `store.delete(payload.purge_key)`, then remove the key from `payload`. A failed delete is retried on the next tick.
- Never download for `type = 'story_mention'` or `'share'` (they have no `media_url`).

### 6.3 Profiles

Select up to 20 identities with `channel in ('messenger','instagram')` and (`profile_fetched_at is null` or (`profile_fetched_at < now() − 3 days` and `last_seen_at > profile_fetched_at`)), oldest `profile_fetched_at` first (nulls first). For each: find the active line for `(channel, account_external_id)`; none → skip. `fetchSenderProfile(cfg, channel, pageId, external_id)`, then `updateIdentityProfile(db, id, { displayName, username, profilePicUrl })` passing only non-null values (so a failed look-up never wipes a known name) and always stamping `profile_fetched_at`. Then publish `conversation.updated` for that customer's open conversations on that line, so open screens show the name. A thrown (retryable) error: leave the row for the next tick; stop the batch if the error is class `config`.

The customer row is **not** updated (foundation D2). Screens fall back to the identity name (spec 01, `identity_name`).

### 6.4 Subscriptions

For each distinct `page_external_id` among active non-phone lines: `isPageSubscribed`; set `webhook_checked_at = now`. If false: `subscribePage`, set `webhook_subscribed_at`, and `logger.warn`. If either call throws: set `problem_text` = "Meta is not sending us messages for this Page: {plain sentence}", `problem_at`, and raise `inbox.meta_config` once a day (the worker inserts the `outbox_event` itself, with the same "none of this type for this account in the last 24 hours" check as `alertOnce`). This is the one unattended write to Meta in this spec. It changes nothing a customer can see; it restores delivery after Meta switches it off (M1). Owner switch: switching the channel off on the Channels page stops it.

### 6.5 Alerts (`apps/worker/src/outbox.ts`, three new cases, sent to the owner like `inbox.unknown_number`)

- `inbox.unknown_channel_account`: "📭 *Message for a Page or Instagram account that isn't connected*\nMeta sent a message for {account}. It is kept and will come in once you connect it under Channels.\n👉 {SUITE_URL}/channels"
- `inbox.meta_config`: "⚠️ *Messages are not going out on Facebook or Instagram*\n{text}\nMeta code {code}. Open Channels and press Check connection.\n👉 {SUITE_URL}/channels"
- `inbox.meta_policy`: "⚠️ *Meta sent a policy warning for the Page*\nOpen Meta Business Suite → Page quality to read it."

`SUITE_URL` comes from env `PUBLIC_SUITE_URL`, default `https://suite.mrssamuel.com`.

### 6.6 Push (`apps/worker/src/jobs/inbox-push.ts`)

Select `inbox_message.channel` with the pending rows. Title: `name || phone || identity name || "New {WhatsApp|Messenger|Instagram} message"`. Body: `"{Channel}: " + messagePreview(type, body)` cut to 120 characters, where `{Channel}` is "WhatsApp", "Messenger" or "Instagram". Rows of `type = 'referral'` are marked notified without a push.

## 7. Screens

All in `apps/admin/src` (both apps get them) unless marked suite-only.

### 7.1 Shared pieces

- New `components/inbox/ChannelIcon.tsx`: `({ channel, callsOnly?, size = 12 })` → `Phone` when `callsOnly`, else `MessageCircle` (whatsapp), `Facebook` (messenger), `Instagram` (instagram) from `lucide-react`, each with a `title`: "Phone calls", "WhatsApp", "Facebook Messenger", "Instagram".
- `packages/shared/src/inbox.ts`: `messagePreview` gains `share → "Shared a post"`, `story_mention → "Mentioned you in their story"`, `reaction → "Reacted to a message"`, `interactive → "Tapped a button"`, `referral → "Opened the chat"`, `unsupported → "Message"`. New `replyState()` (7.3). New `UPLOAD_RULES` and `uploadProblem(channel, file): string | null`. New `TEXT_LIMIT: Record<IdentityChannel, { max: number; unit: "characters" | "bytes" }>`.

### 7.2 Conversation list (`ConversationList.tsx`)

- Each row's chip shows `<ChannelIcon channel={row.channel} callsOnly={…} />` before the line label. The chip is now shown whenever the viewer has more than one line **or** more than one channel.
- New filter, a row of small toggle buttons above the selects, shown only when the viewer's lines cover more than one channel: **All**, **WhatsApp**, **Messenger**, **Instagram** (only the channels they have). `role="group"`, `aria-label="Show chats from"`. The choice is kept in `useInboxUi` and sent as `channel` (`ConversationFilters.channel`, `inboxApi.conversations` adds it to the query). At 390 px the buttons show icons only, with the name as `aria-label`.
- Search placeholder: "Search name, phone or username…".
- Empty state while a channel filter is on: title "No {Channel} chats here", hint "Try All, or another list."

### 7.3 Composer (`Composer.tsx`)

`replyState(conv, now)` in `inbox-logic.ts` returns everything the composer needs, so the rules are tested without React:

```ts
{ channel: "whatsapp" | "messenger" | "instagram";
  mode: "open" | "human_agent" | "closed" | "calls_only" | "off";
  tabLabel: string;            // "WhatsApp reply" | "Messenger reply" | "Instagram reply"
  statusText: string; canTemplate: boolean; canCaption: boolean;
  textLimit: { max: number; unit: "characters" | "bytes" }; accept: string }
```

| Situation | What staff see |
|---|---|
| Any channel, window open | Status line "Reply window open — {h}h {m}m left" (existing `windowText`) |
| Messenger / Instagram: no template button, no caption | The template button is not rendered. With a file chosen, the text box placeholder is "Add a message (sent separately)…"; on Send the file goes first, then the text as a second message |
| Attach button | `accept` from `UPLOAD_RULES[channel]`. On choosing a file, `uploadProblem` runs before any upload; a problem shows under the box in red and the file is not attached: "Instagram only takes JPEG or PNG pictures up to 8 MB.", "This file is too large for {Channel} (limit 25 MB).", "{Channel} can't send this kind of file." |
| Text limit | Instagram: counter "{bytes} / 1000" appears from 800 bytes; Send is disabled over the limit with "Too long for Instagram. Shorten it or send it in two parts." Messenger: `maxLength={1999}` |
| Messenger / Instagram, window closed, Human Agent **off** (the case today) | Status line "Reply window closed". In place of the box: "**You can't reply here right now.** {Channel} only lets a business reply within 24 hours of the customer's last message. What you can do: wait for them to write again (the box opens by itself); message them on WhatsApp or call if you have their number; or add a note for the team." Buttons: "Add a note" (switches to the note tab) and, when the contact has a phone number and the viewer may use a phone line, "Open their WhatsApp chat" (links to that conversation if one exists) |
| Messenger / Instagram, 24 h to 7 days, Human Agent **on** | Box stays open. Amber status line: "More than 24 hours since they wrote. You can still reply for {d} more day(s), by hand only." |
| Human Agent on, over 7 days | The closed notice above, with "7 days" in place of "24 hours" |
| Line switched off | "{label} is switched off, so replies can't be sent. Switch it on under Channels." |
| Line has `problem_text` | Red banner above the box: "Messages on {label} are not going out: {problem_text}" The box stays usable |
| WhatsApp | Exactly as today |

The tab label uses `tabLabel`; the WhatsApp icon on the tab becomes `<ChannelIcon>`. The textarea `aria-label` stays "Reply".

### 7.4 Timeline (`Timeline.tsx`, `MessageBubble`)

| Case | Rendering |
|---|---|
| `external_sender` | Above the bubble, where the staff name goes: "Sent from the Facebook or Instagram app" |
| `story_reply` | Small grey line above the text: "Replied to your story" |
| `type === "story_mention"` | "Mentioned you in their story." + link "View story" when `link` is set, else grey "The story is no longer available." Under it, grey: "Stories disappear after 24 hours." |
| `type === "share"` | Body text + link "Open" when `link` is set |
| `type === "referral"` | A centred grey system line (not a bubble) with the body |
| `advert` set | Chip under the bubble: "From an advert: {advert}" |
| `type === "interactive"` | Body in a bubble with the grey prefix "Tapped: " |
| `deleted` | Bubble content replaced by grey italic "The customer deleted this message." No media |
| `edited` | Grey "Edited" beside the time |
| Ticks | Messenger: as WhatsApp. Instagram: "✓" sent, blue "✓✓" read (there is no delivered state) |
| Failed | "Not sent: {error_message}" as today; `error_message` is already the plain sentence from 3.5 |
| `type === "unsupported"` | The stored body (replaces "Unsupported message (…)" for these channels) |

### 7.5 Header, contact panel, notifications

- `ConversationHeader.tsx`: `<ChannelIcon>` before the line label.
- Contact panel: no change beyond spec 01; names and pictures now fill in by themselves.
- `useInboxNotifier.ts`: fallback title "New {WhatsApp|Messenger|Instagram} message" from `conv.channel`. In-app toast: "New {Channel} message from {title}: {body}". Desktop pop-up title: "{title} · {Channel}". `shouldAlertForEvent` is unchanged (referral rows carry no `direction`, so they never alert).
- `NotifySettings.tsx`: the description line becomes "Sound and pop-ups for new customer messages on WhatsApp, Messenger and Instagram."

### 7.6 Channels page (suite-only, `apps/suite/src/features/channels/ChannelsPage.tsx`)

- Status column for Page and Instagram rows: green "On · receiving messages" when `webhook_subscribed_at` is set and `problem_text` is null; amber "On · not receiving messages yet" when `webhook_subscribed_at` is null; red "Problem" with `problem_text` beneath when set.
- Under the list, a card "Before customers outside the team can message you" with the three plain lines: "Meta must verify the business.", "Meta must review the app (the technical lead submits this).", "Until then, only people added as testers can be answered."

### 7.7 States for every changed screen

Loading, empty and error states are the existing `DataState` ones. No new permission: reading needs `inbox.view`, replying `inbox.reply` plus access to the line, exactly as WhatsApp.

## 8. Rules and edge cases

- **R1.** The webhook stores before it processes, answers `200` for every correctly signed body, and never calls Meta.
- **R2.** One stored event per `entry`. Processing an event twice changes nothing (unique `wa_message_id`, forward-only statuses).
- **R3.** Time of an event: `timestamp` if it is a number; values above `10^12` are milliseconds, others seconds; missing → now.
- **R4.** An event for an account that is not connected is parked and the owner is told once a day; connecting the account replays it.
- **R5.** An event for a switched-off account is marked processed and creates nothing.
- **R6.** Echo. (a) A row with that `mid` exists → set `status = 'sent'` if it was `queued`; done. (b) `metadata` is `"suite:<uuid>"` and that outbound row exists with no `wa_message_id` → set its `wa_message_id = mid`, `status = 'sent'`; done. (c) `cfg.appId` is set, `app_id` is present and differs → it was sent elsewhere: go to (e). (d) The event is younger than 20 seconds → throw `EchoBeforeSendError` (our own send may not have saved its `mid` yet; the worker retries in about a minute). (e) Insert outbound rows from `parseMetaMessage` with `status: "sent"`, `sender_user_id: null`, `payload.echo = { app_id }`; create the customer and conversation from `recipient.id` if needed; `touchConversation` with the preview, no unread, no `inboundWa`; set `first_response_at` if null; publish `message.created` (direction `"out"`) and `conversation.updated`.
- **R7.** Delivery. For each `mid` in `mids`: `sent → delivered`, `delivered_at = at`. Then, with `watermark`: every outbound Messenger message of that customer on that line with `status = 'sent'` and `created_at <= watermark` becomes `delivered`. Never moves a status backwards, never touches `failed`.
- **R8.** Read. Messenger: outbound messages of that customer on that line with status `sent` or `delivered` and `created_at <= watermark` become `read` (`read_at = at`, `delivered_at` filled if null). Instagram: the row with `read.mid` and every earlier outbound row in its conversation with status `sent` become `read`.
- **R9.** Unsend (`is_deleted`). Row not found → nothing. Found → `body = null`, `media_url = null`, `deleted_at = at`; if `media_key` is set, move it to `payload.purge_key` and null it; replace `payload` by `{ purge_key? }` so the text is gone from the raw copy too; publish `message.status`. The conversation's unread count and preview: set `last_preview = "Message deleted"` only if this was the newest message.
- **R10.** A message with several attachments becomes several rows; replaying it creates no duplicates.
- **R11.** A story mention's media is never downloaded or stored; only the link is kept, and it is offered for 24 hours.
- **R12.** A reply to our story is an ordinary inbound message with the line "Replied to your story".
- **R13.** Postbacks, reactions (`react`) and referrals move `last_inbound_wa_at`; deliveries, reads, echoes, edits, unsends and `unreact` do not.
- **R14.** A referral never increases the unread count and never triggers a notification.
- **R15.** `sendFromConversation` is the only way a message leaves; it always sends on the conversation's own channel and from the conversation's own line.
- **R16.** On Messenger and Instagram a template, or a file with a caption, is refused before anything is written.
- **R17.** The 24-hour rule is enforced on the server. With `META_HUMAN_AGENT_ENABLED=true`, a signed-in staff member may send up to 7 days; an automatic send (`userId: null`) never uses the tag.
- **R18.** A sender without a readable profile shows as "Facebook user" or "Instagram user" (or "@username"). A failed look-up never clears a name already known, and is not retried for 3 days.
- **R19.** Temporary errors: when the error is `not_sent` and retryable, wait 1 second and try again, then 3 seconds and try once more, inside the same request. Still failing → `failed`, `payload.retryable = true`, sentence from 3.5. An "unknown" outcome is never retried.
- **R20.** A config-class error marks the line (`problem_*`), raises one owner alert per account per 24 hours, and shows the banner in every open chat on that line. The next successful send or check clears it.
- **R21.** Standby events are ingested exactly like normal ones, so the chat is complete even when another app (or Meta Business Suite's inbox) holds the conversation. If a send is then refused, staff see the "Another app is handling this chat" sentence.
- **R22.** If Instagram delivers only `messages` (M4), everything still works: no read ticks, reactions and postbacks simply never arrive.
- **R23.** No token appears in any log line, stored row, response or test fixture. The Page token is requested through `pageAccessToken` only.
- **R24.** Typing and seen signals to Meta are best effort and can never fail a staff action.
- **R25.** A person who can see a conversation but has no access to its line can read it and cannot reply (existing rule, now for every channel).
- **R26.** `media_url` is null on every row once the file is stored or the link has expired.

## 9. Tests

`packages/domain/src/meta/messaging.test.ts` (new):
- `buildMetaSendPayload builds a RESPONSE text`
- `buildMetaSendPayload maps document to a file attachment with is_reusable false`
- `buildMetaSendPayload adds MESSAGE_TAG and HUMAN_AGENT when humanAgent is true`
- `buildMetaSendPayload includes metadata only when given`
- `classifyMessagingError` — one case per row of table 3.5 (table-driven; name each `classifies <code>/<subcode> as <class>`)
- `sendMetaMessage retries once with a fresh page token after code 190`
- `fetchSenderProfile returns nulls for an empty object, for 2018218 and for a consent error, and throws on a rate limit`
- `isPageSubscribed is false when a field is missing`

`packages/domain/src/inbox/messenger-ingest.test.ts` (new, pure functions):
- `metaEventKind` — one case per kind in 5.3
- `parseMetaMessage` — one case per row of its table, plus `text with two images gives two image rows and the text once`
- `event time accepts milliseconds and seconds (R3)`

`packages/shared/src/inbox.test.ts`: `uploadProblem` per channel and limit; `messagePreview` new types.

`apps/api/test/integration/inbox-meta.test.ts` (new; set-up as `inbox-whatsapp.test.ts`, with a messenger line and an instagram line inserted directly, and a Graph stub that answers `…?fields=access_token`, `…/messages`, `…/subscribed_apps`, and profile look-ups):
- `answers the handshake only with the right token`
- `rejects a bad signature and stores nothing`
- `ignores objects other than page and instagram`
- `stores one event per entry with kind page.messages / instagram.messages`
- `a Messenger text creates identity, phone-less customer, conversation (channel messenger) and message; a replay creates nothing`
- `an Instagram text does the same on the instagram line`
- `the live signal for a customer message carries direction in`
- `an image attachment is saved with media_url and reported as media_pending`
- `a story mention is saved without media_url`
- `a story reply is flagged story_reply in the timeline`
- `a postback and a reaction open the reply window; a referral opens it without unread or alert`
- `an edit replaces the body and keeps the old text; an unsend blanks the message and queues the file for removal`
- `an echo with our metadata fills the mid on the queued row and inserts nothing`
- `a fresh unknown echo is left unprocessed (EchoBeforeSendError); an old one becomes an outbound message marked external_sender`
- `an echo from another app id is inserted at once`
- `delivery and read watermarks move statuses forward only`
- `Instagram seen marks the message and earlier sent ones read`
- `an event for an unknown account is parked, raises one alert, and is replayed after connect`
- `an event for a switched-off account creates nothing`
- `standby events are ingested and flagged`
- `reply inside 24 hours goes to POST {page}/messages with the page token and RESPONSE` (assert the stub saw the Page token header and not the system token)
- `reply after 24 hours is refused with window_closed; with human agent on it is sent with the tag; an automatic send never uses the tag`
- `a template or a captioned file is refused on Messenger`
- `Instagram text over 1000 bytes is refused with too_long`
- `Meta 551 stores the plain sentence and code on the failed message`
- `Meta 613 is retried twice and then marked retryable`
- `Meta 200/2534041 marks the line with a problem and raises one alert; a later success clears it`
- `uploads use the channel's rules when conversation_id is given`
- `an agent without access to the line can read but not reply`
- `POST /channels/connect subscribes the page; a refusal is shown as a problem and the rows are kept`
- `no response body or stored row contains the stubbed page token`

`apps/worker/src/jobs/inbox-meta.test.ts` (new): `refreshIdentityProfiles fills name and picture and never clears a known name`; `ensureMetaSubscriptions re-subscribes when the app is missing`; `downloadPendingMedia stores a media_url file and clears the link`; `a 404 link is given up as expired`; `an oversized file is refused`; `purge deletes the stored file`.

`apps/worker/src/jobs/inbox-push.test.ts`: `push body names the channel`; `referral rows are not pushed`.

`apps/admin/src/lib/inbox-logic.test.ts`: `replyState` — one test per row of table 7.3; `Instagram ticks have no delivered state`.

## 10. Manual check

With P1 to P8 done, and two tester accounts (one Facebook, one Instagram) on a phone.

1. Channels: both rows say "On · receiving messages".
2. From the Facebook tester, send "Hello" to the Page. It appears in the Inbox within 5 seconds with the Facebook mark; a sound and a pop-up fire; the phone push reads "Messenger: Hello".
3. Reply "Hi". It arrives in Messenger. The tick goes to delivered, then read when the tester opens it.
4. Send a photo from the tester: it shows after a few seconds. Send a photo and a PDF back.
5. Answer once from Meta Business Suite's inbox: within about a minute it shows as "Sent from the Facebook or Instagram app".
6. From the Instagram tester: send a direct message; reply; send a photo; reply to one of our stories; mention us in a story; react to a message; unsend a message; edit a message. Check each row of table 7.4. (If the first Instagram message does not arrive, read section 14, Q3 and Q4.)
7. Filter the list by Messenger, then Instagram, then All.
8. In a test database set a conversation's `last_inbound_wa_at` to 25 hours ago: the closed notice shows; the API refuses a send.
9. Try a 9 MB JPEG on Instagram: refused before upload with the Instagram sentence.
10. Type 1100 characters on Instagram: Send is disabled.
11. Switch Instagram off under Channels; send a message from the tester: nothing arrives. Switch it on: new messages arrive.
12. Merge the Instagram tester's contact into a WhatsApp contact (spec 01): the contact panel lists both; a new Instagram message lands on the kept contact.
13. Everything above at 390 px.
14. Record what `entry.id` was on the first Instagram event and whether Requests-folder messages arrived, in the pull request.

## 11. Done when

- [ ] Migration 0072 applies and re-applies cleanly.
- [ ] Lint, type-check, all unit tests, `inbox-meta.test.ts`, and the unchanged WhatsApp and voice integration tests pass.
- [ ] The manual check passes for Messenger and Instagram with tester accounts.
- [ ] A message never appears twice, whatever order echo, send result and delivery arrive in.
- [ ] No story-mention media is in storage.
- [ ] Every sentence staff can see for a failed send comes from table 3.5.
- [ ] The pull request lists each **[unverified]** fact with what was observed, and the answers to Q1, Q3 and Q4.

## 12. Out of scope

- Comments and private replies (spec 03); welcome text, ice breakers, persistent menu (spec 04); lead forms (spec 13); ad reporting (spec 12).
- Sending buttons, quick replies, templates, product cards, reactions or stickers from the suite.
- Quoting the message being replied to; showing which message a reaction belongs to.
- Taking or passing control between apps (conversation routing APIs).
- Loading older history from Meta's Conversations API (only messages received after connection appear).
- Marketing or one-time-notification messages; any automatic reply.
- Voice or video calls on Messenger.
- Storing profile pictures (only Meta's short-lived link is kept).
- Unsubscribing the app from a Page.

## 13. Work order

1. Migration 0072, journal, Drizzle.
2. `meta.ts`: `subcode`, `appId`, `humanAgent`, wording; env names.
3. `meta/messaging.ts` with unit tests (payload builder, classifier, profile, subscribe).
4. `messenger-ingest.ts`: `metaEventKind`, `parseMetaMessage` and their tests.
5. `ingestMetaEntry` for inbound messages only, `finishMetaWebhookEvent`, `webhooks-meta.ts`, registration; first integration tests (handshake, signature, text in, replay).
6. Worker: retry branch; media by link; `RecordingStore.delete`; tests.
7. Remaining events in order: echo, delivery, read, postback, referral, reaction, edit, unsend, standby; tests after each.
8. Unknown and switched-off accounts, parking, alerts (`inbox-alerts.ts`, `outbox.ts` texts).
9. `send.ts` Messenger/Instagram branch with window, limits, error handling, retries; send tests.
10. Route changes: uploads rules, read → seen, typing, list/detail/timeline fields.
11. Channels routes: subscribe on connect, check; worker `ensureMetaSubscriptions`; `refreshIdentityProfiles`.
12. Shared front-end rules (`UPLOAD_RULES`, `replyState`, previews) with tests.
13. Screens: `ChannelIcon`, list icon and filter, composer, timeline, header, notifier, push wording, Channels status.
14. Manual check with testers; pull-request notes.
15. (After the owner's business verification) prepare the app-review submission from 3.7. Submitting is the technical lead's step, not part of the pull request.

## 14. Open questions

| # | Question | Recommended default |
|---|---|---|
| Q1 | **Meta's pages disagree** on whether a business messaging only for its own Page needs app review (3.7). The foundation (section 4) says real customers always need advanced access. | Follow the foundation: plan for review. After business verification and with the app Live, send one message from a Facebook account with no role. If it arrives and can be answered, only Human Agent and the profile feature still need review; write that in the hand-off note |
| Q2 | **Foundation D10 is too coarse for these APIs.** It files Meta codes `10` and `200` under "configuration", but Meta uses `10` with subcodes for "outside the window" and "person unavailable", and `200 / 1545041` for "person unavailable". Treating those as configuration would alert the owner for every customer who blocks the Page. | Use table 3.5 (code plus subcode). Other specs should use `classifyMessagingError` or follow the same pattern. `MetaApiError` gains `subcode` for this |
| Q3 | Is `entry.id` on Instagram events the ID spec 01 stored (M5)? | Assume yes. If the first Instagram event is parked as an unknown account, the owner alert shows the ID Meta used. Then add a nullable column `webhook_external_id` to `inbox_phone_number` in **this** migration file before it is merged, match on either ID in `ingestMetaEntry` step 1, and fill it from the Channels "Check connection" route by reading `GET /{that id}?fields=username` and comparing with `external_name` |
| Q4 | Do Instagram messages in the Requests folder reach the webhook (E14)? | Assume yes and treat them like any message. If the manual check shows they do not, add a line to the Channels page: "First messages from new people may wait in the Instagram app's Requests folder until someone accepts them there." |
| Q5 | **Foundation D11 says all incoming media is downloaded to storage; Meta forbids storing story-mention media (E4).** | Keep D11 for everything else; never download `story_mention` (and shared posts, which are other people's content). Show the link for 24 hours |
| Q6 | Human Agent before approval: does the tag work for testers? | Unknown. Leave `META_HUMAN_AGENT_ENABLED` unset until Meta approves the feature; the code path is covered by tests with the stub |
| Q7 | Messenger attachment formats are not listed on the pages read (S7). | Use the cautious list in 5.6. Meta's refusal (100 / 2018047) is shown in plain words if a type is wrong |
| Q8 | Meta's examples use Graph `v27.0`; the code default is `v23.0` (foundation section 4). | Same as spec 01, Q1: the technical lead sets `META_GRAPH_VERSION`. `message_edits` and Instagram typing/seen are the features most likely to need a newer version |
| Q9 | The blueprint places ingest in `packages/domain/src/inbox/messenger-ingest.ts`; foundation D7 says new Meta code goes in `packages/domain/src/meta/`. | Graph calls in `meta/messaging.ts`; timeline ingest in `inbox/messenger-ingest.ts`, beside `whatsapp-ingest.ts` |
| Q10 | The webhook must answer within 5 seconds (M1); the app-review page says 20. | Design for 5: no Meta call on the webhook path |

## Built differently

Departures made while building this spec on `work/olu/suite-02-dms` (stacked on `work/olu/suite-01-identities`, 20 Nov 2026). Each keeps existing WhatsApp behaviour or follows the foundation's section 9.

1. **`meta.ts` wording and `subcode`** were already done by spec 01 (`MetaApiError.subcode`, "Meta" wording by default). WhatsApp calls keep "Could not reach WhatsApp" through `service: "WhatsApp"`, so no WhatsApp text changed. `MetaConfig` gained `appId` and `humanAgent` as written.
2. **Error classes** (`classifyMessagingError`): besides table 3.5, code `283` and `no_page_token` are configuration (foundation C2), codes `80000`–`80009` and `80014` are temporary (C3), and a call that never connected is temporary. A send with no answer at all stays the existing "unconfirmed" failed state with the sentence "No answer from {Channel}. It may have been sent: check before sending again." and is never retried. `fetchSenderProfile` returns nulls for refusals and throws temporary **and configuration** errors, so the worker can stop its batch on a configuration problem (6.3).
3. **`ingestMetaEntry`** keeps one dispatch point (ruling 9.2.3): `entry.changes[]` items go to `META_CHANGE_HANDLERS["<object>.<field>"]` (empty today; specs 03, 12, 13 register there), messaging and standby events go through one dispatch. An entry with only unhandled changes is marked `ignored`, as 5.3 step 2 says. Events with no `mid` that we cannot key are skipped.
4. **Postbacks** follow spec 04 section 5.6: the stored `payload` is the whole messaging event, which contains `postback.payload` and `postback.title` at the paths 5.6 names. The body falls back to `describeChatSetupPayload(payload).fallbackTitle`. `describeChatSetupPayload` (and `CHAT_SETUP_PAYLOAD`) were built in `packages/shared/src/chat-setup.ts` with spec 04's exact signature; spec 04 adds the rest of that file. The timeline row gains `tap_caption` ("Tapped a starter question" …, else "Tapped a button") shown under the bubble; a quick reply (no postback) shows the "Tapped: " prefix instead.
5. **Echoes (R6 b)** also turn a `failed` (unconfirmed) row into `sent`, because the echo proves it went; a later status is never moved back. The send's own success update uses the same rule.
6. **Reactions** use the key `react:<mid>:<timestamp>`; an `unreact` neither opens the window nor alerts. **Edits** of a message the customer already unsent are ignored; a replayed edit with the same text changes nothing. **Unsend** also clears every extra row of a multi-attachment message (`<mid>#2` …).
7. **Alerts**: `alertOnce` lives in `apps/api/src/lib/inbox-alerts.ts` for the three new event types. The WhatsApp "unknown number" alert keeps its own copy unchanged (its payload key differs). The worker's subscription job inserts `inbox.meta_config` itself with the same 24-hour check. The three new `outbox.ts` cases are in place (ruling 9.2.10).
8. **Send branch**: `sendFromConversation` first reads the conversation's channel; WhatsApp threads run the unchanged WhatsApp body. On Messenger/Instagram the recipient must be an identity on the same channel **and** the same account as the line. A line without `page_external_id` is refused as `account_off`. Retries for temporary errors use `META_SEND_RETRY_DELAYS_MS` (1 s, 3 s), exported so tests can shorten them. A configuration-class failure stores `payload.config = true` and `payload.account` (the line's external ID) so the route can raise `alertOnce`.
9. **Messenger text length** counts Unicode code points (1999 max); Instagram counts UTF-8 bytes (1000 max), both through `fitsTextLimit` in `@ms/shared`.
10. **Upload rules**: `UPLOAD_RULES` in `@ms/shared` holds WhatsApp's unchanged list (`INBOX_UPLOAD_TYPES` in `r2.ts` now points at it) plus the Messenger and Instagram lists. Without `conversation_id`, or for a WhatsApp thread, the server's wording is unchanged.
11. **Routes**: the detail's `number` also returns `is_active`; the detail also returns `human_agent_enabled` (the composer needs it to say "7 days" when Human Agent is on but the 7 days have passed). `GET /contacts/:customerId` conversations gain `channel` (the composer's "Open their WhatsApp chat" link). The "seen" and "typing" signals need the conversation's identity; a thread without one sends nothing.
12. **Channels routes**: the Page subscription on connect runs **after** the database transaction (never hold a transaction open across a call to Meta), then parked events for each connected account are re-queued. The response rows are read after that, so they already carry `webhook_subscribed_at` or the problem. "Check connection" also records `webhook_subscribed_at` for rows connected before this spec when Meta says the Page is subscribed, and clears `problem_*` on success. `problem_code` is also set when connect's subscription is refused.
13. **Worker**: `refreshIdentityProfiles` only picks identities whose line is active (so a switched-off line cannot block the batch). `ensureMetaSubscriptions` checks each Page once, even when both its Messenger and Instagram lines are connected. The linked-media pass also skips `story_mention` and `share` rows by type, as a second guard.
14. **Rule R25 test**: foundation rule 6 has one visibility rule, under which a person without `inbox.view_all` sees only the lines granted to them, and `inbox.view_all` can use every line. "Can read but not reply" therefore cannot happen today; the test checks instead that an agent sees and answers on their line and gets `404` for reading and replying on a line they lack.
15. **Screens**: the composer's "Open their WhatsApp chat" button shows only when the contact has a phone and a WhatsApp conversation the viewer can see. The list's channel filter is a row of buttons kept in `useInboxUi`; at 480 px and below they show icons only. On WhatsApp threads the in-app toast now reads "New WhatsApp message from …", the desktop pop-up title gains " · WhatsApp", and the phone push body is "WhatsApp: …" (7.5 and 6.6 ask for the channel name on every channel). The list preview for a WhatsApp interactive message with no text now reads "Tapped a button" instead of "Message" (7.1).
16. **Existing test changed**: `apps/api/test/integration/channels.test.ts` (spec 01) — only its Graph stub, which now answers `{page}/subscribed_apps` (connect and "Check connection" call it under this spec). No expectation changed.
17. **Not built**: the Q3 fallback column `webhook_external_id` (only needed if the manual check shows Instagram uses a different ID), and work-order steps 14 and 15 (manual check with testers, app-review submission).
