# Suite build specs — 12: Ads — results, spend and click-to-chat adverts

Read `00-foundation.md` first. Size L. Suggested model: Opus (money, concurrency, cross-cutting data). Migration `0080_ads.sql`. Permissions `ads.view`, `ads.manage`.

This spec has two phases. **Build, review and merge Phase A before starting Phase B.**

- **Phase A — look, do not touch.** Link the ad account, show spend and results, tie chats and shop orders back to the advert that started them, and (behind an owner switch) tell Meta about purchases so it can measure the adverts. Nothing in Phase A can spend money.
- **Phase B — spends money.** Create a click-to-chat advert, turn adverts on and off, change a budget, and simple "pause if too expensive" rules. Owner only, **off by default** behind an owner switch, with a hard daily cap checked in our code before every call that could raise spending.

---

## 1. Outcome

Phase A. A staff member with "see ad results" can say:

- "I open **Ads** and see what we spent each day, how many people saw and tapped our adverts, and how many chats each advert started."
- "For each advert I see how many of those chats became paid orders in our shop, and how much those orders were worth, with the rule used written beside the number."
- "In the inbox I can tell that a customer came from an advert, and which one."
- "The owner can let the suite report purchases back to Meta so Meta can measure the adverts. It is off until the owner turns it on, and it sends the least information possible."

Phase B. The owner can say:

- "I can create an advert that opens a WhatsApp, Messenger or Instagram chat with us, from the suite."
- "Before anything is created or changed I get a plain-English summary with the most it can spend, and I must type that amount to confirm."
- "Adverts are created switched off. I turn them on myself."
- "The suite will not let total daily budgets go over the cap I set, whatever I click."
- "I can set a rule such as 'pause if a chat costs more than ₦800', and everything the suite does to my adverts, by me or by a rule, is in a log that cannot be edited."

## 2. Depends on

| Needs | Why |
|---|---|
| Spec 01 merged (`0071`) | `inbox_identity`, `listChannelAccounts`, `channelAccountByExternalId`, `pageAccessToken`, exported `graph()` |
| Spec 02 merged (`0072`) | Messenger and Instagram webhooks stored in `inbox_webhook_event` (`source='meta'`, `kind` like `page.messages`, `instagram.messages`, `page.messaging_referrals`), including the `referral` on a first message from an advert. WhatsApp attribution works without spec 02 |
| A person, in Meta Business Settings (Phase A) | 1. Create or pick the ad account under the business "aniukwu". 2. Business Settings → Users → System users → `NEWUSERSYSTEM` → Assign assets → Ad accounts → pick the account → for Phase A tick "View performance"; for Phase B "Manage campaigns". [unverified wording of these screens] 3. Confirm the token has `ads_read` (Phase A) and `ads_management`, `pages_manage_ads` (Phase B). 4. Add a payment method to the ad account (Phase B) |
| A person, in Meta (Phase B, WhatsApp adverts) | The Facebook Page is linked to the WhatsApp business number (Page settings → Linked accounts → WhatsApp) [verified as a prerequisite: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp, 19 Nov 2026] |
| A person, in Meta (purchase reporting) | Permission `whatsapp_business_manage_events` on the token, and Marketing API full access (section 3.6) |
| Owner decisions | The daily cap; whether to turn on purchase reporting; whether to turn on Phase B at all |

## 3. Meta reference

How these were checked: each page was fetched on 19 Nov 2026 through an automated reader that summarises the page. Treat wording as paraphrase and re-read the page before coding. The pages show `v27.0` as latest; this codebase defaults to `v23.0`.

### 3.1 Access, tiers and limits

| # | Fact | Status |
|---|---|---|
| A1 | "Standard access to the `ads_read` and `ads_management` permissions are sufficient" when the app only manages the business's own ad account; advanced access is for other people's accounts | [verified: https://developers.facebook.com/docs/marketing-api/get-started/authorization, 19 Nov 2026] |
| A2 | The tier once called "Ads Management Standard Access" is now the **Marketing API Access Tier**: *Limited access* (default, "heavily rate-limited per ad account. For development only") and *Full access* (after app review). Full access needs at least 500 successful Marketing API calls in the last 15 days with an error rate under 15%, and business verification. (Other pages still say 1,500 calls and 10%.) | [verified, sources disagree on the numbers: https://developers.facebook.com/docs/marketing-api/get-started/authorization and https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging, 19 Nov 2026] |
| A3 | Scoring per ad account: a read is 1 point, a write 3. Limited tier: maximum score 60, decays over 300 s, blocked 300 s at the maximum. Full tier: maximum 9000, blocked 60 s | [verified: https://developers.facebook.com/docs/marketing-api/overview/rate-limiting, 19 Nov 2026] |
| A4 | Business-use-case limits per ad account per hour: ads management `300 + 40 × active ads` (limited) or `100000 + 40 × active ads` (full); ads insights `600 + 400 × active ads` (limited) or `190000 + 400 × active ads` (full) | [verified: same page, 19 Nov 2026] |
| A5 | Usage headers on responses: `X-Ad-Account-Usage` (`acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier`), a business-use-case header (`call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access`), `X-FB-Ads-Insights-Throttle` (`app_id_util_pct`, `acc_id_util_pct`, `ads_api_access_tier`) | [verified: same page, 19 Nov 2026]; that the business-use-case header is spelled `X-Business-Use-Case-Usage` and keyed by ad account ID [unverified] |
| A6 | Throttling errors: code `17` (subcode 2446079), `613` (subcodes 1487742 account call limit, 1487632 ad set budget changes, 1487225 ad creation limit, 4841018 too many concurrent edits), `80000`, `80003`, `80004`, `80014` (business-use-case limits), `4` (insights app limit) | [verified: same page, 19 Nov 2026] |
| A7 | An ad set's `daily_budget` / `lifetime_budget` can change at most 4 times an hour. Account spend-limit fields at most 10 times a day. One edit per object every 30 seconds by default | [verified: same page, 19 Nov 2026] |
| A8 | Limited tier allows 1 system user plus 1 admin system user | [verified: https://developers.facebook.com/docs/marketing-api/get-started/authorization, 19 Nov 2026] |
| A9 | Listing the accounts the token can use: `GET /me/adaccounts?fields=id,account_id,name,currency,timezone_name,timezone_offset_hours_utc,account_status` | [unverified] (the edge's reference page returned "not found"; the system-user variant `GET /{system-user-id}/assigned_ad_accounts` is [verified: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/system-user/assigned_ad_accounts, 19 Nov 2026]) |
| A10 | Assigning by API exists: `POST /act_{id}/assigned_users` with `user` and `tasks` from `MANAGE`, `ADVERTISE`, `ANALYZE`, `DRAFT`, `AA_ANALYZE`. We do **not** call it; a person assigns in Business Settings | [verified: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/assigned_users, 19 Nov 2026] |
| A11 | Ad account fields: `id` (`act_<n>`), `account_id`, `name`, `currency`, `timezone_name`, `timezone_offset_hours_utc`, `account_status` (1 active, 2 disabled, 3 unsettled, 7 pending risk review, 8 pending settlement, 9 in grace period, 100 pending closure, 101 closed), `min_daily_budget`, `spend_cap`, `amount_spent`, `funding_source` ("without one, ads can be created but won't deliver") | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-account, 19 Nov 2026] |

### 3.2 Reading results

| # | Fact | Status |
|---|---|---|
| R1 | `GET /act_{id}/insights` (also on a campaign, ad set or ad). Needs `ads_read`. Parameters: `level` (`account`, `campaign`, `adset`, `ad`), `fields`, `time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}` (both inclusive; Unix times not accepted), `time_increment` (`1` to `90` days, `monthly`, `all_days`), `date_preset` (including `today`, `yesterday`, `last_7d`), `action_attribution_windows`, `action_breakdowns`, `action_report_time`, `use_unified_attribution_setting`, `limit` | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights, 19 Nov 2026] |
| R2 | Fields: `spend`, `impressions`, `reach`, `clicks`, `inline_link_clicks`, `actions`, `action_values`, `cost_per_action_type`, `account_currency`, `campaign_id`, `campaign_name`, `adset_id`, `adset_name`, `ad_id`, `ad_name`, `date_start`, `date_stop` | [verified: same page, 19 Nov 2026] |
| R3 | At most 37 months of history (error `3018` beyond). "Set `use_unified_attribution_setting=true` to match Ads Manager." | [verified: same page, 19 Nov 2026] |
| R4 | The time zone of `date_start` is the ad account's own (`timezone_name`) | [unverified] (the page only says `today_spend` uses the account's zone) |
| R5 | Action types (`actions[].action_type`): `onsite_conversion.messaging_conversation_started_7d` "Messaging Conversations Started"; `onsite_conversion.messaging_first_reply` "New Messaging Conversations"; `onsite_conversion.messaging_block`; `onsite_conversion.purchase` "On-Facebook Purchases"; `offsite_conversion.fb_pixel_purchase` "Purchases"; `omni_purchase` "Purchases"; `link_click`; `post_engagement` | [verified: https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/, 19 Nov 2026] |
| R6 | The same `onsite_conversion.messaging_conversation_started_7d` action is used for WhatsApp, Messenger and Instagram chats alike (there is no per-app action type); and which action type carries a purchase reported through section 3.6 | [unverified]. We tell the three apart from the ad set's `destination_type`, and we keep the whole `actions` list |
| R7 | Listing objects: `GET /act_{id}/campaigns`, `/adsets`, `/ads` with `fields` and `limit`; campaign fields `id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time`; ad set fields `id,name,campaign_id,status,effective_status,destination_type,daily_budget,lifetime_budget,start_time,end_time,optimization_goal`; ad fields `id,name,adset_id,campaign_id,status,effective_status,creative{id,name,body,title,object_story_spec}` | [unverified] as list edges and exact field names (the create references confirm the names `status`, `effective_status`, `objective`, `destination_type`, `daily_budget`, `lifetime_budget`, `start_time`, `end_time`) |
| R8 | `effective_status` values: campaign `ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`, `IN_PROCESS`, `WITH_ISSUES`; ad set adds `CAMPAIGN_PAUSED`; a new ad shows `PENDING_REVIEW` until approved | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group, https://developers.facebook.com/docs/marketing-api/reference/ad-campaign and https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp, 19 Nov 2026] |

### 3.3 Where a chat came from (the `referral`)

| # | Fact | Status |
|---|---|---|
| T1 | WhatsApp: an incoming message sent through a click-to-WhatsApp advert has a `referral` object on the message: `source_url`, `source_id` (the ad's ID), `source_type` (`"ad"` in the examples), `headline`, `body`, `media_type` (`image` or `video`), `image_url` / `video_url` / `thumbnail_url`, `ctwa_clid`, `welcome_message.text` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text, 19 Nov 2026] |
| T2 | "The `ctwa_clid` property is omitted entirely for messages originating from an ad in WhatsApp Status." | [verified: same page, 19 Nov 2026] |
| T3 | `source_type` may also be `"post"`; the `referral` appears on the first message only | [unverified] (reported by third parties, not on the page read) |
| T4 | Instagram: the `messages` webhook's `message` object carries `referral` with `ref`, `ad_id`, `source: "ADS"`, `type: "OPEN_THREAD"`, `ads_context_data: { ad_title, photo_url, video_url }` "when a customer clicks a click-to-Direct ad" | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook, 19 Nov 2026] |
| T5 | Messenger: the `messaging_referrals` webhook carries `referral` with `source: "ADS"`, `type: "OPEN_THREAD"`, `ad_id`, `ref`, `ads_context_data: { ad_title, photo_url, video_url, post_id, product_id }` when the person **already has a thread**; for a new thread the page says to use the postback event | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_referrals, 19 Nov 2026]; where the referral sits on a brand-new Messenger thread (on the first `message`, or on a `postback`) [unverified] |

### 3.4 Creating a click-to-chat advert (Phase B)

| # | Fact | Status |
|---|---|---|
| C1 | Four calls: `POST /act_{id}/campaigns`, `/adsets`, `/adcreatives`, `/ads`; each returns `{"id": "…"}`. Permissions `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`; the token's user needs the ADVERTISE task on the Page | [verified: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp, 19 Nov 2026] |
| C2 | Campaign: `name`, `objective` (current names `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_TRAFFIC`, `OUTCOME_AWARENESS`, `OUTCOME_APP_PROMOTION`; the old names are retired), `special_ad_categories` (**required**; `[]` when none applies), `status` (`ACTIVE` or `PAUSED` at creation), `buying_type` default `AUCTION` | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group, 19 Nov 2026] |
| C3 | `special_ad_categories` values: `NONE`, `EMPLOYMENT`, `HOUSING`, `CREDIT`, `ISSUES_ELECTIONS_POLITICS`, `ONLINE_GAMBLING_AND_GAMING`, `FINANCIAL_PRODUCTS_SERVICES` | [verified: same page, 19 Nov 2026] |
| C4 | Ad set for WhatsApp: `campaign_id`, `name`, `destination_type: "WHATSAPP"`, `billing_event: "IMPRESSIONS"`, `optimization_goal` (`CONVERSATIONS` or `LINK_CLICKS` under `OUTCOME_ENGAGEMENT`), `bid_strategy` (`LOWEST_COST_WITHOUT_CAP` needs no bid amount), `daily_budget` or `lifetime_budget` (daily only for runs over 24 hours), `start_time`, `end_time`, `promoted_object: { page_id, whatsapp_phone_number? }`, `targeting` (required; example `{"geo_locations":{"countries":["US"]},"device_platforms":["mobile","desktop"]}`), `status` | [verified: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp, 19 Nov 2026] |
| C5 | `destination_type` values include `WHATSAPP`, `MESSENGER`, `INSTAGRAM_DIRECT` and the multi-app ones `MESSAGING_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP` | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign, 19 Nov 2026] |
| C6 | Budget numbers are "in the account currency". The page states smallest-unit amounts (cents) only for `bid_amount` and for campaign `spend_cap`, not for `daily_budget` | [verified that it is not stated: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign, 19 Nov 2026]; that `daily_budget` is in the smallest unit (kobo, cents) [unverified] — handled by the calibration step in section 5.9, never assumed |
| C7 | Minimum daily budget (USD, lowest-cost bidding): $0.50 for impressions, $2.50 for clicks, higher for rare actions; other currencies are converted. The account's own figure is `min_daily_budget` | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign and https://developers.facebook.com/docs/marketing-api/reference/ad-account, 19 Nov 2026] |
| C8 | WhatsApp creative: `object_story_spec: { page_id, link_data: { link: "https://api.whatsapp.com/send", name (headline), message (primary text), description, image_hash, call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } }, page_welcome_message } }` | [verified: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp, 19 Nov 2026] |
| C9 | Pre-filled message: `page_welcome_message` is a JSON string `{"type":"VISUAL_EDITOR","version":2,"landing_screen_type":"welcome_message","media_type":"text","text_format":{"customer_action_type":"autofill_message","message":{"autofill_message":{"content":"<text the customer sends>"},"text":"<greeting>"}}}` | [verified: same page, 19 Nov 2026] |
| C10 | Creatives may fail with "Creative must provide enroll_status for Standard Enhancements"; send `degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status } } }`. The docs show `OPT_IN` | [verified: same page, 19 Nov 2026]; that `OPT_OUT` is accepted [unverified] |
| C11 | Messenger: ad set `destination_type: "MESSENGER"`, `optimization_goal: "CONVERSATIONS"`, `promoted_object: { page_id }`; creative `call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }` (some examples use `LEARN_MORE`); `page_welcome_message` may be a plain string; message text at most 300 characters | [verified, examples disagree on the type: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-messenger, 19 Nov 2026]; the `link_data.link` value to use for Messenger [unverified] |
| C12 | Instagram: ad set `destination_type: "INSTAGRAM_DIRECT"`, `optimization_goal: "CONVERSATIONS"`, `promoted_object: { page_id }`; creative `object_story_spec` needs `page_id` and `instagram_actor_id`; `call_to_action: { type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } }`. Objectives `OUTCOME_ENGAGEMENT`, `OUTCOME_SALES`, `OUTCOME_TRAFFIC` | [verified: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-instagram, 19 Nov 2026]; whether current versions want `instagram_user_id` instead of `instagram_actor_id` [unverified] (the page uses both) |
| C13 | Ad: `name`, `adset_id`, `creative: { creative_id }`, `status`. Turning on: `POST /{id}` with `status=ACTIVE`, answer `{"success":true}`; Meta then reviews it (`PENDING_REVIEW`) | [verified: https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp and …/click-to-instagram, 19 Nov 2026] |
| C14 | Updating a campaign or ad set: `POST /{id}` with the fields to change (`status`, `daily_budget`, `name`); answer `{"success":true}` | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group, 19 Nov 2026] |
| C15 | Uploading the picture: `POST /act_{id}/adimages` with `bytes` (base64) returns `images.<name>.hash` | [unverified] |
| C16 | Targeting a radius: `geo_locations.custom_locations: [{ latitude, longitude, radius, distance_unit: "kilometer" }]`; and whether `targeting_automation.advantage_audience` must be sent | [unverified] |
| C17 | Meta may spend more than the daily budget on one day and less on another | [unverified] |
| C18 | Creation errors: `100` invalid parameter, `190` token, `200` permission, `300` edit failure, `613` rate, `80004` too many calls, `2635` old API version; ad sets also `1870xxx` goal validation and `3858xxx` (EU payer rules, not relevant to Nigeria) | [verified: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group and …/ad-campaign, 19 Nov 2026] |

### 3.5 Nigeria — nothing below is confirmed

| # | Statement | Status |
|---|---|---|
| N1 | Click-to-WhatsApp, click-to-Messenger and click-to-Instagram adverts can be delivered to people in Nigeria from an ad account owned by a Nigerian business | [unverified] |
| N2 | A Nigerian business can hold an ad account in naira (NGN) and pay for it with a Nigerian card; Meta has changed naira billing rules before | [unverified] |
| N3 | Optimising for purchases in chat, and the purchase reporting in section 3.6, are available for Nigerian accounts | [unverified] |
| N4 | The WhatsApp Status placement is offered in Nigeria | [unverified] |
| N5 | The minimum daily budget in naira | [unverified] — read `min_daily_budget` from the account at run time |
| N6 | Matching by hashed phone number or email "is available only in a subset of countries" (Meta's words); whether Nigeria is one is unknown | [unverified] — we do not use that path at all |

The suite never promises delivery. If Meta refuses a create call, the refusal is shown and logged (rule 8.22).

### 3.6 Reporting purchases to Meta (Conversions API for business messaging)

| # | Fact | Status |
|---|---|---|
| E1 | Purpose: send conversion events that happen inside a chat so Meta can measure and improve adverts that click to WhatsApp, Messenger or Instagram | [verified: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging, 19 Nov 2026] |
| E2 | A **dataset** is the container events are sent to. For WhatsApp: `POST /{waba-id}/dataset` creates one and returns its ID, or returns the existing one; `GET /{waba-id}/dataset` reads it. Messenger: `POST /{page-id}/dataset`. Instagram: `POST /{ig-user-id}/dataset`. One dataset per Page. The business owns it | [verified: same page, 19 Nov 2026] |
| E3 | Send: `POST /{dataset-id}/events` with `{ "data": [ { "event_name", "event_time" (Unix seconds), "action_source": "business_messaging", "messaging_channel": "whatsapp" \| "messenger" \| "instagram", "user_data": {…}, "custom_data": { "currency", "value" } } ], "partner_agent" }` | [verified: same page, 19 Nov 2026] |
| E4 | `user_data` — WhatsApp: `whatsapp_business_account_id` and `ctwa_clid`. Messenger: `page_id` and `page_scoped_user_id`. Instagram: `instagram_business_account_id` and `ig_sid` | [verified: same page, 19 Nov 2026] |
| E5 | Event names include `Purchase`, `LeadSubmitted`, `InitiateCheckout`, `AddToCart`, `ViewContent`, `OrderCreated`, `OrderShipped`, `OrderDelivered`, `OrderCanceled`, `OrderReturned`, `CartAbandoned`, `QualifiedLead`, `RatingProvided`, `ReviewProvided` | [verified: same page, 19 Nov 2026] |
| E6 | "`ctwa_clid` comes from the `referral` object in the Messages webhook of a click-to-WhatsApp ad. Store it with the conversation and send it with conversion events." | [verified: same page, 19 Nov 2026] |
| E7 | **Meta does not remove duplicates.** "Partners should deduplicate before sending." No `event_id` is described | [verified: same page, 19 Nov 2026] |
| E8 | Permissions: WhatsApp `whatsapp_business_management` and `whatsapp_business_manage_events`; Messenger `page_events`; Instagram `instagram_manage_events`; each at advanced access, plus Marketing API full access | [verified: same page, 19 Nov 2026] |
| E9 | The page is written for "Business Messaging Partners" acting for clients. Whether a business may use it directly for its own WhatsApp account with a system-user token, and whether `partner_agent` may be left out | [unverified] — the biggest risk in this spec; see section 14, Q2 |
| E10 | Purchase optimisation is available for Messenger and WhatsApp, not Instagram | [verified: same page, 19 Nov 2026] |
| E11 | An alternative WhatsApp path without a click ID sends hashed phone, email or name. **We do not use it** | [verified that it exists: same page, 19 Nov 2026] |
| E12 | How old an event may be | [unverified] (the page gives no limit; we refuse to send events older than 7 days) |

### 3.7 App review

| Permission | Phase | Notes | Status |
|---|---|---|---|
| `ads_read` | A | Standard access is enough for our own account (A1) | [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026] |
| `ads_management`, `pages_manage_ads` | B | Standard access is enough for our own account; Marketing API full access removes the tight limits (A2, A3) | [verified: same page, 19 Nov 2026] |
| `whatsapp_business_manage_events` (also `page_events`, `instagram_manage_events` if Messenger and Instagram purchases are reported) | A, purchase reporting only | Advanced access (E8) | [verified: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging, 19 Nov 2026]; not found on the permissions reference page [unverified there] |

**Screencast must show** — for `ads_read`: sign in; Ads → Settings showing the linked ad account by name; the Overview with spend and chats; one advert's page. For `ads_management` and `pages_manage_ads`: Ads → New advert; filling the form; the summary with the total and the typed confirmation; the advert appearing switched off; opening Meta Ads Manager to show the same advert there; turning it on and pausing it from the suite; the activity log. For `whatsapp_business_manage_events`: a test chat started from an advert; the "Came from an advert" label in the inbox; a paid test order; Ads → the order shown against the advert with "Reported to Meta"; Meta Events Manager showing the Purchase event in the dataset.

## 4. Data

### 4.1 Migration `packages/db/migrations/0080_ads.sql`

```sql
-- Ads (spec 12). Additive only: eight new ad_* tables and one trigger on ad_action_log.
-- No existing table is altered.
-- Undo: DROP TABLE "ad_rule","ad_draft","ad_order_attribution","ad_touch","ad_action_log","ad_insight_daily","ad_campaign_cache","ad_account_link";
--       DROP FUNCTION "ad_action_log_immutable"();

CREATE TABLE IF NOT EXISTS "ad_account_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ad_account_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "currency" text NOT NULL,
  "timezone_name" text NOT NULL,
  "timezone_offset_hours_utc" numeric(5,2),
  "account_status" integer,
  "min_daily_budget_units" bigint,
  "budget_factor" integer,
  "budget_factor_confirmed_by" uuid REFERENCES "admin_user"("id"),
  "budget_factor_confirmed_at" timestamptz,
  "is_active" boolean DEFAULT true NOT NULL,
  "linked_by" uuid REFERENCES "admin_user"("id"),
  "linked_at" timestamptz DEFAULT now() NOT NULL,
  "backfilled_at" timestamptz,
  "last_synced_at" timestamptz,
  "last_error_code" text,
  "last_error_message" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_account_link_one_active" ON "ad_account_link" ("is_active") WHERE "is_active";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_campaign_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ad_account_id" text NOT NULL,
  "level" text NOT NULL CHECK ("level" IN ('campaign','adset','ad')),
  "external_id" text NOT NULL,
  "parent_external_id" text,
  "campaign_external_id" text,
  "name" text,
  "status" text,
  "effective_status" text,
  "objective" text,
  "destination_type" text,
  "daily_budget_units" bigint,
  "lifetime_budget_units" bigint,
  "start_time" timestamptz,
  "end_time" timestamptz,
  "creative" jsonb,
  "created_by_suite" boolean DEFAULT false NOT NULL,
  "gone_at" timestamptz,
  "synced_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_campaign_cache" ON "ad_campaign_cache" ("level","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_campaign_cache_account" ON "ad_campaign_cache" ("ad_account_id","level");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_insight_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ad_account_id" text NOT NULL,
  "level" text NOT NULL CHECK ("level" IN ('account','ad')),
  "external_id" text NOT NULL,
  "day" date NOT NULL,
  "day_zone" text NOT NULL,
  "currency" text NOT NULL,
  "spend" numeric(14,2) DEFAULT 0 NOT NULL,
  "impressions" bigint DEFAULT 0 NOT NULL,
  "reach" bigint,
  "clicks" bigint DEFAULT 0 NOT NULL,
  "link_clicks" bigint,
  "conversations_started" integer DEFAULT 0 NOT NULL,
  "first_replies" integer DEFAULT 0 NOT NULL,
  "meta_purchases" numeric(14,2) DEFAULT 0 NOT NULL,
  "meta_purchase_value" numeric(14,2) DEFAULT 0 NOT NULL,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "fetched_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_insight_daily" ON "ad_insight_daily" ("level","external_id","day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_insight_daily_account_day" ON "ad_insight_daily" ("ad_account_id","day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_action_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "phase" text NOT NULL CHECK ("phase" IN ('requested','result')),
  "at" timestamptz DEFAULT now() NOT NULL,
  "actor_kind" text NOT NULL CHECK ("actor_kind" IN ('person','rule','safety','system')),
  "actor_user_id" uuid,
  "actor_name" text,
  "action" text NOT NULL,
  "ad_account_id" text,
  "object_level" text,
  "object_external_id" text,
  "summary" text NOT NULL,
  "max_spend_units" bigint,
  "currency" text,
  "confirm_text" text,
  "request" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "outcome" text CHECK ("outcome" IN ('ok','refused','unknown','blocked')),
  "meta_code" text,
  "meta_message" text,
  "response" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_action_log_request_phase" ON "ad_action_log" ("request_id","phase");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_action_log_at" ON "ad_action_log" ("at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ad_action_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ad_action_log is append-only: rows cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TRIGGER "trg_ad_action_log_immutable" BEFORE UPDATE OR DELETE ON "ad_action_log"
  FOR EACH ROW EXECUTE FUNCTION "ad_action_log_immutable"();
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_touch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_key" text NOT NULL UNIQUE,
  "channel" text NOT NULL CHECK ("channel" IN ('whatsapp','messenger','instagram')),
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "source_type" text NOT NULL,
  "ad_external_id" text,
  "post_external_id" text,
  "headline" text,
  "body" text,
  "source_url" text,
  "media_type" text,
  "ctwa_clid" text,
  "account_external_id" text,
  "sender_external_id" text,
  "touched_at" timestamptz NOT NULL,
  "reporting_blocked_at" timestamptz,
  "reporting_blocked_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_touch_customer" ON "ad_touch" ("customer_id","touched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_touch_ad" ON "ad_touch" ("ad_external_id","touched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_touch_conversation" ON "ad_touch" ("conversation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_order_attribution" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sale_order_id" uuid NOT NULL UNIQUE REFERENCES "sale_order"("id") ON DELETE CASCADE,
  "touch_id" uuid NOT NULL REFERENCES "ad_touch"("id") ON DELETE CASCADE,
  "rule" text NOT NULL,
  "order_at" timestamptz NOT NULL,
  "value_ngn" integer NOT NULL,
  "capi_status" text DEFAULT 'none' NOT NULL CHECK ("capi_status" IN ('none','queued','sending','sent','failed','unknown','skipped')),
  "capi_note" text,
  "capi_attempts" integer DEFAULT 0 NOT NULL,
  "capi_locked_at" timestamptz,
  "capi_sent_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_order_attribution_touch" ON "ad_order_attribution" ("touch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_order_attribution_capi" ON "ad_order_attribution" ("capi_status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_draft" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft','creating','created','failed','needs_check')),
  "spec" jsonb NOT NULL,
  "step" text DEFAULT 'start' NOT NULL CHECK ("step" IN ('start','image','campaign','adset','creative','ad','verify','done')),
  "image_hash" text,
  "campaign_external_id" text,
  "adset_external_id" text,
  "creative_external_id" text,
  "ad_external_id" text,
  "confirmed_by" uuid REFERENCES "admin_user"("id"),
  "confirmed_at" timestamptz,
  "confirmed_hash" text,
  "locked_at" timestamptz,
  "error_code" text,
  "error_message" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "metric" text NOT NULL CHECK ("metric" IN ('cost_per_conversation')),
  "threshold" numeric(14,2) NOT NULL CHECK ("threshold" > 0),
  "currency" text NOT NULL,
  "lookback_days" integer NOT NULL CHECK ("lookback_days" IN (1,3,7)),
  "min_spend" numeric(14,2) DEFAULT 0 NOT NULL,
  "scope_campaign_external_id" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "last_evaluated_at" timestamptz,
  "last_fired_at" timestamptz
);
```

Journal entry: `{ "idx": <next>, "version": "7", "when": <previous when + 100000000>, "tag": "0080_ads", "breakpoints": true }`.

Notes:

- **Units.** Every `*_units` column holds the integer exactly as Meta's API gives or takes it for a budget. `budget_factor` is how many units make one whole unit of the account's currency (100 if Meta works in kobo or cents, 1 if in whole naira). It is null until calibrated (section 5.9); money-moving actions are refused while it is null.
- `ad_insight_daily.day` is the day as the ad account counts it; `day_zone` is the account's `timezone_name`. `spend` is in whole currency units with decimals, as Meta returns it.
- `ad_action_log` is append-only. Every action writes a `requested` row **before** the Graph call and a `result` row after it, sharing `request_id`. A `requested` row with no `result` row means "unknown". `actor_user_id` has no foreign key on purpose (a deleted staff account must not block or alter the log); `actor_name` is copied in at write time. `request` never contains a token.
- `ad_touch` is one row per time a customer arrived from an advert. `source_key` makes it idempotent: `msg:<inbox_message.id>` for WhatsApp, `evt:<inbox_webhook_event.id>:<n>` for Messenger and Instagram. This is how the attribution is "stored on the conversation and the customer" without changing `inbox_conversation` or `customer` (existing customer rows are never modified, D2). Erasing a customer's inbox history deletes their conversations, which removes their touches (and click IDs) by cascade.
- `ad_order_attribution`: at most one row per shop order.
- Tables beyond the four the foundation lists (`ad_touch`, `ad_order_attribution`, `ad_draft`, `ad_rule`) are flagged in section 14, Q9.

### 4.2 Drizzle: new file `packages/db/src/schema/ads.ts`

One `pgTable` per table above, column for column, in the style of `inbox.ts` (camelCase property, snake_case column, `timestamp(..., { withTimezone: true })`, `numeric(..., { precision, scale })`, `bigint(..., { mode: "number" })`, `jsonb(...).$type<…>()`), with the same unique and plain indexes. Names: `adAccountLink`, `adCampaignCache`, `adInsightDaily`, `adActionLog`, `adTouch`, `adOrderAttribution`, `adDraft`, `adRule`. Export from `packages/db/src/schema/index.ts`. The trigger exists in SQL only.

### 4.3 Owner settings (`app_settings`, key `ads_settings`)

Add to `packages/db/src/schema/app-setting.ts`:

```ts
export interface AdsSettingsValue {
  manage_enabled: boolean;              // Phase B master switch. Default false
  daily_cap: number;                    // whole currency units of the ad account, e.g. 10000 = ₦10,000. Default 0 = nothing may be turned on
  rules_enabled: boolean;               // let rules pause adverts unattended. Default false
  capi_enabled: boolean;                // report purchases to Meta. Default false
  capi_privacy_confirmed_by: string | null;
  capi_privacy_confirmed_at: string | null;
  datasets: Record<string, string>;     // WABA id -> dataset id
  attribution_window_days: number;      // 1..28, default 7
  refresh_requested_at: string | null;
  last_sync_day: string | null;         // Lagos day of the last full sync
}
export const ADS_SETTINGS_KEY = "ads_settings";
export const ADS_SETTINGS_DEFAULT: AdsSettingsValue = { manage_enabled: false, daily_cap: 0, rules_enabled: false, capi_enabled: false,
  capi_privacy_confirmed_by: null, capi_privacy_confirmed_at: null, datasets: {}, attribution_window_days: 7, refresh_requested_at: null, last_sync_day: null };
```

### 4.4 Permissions

Add to `CAPABILITIES` in `packages/shared/src/permissions.ts`:

```ts
// See ad spend and results (suite spec 12).
"ads.view",
// Owner-only by default: create, switch on, pause and change adverts — this spends money.
// Deliberately NOT in ADMIN_CAPS/MANAGER_CAPS. Grantable per-user via overrides.
"ads.manage",
```

`ads.view` goes in `ADMIN_CAPS`. `ads.manage` goes in no role list (the owner has it through `[...CAPABILITIES]`). Three things need the **owner role itself**, whatever is granted: changing `ads_settings`, linking or unlinking the ad account, and calibrating the budget unit.

## 5. Server

### 5.1 Files

| File | Phase | Change |
|---|---|---|
| `packages/shared/src/ads.ts` (new, exported) | A | Pure helpers (5.2) |
| `packages/domain/src/inbox/meta.ts` | A | Add an optional `onResponse?: (res: Response) => void` to `graph()`'s options, called with every response before the body is read (needed for the usage headers). Additive; agree the option name with spec 01's per-call token option |
| `packages/domain/src/meta/ads.ts` (new, re-exported) | A | Graph reads, sync, usage tracking (5.3) |
| `packages/domain/src/meta/ads-attribution.ts` (new, re-exported) | A | Touches, order attribution, purchase reporting (5.4–5.6) |
| `packages/domain/src/meta/ads-manage.ts` (new, re-exported) | B | Cap, summary, create, pause, resume, budget, rules (5.8–5.12) |
| `apps/api/src/routes/ads.ts` (new) | A, B | Routes (5.7, 5.13) |
| `apps/api/src/test-app.ts` | A | `app.route("/v1/ads", adRoutes(db));` |
| `apps/api/src/lib/r2.ts` | B | `presignAdImagePut` (prefix `ads/images/`, `image/jpeg` or `image/png`, at most 8 MB, 15 minutes) and `getAdImageBytes(key): Promise<Uint8Array>` |
| `apps/worker/src/jobs/ads.ts` (new), `apps/worker/src/inbox-loop.ts` | A, B | Jobs (section 6) |
| `apps/admin/src/components/inbox/ContactPanel.tsx` | A | The "Came from an advert" line (7.8). This is a shared inbox screen, so it goes in `apps/admin` (foundation rule 12) |

### 5.2 Pure helpers (`packages/shared/src/ads.ts`), each unit-tested

```ts
export type AdDestination = "whatsapp" | "messenger" | "instagram";
export interface AdAction { action_type: string; value: string }
/** Pick our counted figures out of Meta's actions lists. */
export function summariseActions(actions: AdAction[] | undefined, actionValues: AdAction[] | undefined):
  { conversationsStarted: number; firstReplies: number; metaPurchases: number; metaPurchaseValue: number };
// conversationsStarted = value of "onsite_conversion.messaging_conversation_started_7d" (0 if absent)
// firstReplies        = value of "onsite_conversion.messaging_first_reply"
// metaPurchases       = value of "omni_purchase" if present, else "onsite_conversion.purchase", else 0  (never the sum: omni already includes the others)
// metaPurchaseValue   = the same choice, from action_values

export function toUnits(amount: number, factor: number): number;      // Math.round(amount * factor)
export function fromUnits(units: number, factor: number): number;     // units / factor
/** Whole days an advert runs: ceil((end - start) / 24h), at least 1. */
export function runDays(start: Date, end: Date): number;
/** The most an advert can spend: daily amount x runDays. */
export function maxSpend(dailyAmount: number, start: Date, end: Date): number;
export interface CapInput { cap: number; othersActiveDaily: number[]; requestedDaily: number }
export interface CapResult { ok: boolean; cap: number; alreadyCommitted: number; requested: number; room: number }
/** ok only when cap > 0 and sum(othersActiveDaily) + requestedDaily <= cap. */
export function evaluateCap(input: CapInput): CapResult;
/** null when spend is 0 or conversations is 0. */
export function costPerConversation(spend: number, conversations: number): number | null;
export function money(amount: number, currency: string): string;      // "₦12,500" for NGN, "$12.50" for USD, "12.50 XYZ" otherwise
/** The object's name tag, " [ms-1a2b3c4d]", from the first 8 hex characters of a draft id. */
export function nameTag(draftId: string): string;
export function destinationOf(destinationType: string | null | undefined): AdDestination | "other";
// WHATSAPP -> whatsapp; MESSENGER -> messenger; INSTAGRAM_DIRECT -> instagram; anything else -> other
/** Read every advert referral out of a stored Messenger or Instagram webhook payload. */
export function extractAdReferrals(kind: string, payload: unknown):
  { index: number; accountExternalId: string; senderId: string; adId: string | null; headline: string | null; ref: string | null; at: Date }[];
```

`extractAdReferrals` accepts either the whole webhook body (`{ object, entry: [{ id, messaging: [...] }] }`) or a single entry (`{ id, messaging: [...] }`); open spec 02's webhook route to see which it stores and keep both branches. For each `messaging` item it looks for a referral at `item.referral`, `item.message?.referral`, `item.postback?.referral`, keeps it only when `source === "ADS"`, and returns `accountExternalId = entry.id`, `senderId = item.sender.id`, `adId = referral.ad_id` as a string, `headline = referral.ads_context_data?.ad_title`, `at = new Date(item.timestamp)`. `index` is the item's position across the whole payload.

### 5.3 Reading and syncing (`packages/domain/src/meta/ads.ts`)

All calls use the system-user token.

```ts
export const ADS_TEMPORARY_CODES: ReadonlySet<string>;   // D10's temporary codes plus "80000","80003","80004","80014"
export interface AdsUsage { accountPct: number | null; businessPct: number | null; regainSeconds: number | null; tier: string | null }
/** Parse the usage headers of a response (A5). Missing or malformed headers give nulls, never an error. */
export function readAdsUsage(headers: Headers, adAccountNumericId: string): AdsUsage;
/** graph() with the usage headers captured; remembers the latest usage per ad account in memory. */
export async function adsGraph<T>(cfg: MetaConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
export function latestAdsUsage(adAccountId: string): AdsUsage | null;

export async function listAdAccounts(cfg): Promise<{ id: string; account_id: string; name: string; currency: string; timezone_name: string; timezone_offset_hours_utc: number; account_status: number }[]>;
export async function getAdAccount(cfg, adAccountId: string): Promise<{ id; account_id; name; currency; timezone_name; timezone_offset_hours_utc; account_status; min_daily_budget?: number; funding_source?: string }>;
export async function listAdObjects(cfg, adAccountId: string, level: "campaign" | "adset" | "ad"): Promise<Record<string, unknown>[]>;   // follows paging.next, at most 20 pages of 100
export async function fetchAdInsights(cfg, adAccountId: string, level: "account" | "ad", since: string, until: string): Promise<Record<string, unknown>[]>;
// GET /{adAccountId}/insights?level=<level>&time_increment=1&time_range={"since":"…","until":"…"}&use_unified_attribution_setting=true
//   &fields=account_currency,campaign_id,adset_id,ad_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values&limit=500   (follow paging.next)
export async function syncAdAccount(db: DbClient, cfg: MetaConfig, log: Log, now?: Date): Promise<{ objects: number; days: number }>;
```

`syncAdAccount`, for the one active `ad_account_link` (return `{0,0}` if none):

1. `getAdAccount` → update `name`, `currency`, `timezone_name`, `timezone_offset_hours_utc`, `account_status`, `min_daily_budget_units`.
2. `listAdObjects` for the three levels → upsert into `ad_campaign_cache` on `(level, external_id)`; never overwrite `created_by_suite`; set `gone_at = now()` on cached rows of this account that Meta no longer lists (and clear it if they reappear). For ads store `creative = { title, body }` only (no image links).
3. `fetchAdInsights` at `level=ad` and at `level=account`: the last 90 days when `backfilled_at` is null (then set it), otherwise the last 8 days (attribution keeps changing for 7 days). Upsert on `(level, external_id, day)`, replacing every figure; `summariseActions` fills the counted columns; `actions` keeps Meta's full list. For `level=account` the `external_id` is the ad account ID.
4. Before each call: if `latestAdsUsage` shows `accountPct >= 80` or `businessPct >= 80`, stop the sync, record `last_error_code='busy'`, `last_error_message='Meta asked us to slow down. The sync will continue on the next run.'` and return.
5. On error: code `190` or `10`/`200`/`299` → record it, raise one `outbox_event` `ads.config_error` per 24 hours, stop. Temporary codes → record `busy` as in 4, stop. Success → clear the error, set `last_synced_at`.

### 5.4 Touches (`packages/domain/src/meta/ads-attribution.ts`)

```ts
/** Create ad_touch rows for advert referrals not yet recorded. Idempotent. Returns how many were created. */
export async function scanAdTouches(db: DbClient, now?: Date): Promise<number>;
```

- **WhatsApp.** Select from `inbox_message` joined to `inbox_conversation` and `inbox_phone_number`: `direction = 'in'`, `created_at > now() - interval '3 days'`, `payload ? 'referral'`, and no `ad_touch` with `source_key = 'msg:' || inbox_message.id`. For each: `source_type = payload.referral.source_type ?? 'ad'`; `ad_external_id = source_id` when the type is `ad`, `post_external_id = source_id` when it is `post`; `headline`, `body`, `source_url`, `media_type`, `ctwa_clid` from the referral; `account_external_id = inbox_phone_number.waba_id`; `customer_id` and `conversation_id` from the conversation; `touched_at = inbox_message.created_at`. (The WhatsApp ingest already stores the raw message, including `referral`, in `inbox_message.payload`.)
- **Messenger and Instagram.** Select from `inbox_webhook_event`: `source = 'meta'`, `kind IN ('page.messages','page.messaging_referrals','page.messaging_postbacks','instagram.messages','instagram.messaging_referral')`, `processed_at IS NOT NULL`, `received_at > now() - interval '3 days'`. Run `extractAdReferrals`. For each result not already present as `evt:<event id>:<index>`: find the identity (`inbox_identity` where `channel` is `messenger` for `page.*` or `instagram` for `instagram.*`, `account_external_id`, `external_id = senderId`); if none, skip it this time (it is retried on later runs for 3 days). `customer_id` from the identity. `conversation_id` = the customer's most recently active conversation on the channel account found with `channelAccountByExternalId` (null if none). `sender_external_id = senderId`.
- Insert with `ON CONFLICT ("source_key") DO NOTHING`. After inserting a touch that has a conversation, `publishInboxEvent(db, signalFor("conversation.updated", conv))` so open inboxes refresh.

### 5.5 Tying orders to adverts — the rule, stated exactly

```ts
export async function attributeOrders(db: DbClient, windowDays: number, now?: Date): Promise<number>;
```

An order is credited to an advert when **all** of these hold:

1. The order is a `sale_order` with `payment_status = 'paid'`, `status` not `cancelled` and not `draft`, and a `customer_id`.
2. A touch exists for the **same customer record**. The touch's customer is read through its conversation when it has one (`coalesce(inbox_conversation.customer_id, ad_touch.customer_id)`), so merging contacts in the inbox carries the credit with it.
3. The touch happened **before** the order was created (`touched_at <= sale_order.created_at`) and **no more than `attribution_window_days` days before** (default 7).
4. If several touches qualify, the **most recent** one gets the whole order ("last advert wins"). An order is never split and never credited twice (`sale_order_id` is unique).

The job looks at paid orders created in the last `windowDays + 3` days that have no `ad_order_attribution` row, and inserts `{ sale_order_id, touch_id, rule: 'last_touch_<N>d', order_at: sale_order.created_at, value_ngn: sale_order.subtotal_ngn, capi_status: 'none' }` with `ON CONFLICT DO NOTHING`. `value_ngn` is the goods total **without the delivery fee**. Once written, an attribution is not moved to a different touch.

Reports count an attributed order only while it is still paid and not cancelled or refunded (joined live to `sale_order`), so a later refund removes it from the figures without touching the row.

What this rule does not catch, said on screen (7.3): orders placed under a different customer record than the one that chatted (for example a different phone number at checkout), and customers who chat on Messenger or Instagram and then order on the website with a phone number, unless their contacts have been merged.

### 5.6 Reporting purchases to Meta

```ts
export async function ensureDataset(cfg: MetaConfig, wabaId: string): Promise<string>;                  // POST /{wabaId}/dataset -> id
export function buildPurchaseEvent(input: { channel: "whatsapp"; wabaId: string; ctwaClid: string; valueNgn: number; at: Date }): Record<string, unknown>;
export async function queuePurchaseReports(db: DbClient, settings: AdsSettingsValue, now?: Date): Promise<number>;
export async function sendPurchaseReports(db: DbClient, cfg: MetaConfig, settings: AdsSettingsValue, log: Log, now?: Date): Promise<number>;
```

`buildPurchaseEvent` returns exactly:

```json
{ "data": [ { "event_name": "Purchase", "event_time": 1763550000, "action_source": "business_messaging", "messaging_channel": "whatsapp",
  "user_data": { "whatsapp_business_account_id": "<WABA id>", "ctwa_clid": "<click id>" },
  "custom_data": { "currency": "NGN", "value": 12500 } } ] }
```

`event_time` is the order's payment time (`payment.paid_at` for the order's paid payment, else `sale_order.created_at`), in whole seconds.

**Consent and least-data rules (all enforced in code):**

1. Nothing is sent unless `capi_enabled` is true. It can only be turned on by the owner, and only after ticking "Our privacy policy tells customers that we share purchase information with Meta to measure our adverts" (stored as `capi_privacy_confirmed_by` / `_at`). The privacy page itself (`apps/customer`) is not changed by this spec; the tick is the owner's statement that it says so.
2. Only customers who **arrived by tapping an advert** are ever reported, and only through the click ID Meta itself issued for that tap. No phone number, name, email, address, order number or list of items is sent, hashed or not. The hashed-details path (E11) is never used.
3. Only WhatsApp purchases are reported in this version (Messenger and Instagram need permissions the token does not hold; section 12).
4. A touch with `reporting_blocked_at` set is never reported (a staff member pressed "Do not report this customer to Meta").
5. A customer whose record has `deleted_at` set is never reported.
6. One event per order, ever (E7).

`queuePurchaseReports`: if `capi_enabled` is false, do nothing and return 0 (rows stay `none`, so an order is still reported if the owner turns reporting on within 7 days of it). Otherwise, for each `ad_order_attribution` row with `capi_status = 'none'` whose order is still paid, check in this order and set `skipped` with the given `capi_note` on the first that applies: the touch's channel is not WhatsApp (`'Only WhatsApp purchases are reported.'`); the touch has no `ctwa_clid` (`'This advert tap had no click code (for example a WhatsApp Status advert).'`); the touch has `reporting_blocked_at` (`'A staff member chose not to report this customer.'`); the customer has `deleted_at` (`'This customer record was removed.'`); `order_at` is more than 7 days ago (`'Too old to report.'`). If none applies, set `queued`.

`sendPurchaseReports`, for each `queued` row (limit 20), following foundation rule 9:

1. Claim: `UPDATE … SET capi_status='sending', capi_locked_at=now(), capi_attempts=capi_attempts+1 WHERE id=$1 AND capi_status='queued' RETURNING`. No row → skip.
2. Write an `ad_action_log` `requested` row (`actor_kind='system'`, `action='report_purchase'`, `summary` "Told Meta about a purchase of ₦12,500 that came from an advert.", `request` = the event **with `ctwa_clid` replaced by its first 6 characters and "…"**).
3. Dataset ID: `settings.datasets[wabaId]`, or `ensureDataset` and save it.
4. `POST /{dataset-id}/events`.
5. Success → `sent`, `capi_sent_at`. `MetaApiError` with `delivery === "unknown"` → `unknown`, **never retried** (a duplicate would inflate Meta's purchase count). `not_sent` and temporary and `capi_attempts < 4` → back to `queued`. `not_sent` otherwise → `failed` with Meta's code and message in `capi_note`; for `190`/`10`/`200`/`299` also raise `ads.config_error` once per 24 hours and set `capi_note` to "Meta has not given the suite permission to report purchases."
6. Write the `result` log row.

Rows stuck in `sending` for over 5 minutes are set to `unknown`.

### 5.7 Phase A routes — `apps/api/src/routes/ads.ts`, mounted at `/v1/ads`

`export function adRoutes(db: DbClient)`. Every route `requireAuth()`. "view" = `requireCapability("ads.view")`. "owner" = `auth.role === "owner"` (403 "Only the owner can change this"). Dates `YYYY-MM-DD`, span at most 400 days. Audit with `writeAudit`.

| Method and path | Who | Does / returns | Audit |
|---|---|---|---|
| `GET /status` | view | `{ data: { account: { ad_account_id, name, currency, timezone_name, account_status, last_synced_at, problem: string \| null, budget_calibrated: boolean } \| null, settings: { manage_enabled, daily_cap, rules_enabled, capi_enabled, attribution_window_days }, shop_time_zone: "Africa/Lagos", usage: AdsUsage \| null } }` | none |
| `GET /accounts/available` | owner | `listAdAccounts` → `{ data: [...] }`. A Meta error → 502 with the staff wording from 7.7 | none |
| `POST /accounts/link` | owner | Body `{ ad_account_id: /^act_\d+$/ }`. Must be in `listAdAccounts`. Deactivates any other link, upserts this one active, sets `refresh_requested_at` | `ads.account_link`, notify |
| `POST /accounts/unlink` | owner | Sets `is_active=false`. Stored figures stay | `ads.account_unlink`, notify |
| `GET /settings` / `PUT /settings` | owner | Body: any of `manage_enabled`, `daily_cap` (integer ≥ 0), `rules_enabled`, `capi_enabled`, `capi_privacy_confirmed` (boolean; required `true` in the same or an earlier request before `capi_enabled` may be true, else 400 "Tick the privacy statement first"), `attribution_window_days` (1–28). `manage_enabled: true` requires a linked, calibrated account (409 "Link the ad account and check the budget unit first"). Also writes an `ad_action_log` pair with `action='settings_change'` | `ads.settings_update` with before and after, notify |
| `GET /overview?from=&to=` | view | `{ data: { currency, day_zone, totals: { spend, impressions, clicks, conversations_started, cost_per_conversation, orders, order_value_ngn, cost_per_order: number \| null }, per_day: { day, spend: number \| null, impressions, clicks, conversations_started }[], orders_per_day: { day, orders, value_ngn }[] } }`. `totals` and `per_day` from `level='account'` rows; days with no row have `spend: null`. `orders*` from live-valid attributions, bucketed by **Lagos** day of `order_at`. `cost_per_order` only when `currency = 'NGN'`, else null | none |
| `GET /adverts?from=&to=` | view | One row per cached ad with any figure or touch in range: `{ ad_external_id, name, campaign_name, destination, status, effective_status, created_by_suite, spend, impressions, clicks, conversations_started, cost_per_conversation, chats_seen, orders, order_value_ngn }`. `chats_seen` = our own count of touches for that ad in range. Sorted by spend, descending | none |
| `GET /adverts/:adExternalId?from=&to=` | view | The row above plus `creative: { title, body }`, `per_day`, and `budget: { daily, end_time } \| null` from its ad set | none |
| `GET /chats?from=&to=&ad=&cursor=` | view | Touches in range, newest first, 50 a page: `{ id, touched_at, channel, ad_external_id, headline, conversation_id \| null, customer_name \| null, order: { order_number, value_ngn, reported: capi_status } \| null, reporting_blocked }`. **Visibility:** load the viewer with `reloadViewer`; `conversation_id` and `customer_name` are filled only when the viewer exists and `canSeeConversation(viewer, conv)` is true; otherwise both are null (the row still counts) | none |
| `GET /conversations/:conversationId/source` | `inbox.view` (not `ads.view`) | Uses `reloadViewer` + `canSeeConversation`, 404 otherwise. Returns `{ data: { touched_at, channel, headline, ad_name \| null } \| null }` for the conversation's latest touch | none |
| `POST /chats/:touchId/block-reporting` / `…/unblock-reporting` | `ads.manage` | Sets or clears `reporting_blocked_at`/`_by` | `ads.reporting_block` / `ads.reporting_unblock` |
| `GET /export.csv?from=&to=` | view | Columns `day,day_time_zone,campaign,advert,destination,currency,spend,impressions,clicks,chats_started_meta,chats_seen_suite,orders,order_value_ngn`; one line per advert per day | `ads.export`, `notify: false` |
| `POST /refresh` | view | Sets `refresh_requested_at`. 429 "Figures were refreshed a few minutes ago. Try again shortly." within 10 minutes of the last sync or request | none |
| `GET /log?cursor=` | view | `ad_action_log` newest first, 50 a page, each `requested` row joined to its `result`: `{ request_id, at, actor_kind, actor_name, action, summary, max_spend, currency, outcome: 'ok' \| 'refused' \| 'unknown' \| 'blocked' \| 'pending', meta_message }`. `request` and `response` bodies are returned only to the owner | none |

### 5.8 Phase B — the gate every money action passes

```ts
// packages/domain/src/meta/ads-manage.ts
export async function assertCanManage(db: DbExecutor): Promise<{ link: AdAccountLinkRow; settings: AdsSettingsValue }>;
```

Throws a typed `AdsManageError(code, staffMessage)` unless, in this order: `ads_settings.manage_enabled` is true (`"off"`, "Creating and changing adverts is switched off. The owner can turn it on in Ads → Settings."); an active link exists (`"no_account"`); `account_status === 1` (`"account_not_active"`, "Meta shows this ad account as not active. Check it in Meta Ads Manager."); `budget_factor` is set (`"not_calibrated"`); `currency` is `NGN` or `USD` (`"currency"`, "The suite can only manage adverts for ad accounts in naira or US dollars."). Every Phase B route also needs `requireCapability("ads.manage")`.

### 5.9 Calibrating the budget unit (owner, once per ad account)

Because the docs do not say what unit `daily_budget` uses (C6), the suite never assumes it.

- `GET /v1/ads/calibration` (owner): reads ad sets fresh from Meta (`listAdObjects(…, "adset")`) and returns those with a `daily_budget`: `{ data: { adsets: [{ external_id, name, daily_budget_units }] , currency } }`.
- `POST /v1/ads/calibration` (owner): body `{ adset_external_id, amount_in_ads_manager: number > 0 }`. Re-read that ad set from Meta. `factor = daily_budget_units / amount_in_ads_manager`. Accept only if it is **exactly 1 or exactly 100**; otherwise 400 "That does not match what Meta reports for this ad set. Check the amount in Meta Ads Manager and try again." Store `budget_factor`, `budget_factor_confirmed_by`, `_at`. Audit `ads.calibrate`, notify; log pair `action='calibrate'`.
- If the account has no ad set with a daily budget, the screen tells the owner to create one switched-off ad set in Meta Ads Manager with a daily budget they will recognise, then come back (7.7).

### 5.10 The cap

```ts
export async function checkCap(cfg: MetaConfig, link: AdAccountLinkRow, settings: AdsSettingsValue,
  req: { requestedDaily: number; excludeAdsetExternalId?: string }): Promise<CapResult>;
```

1. Read **fresh from Meta, not the cache**: all ad sets of the account with their campaign's status (`listAdObjects` for campaigns and ad sets). If the read fails for any reason, throw `AdsManageError("cap_unknown", "We could not check current budgets with Meta, so nothing was changed. Try again in a few minutes.")`.
2. An ad set is **live** when its `status` is `ACTIVE` and its campaign's `status` is `ACTIVE` (review states still count). Skip `excludeAdsetExternalId`.
3. Each live ad set contributes, in whole currency units: its `daily_budget` ÷ factor; or, if it has only a `lifetime_budget`, that amount ÷ factor ÷ whole days left until `end_time` (at least 1), rounded up. A live campaign that holds the budget itself (campaign `daily_budget`) contributes that once, and its ad sets contribute nothing. This counts **every** live ad set in the account, including ones made in Meta Ads Manager.
4. Return `evaluateCap({ cap: settings.daily_cap, othersActiveDaily, requestedDaily })`.

When a check fails the action is not sent; a log pair is written with `outcome='blocked'` and the summary "Blocked by the daily cap: ₦{requested} asked for, ₦{alreadyCommitted} already live, cap ₦{cap}."; the route answers 409 with `{ error: { code: "over_cap", message: "This would take live daily budgets to ₦{total}, over your cap of ₦{cap}. Lower the amount, pause another advert, or ask the owner to raise the cap.", cap, already_committed, requested } }`.

Where the cap is checked: **turning on** (requested = the ad set's daily budget), **changing a budget** of a live ad set (requested = the new amount, excluding the ad set itself), and at **creation** (requested amount alone must be ≤ cap, even though creation is switched off, so an advert that could never be turned on is not created). Pausing is never blocked.

### 5.11 Creating an advert

`ad_draft.spec` shape (validated with zod on every write):

```ts
interface AdDraftSpec {
  destination: "whatsapp" | "messenger" | "instagram";
  account_id: string;                 // inbox_phone_number.id: the WhatsApp number, or the Page (kind messenger), or the Instagram account
  name: string;                       // 3..80 chars, shown in Ads Manager
  headline: string;                   // 1..40
  primary_text: string;               // 1..500
  description: string | null;         // 0..60
  image_key: string;                  // ads/images/YYYY/MM/<uuid>.(jpg|jpeg|png)
  greeting: string;                   // 1..300, what the customer sees in the chat first
  prefilled_message: string | null;   // 1..300, WhatsApp only: the text already typed for the customer
  audience: { area: "nigeria" | "near_shop"; radius_km: number | null; age_min: number; age_max: number };  // age 18..65, min <= max; radius 5..80 when near_shop
  daily_budget: number;               // whole currency units, integer >= 1
  start_at: string;                   // ISO, >= now
  end_at: string;                     // ISO, > start_at + 24h and <= start_at + 30 days
  special_category: false;            // the literal false; see rule 8.14
}
```

```ts
export function buildAdSummary(spec: AdDraftSpec, ctx: { accountLabel: string; adAccountName: string; currency: string; shopName: string }): { lines: string[]; maxSpend: number; confirmText: string };
export function buildCampaignBody(spec, tag: string): Record<string, unknown>;
export function buildAdsetBody(spec, ctx: { campaignId: string; pageId: string; whatsappNumber: string | null; factor: number; shop: { lat: number; lng: number } | null }, tag: string): Record<string, unknown>;
export function buildCreativeBody(spec, ctx: { pageId: string; instagramAccountId: string | null; imageHash: string }, tag: string): Record<string, unknown>;
export function buildAdBody(spec, ctx: { adsetId: string; creativeId: string }, tag: string): Record<string, unknown>;
export function draftFingerprint(spec: AdDraftSpec): string;     // sha256 hex of JSON.stringify(spec) with keys in the interface's order
export async function createAdFromDraft(db: DbClient, cfg: MetaConfig, draftId: string, actor: { userId: string; name: string }): Promise<AdDraftRow>;
```

Bodies (every `name` ends with `nameTag(draft.id)`; **every `status` is `"PAUSED"`**):

- Campaign: `{ name, objective: "OUTCOME_ENGAGEMENT", special_ad_categories: [], buying_type: "AUCTION", status: "PAUSED" }`.
- Ad set: `{ name, campaign_id, destination_type: "WHATSAPP" | "MESSENGER" | "INSTAGRAM_DIRECT", optimization_goal: "CONVERSATIONS", billing_event: "IMPRESSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", daily_budget: toUnits(spec.daily_budget, factor), start_time: <ISO>, end_time: <ISO>, promoted_object: { page_id } (plus whatsapp_phone_number: <digits of the number's e164> for WhatsApp), targeting: { geo_locations: <{ countries: ["NG"] } or { custom_locations: [{ latitude, longitude, radius: radius_km, distance_unit: "kilometer" }] }>, age_min, age_max }, status: "PAUSED" }`. The shop's position comes from env `ADS_SHOP_LAT` / `ADS_SHOP_LNG`; if either is missing the "near the shop" choice is not offered.
- Creative, WhatsApp: `{ name, object_story_spec: { page_id, link_data: { link: "https://api.whatsapp.com/send", name: headline, message: primary_text, description, image_hash, call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } }, page_welcome_message: <the C9 JSON string, with greeting and prefilled_message; when prefilled_message is null use customer_action_type "autofill_message" with content "Hello! Can I get more info on this?"> } }, degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } } }`.
- Creative, Messenger: same shape with `call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }`, `page_welcome_message: greeting` (plain string), and `link: "https://m.me/<page_id>"` (C11, unverified).
- Creative, Instagram: `object_story_spec: { page_id, instagram_actor_id: <instagram account id>, link_data: { message: primary_text, name: headline, image_hash, call_to_action: { type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } }, page_welcome_message: greeting } }` plus the same `degrees_of_freedom_spec`.
- Ad: `{ name, adset_id, creative: { creative_id }, status: "PAUSED" }`.

`OPT_OUT` is chosen so Meta does not alter the picture or text the owner approved. If Meta rejects `OPT_OUT` (C10), stop and report it; do not silently switch to `OPT_IN`.

`createAdFromDraft` runs the steps `image → campaign → adset → creative → ad → verify`, saving the returned ID and the next `step` after each. Around **each** Graph call: write the `requested` log row, call, write the `result` row. Claim first with `UPDATE ad_draft SET status='creating', locked_at=now() WHERE id=$1 AND status IN ('draft','failed') AND confirmed_hash = $2 RETURNING`. A step whose ID is already saved is skipped (so "Continue" after a failure never creates a second copy).

- `image`: `getAdImageBytes(spec.image_key)` → `POST /{act}/adimages { bytes: <base64> }` → `image_hash`.
- `verify`: read the new ad set back (`GET /{adset-id}?fields=daily_budget,status,end_time`). If `daily_budget !== toUnits(spec.daily_budget, factor)` or `status !== "PAUSED"`: set the draft `failed` with "Meta saved a different budget or state than we sent. Do not turn this advert on. Check it in Meta Ads Manager." and never mark it `created_by_suite` (so it cannot be turned on from the suite).
- On success: upsert the three objects into `ad_campaign_cache` with `created_by_suite = true`; draft `created`, `step='done'`.
- Errors: `delivery === "unknown"` → draft `needs_check`. A refusal → draft `failed` with "Meta refused this step: {Meta's message}"; the IDs already saved are kept. Temporary → `failed` with "Meta is busy. Press Continue in a few minutes."
- **Why a timeout here is safe:** everything is created switched off, so an accidental duplicate spends nothing. `POST /drafts/:id/continue` on a `needs_check` draft first lists the level it was on and looks for an object whose `name` ends with the draft's tag; if found it adopts that ID and carries on; if not it repeats the step.

### 5.12 Turning on, pausing, changing a budget, rules

```ts
export async function turnOnAdvert(db, cfg, campaignExternalId: string, actor): Promise<void>;
export async function pauseObject(db, cfg, level: "campaign" | "adset" | "ad", externalId: string, actor: { kind: "person" | "rule" | "safety"; userId: string | null; name: string }, reason: string): Promise<void>;
export async function changeDailyBudget(db, cfg, adsetExternalId: string, newDaily: number, actor): Promise<void>;
export async function evaluateRules(db, cfg, log, now?: Date): Promise<number>;
export async function safetyBrake(db, cfg, log, now?: Date): Promise<number>;
```

- **Turn on** — only for campaigns with `created_by_suite = true` (others: 409 "This advert was not made in the suite. Turn it on in Meta Ads Manager."). `assertCanManage`; the ad set's `end_time` must be in the future (409 "This advert's end date has passed. Create a new one."); `checkCap` with the ad set's daily budget read fresh. Then, each with its own log pair: `POST /{ad-id} { status: "ACTIVE" }`, `POST /{adset-id} { status: "ACTIVE" }`, and **last** `POST /{campaign-id} { status: "ACTIVE" }`. Nothing can deliver until the campaign call succeeds, so a failure part-way leaves it off. Setting `ACTIVE` twice is harmless, so a timeout is followed by one read of the campaign's `status`: `ACTIVE` → done; otherwise report "Meta did not confirm. The advert is still off. Try again."
- **Pause** — allowed on any object in the linked account, suite-made or not, and never blocked by the cap or by `manage_enabled` being off for `actor.kind` `safety`. One call `POST /{id} { status: "PAUSED" }` with a log pair. For a suite-made advert the route pauses the campaign.
- **Change budget** — suite-made ad sets only; `assertCanManage`; new amount ≥ 1 and ≥ `min_daily_budget_units ÷ factor`; if the ad set is live, `checkCap` excluding itself; at most 4 changes an hour per ad set counted from `ad_action_log` (409 "Meta allows a budget to change 4 times an hour. Try again later."). `POST /{adset-id} { daily_budget: toUnits(newDaily, factor) }`, then read it back and compare as in `verify`.
- **Rules** — `evaluateRules` runs only when `manage_enabled` and `rules_enabled` are both true. For each active rule: take suite-made, live campaigns (all of them, or the one in `scope_campaign_external_id`); fetch **fresh** figures for the last `lookback_days` account-days (`GET /{campaign-id}/insights?fields=spend,actions&time_range=…`); if `spend >= min_spend` and (`conversations = 0` or `spend ÷ conversations > threshold`) → `pauseObject("campaign", …, { kind: "rule", userId: null, name: rule.name }, reason)` with the summary "Rule '{name}' paused '{advert}': each chat cost {₦X} over the last {N} days, above your limit of {₦Y}." (or "…: {₦S} spent and no chats started…"), set `last_fired_at`, and insert `outbox_event` `ads.rule_fired`. Always set `last_evaluated_at`, and write a log pair with `action='rule_check'` and outcome `ok` **only when it fires** (non-firing checks are not logged, to keep the log readable). A rule's currency must equal the account's, else it is skipped with a warning log. Rules **only ever pause**. Nothing in the suite turns an advert on by itself.
- **Safety brake** — runs whenever `manage_enabled` is true (it does not need `rules_enabled`). Reads today's account spend fresh (`GET /{act}/insights?date_preset=today&fields=spend&level=account`). If `spend >= daily_cap` and `daily_cap > 0`: pause every live suite-made campaign (`actor.kind = "safety"`, summary "Safety stop: ₦{spend} spent today, at or over the cap of ₦{cap}. '{advert}' was paused."), and insert `outbox_event` `ads.safety_stop` once per account-day.

### 5.13 Phase B routes (all `ads.manage`; all call `assertCanManage` unless noted)

| Method and path | Does | Audit (`writeAudit`, notify) |
|---|---|---|
| `POST /uploads` | `{ filename, content_type, size_bytes }` → `presignAdImagePut` + an upload token (HMAC as in `inbox.ts`) | none |
| `POST /drafts` / `PATCH /drafts/:id` / `GET /drafts/:id` / `GET /drafts` / `DELETE /drafts/:id` | Create, edit (only while `draft` or `failed` with no ID saved; editing clears `confirmed_*`), read, list, delete (only when no ID is saved). No call to Meta | `ads.draft_create`, `ads.draft_update`, `ads.draft_delete` |
| `POST /drafts/:id/preview` | No call that changes anything. Returns `{ data: { lines, max_spend, confirm_text, content_hash, cap: CapResult, min_daily: number \| null, warnings: string[] } }`. `warnings` includes "Meta shows no payment method on this ad account. The advert can be created but will not run until one is added." when `funding_source` is missing | none |
| `POST /drafts/:id/create` | Body `{ content_hash, typed: string }`. `content_hash` must equal `draftFingerprint(spec)` (409 "This advert changed while you were looking at it. Check it again."); `typed` with spaces, commas and currency signs removed must equal `confirm_text` (400 "Type the total exactly as shown to confirm."); `spec.daily_budget <= daily_cap` (409 over-cap wording); budget ≥ the account minimum (400 "Meta's minimum for this account is {₦X} a day."). Stores `confirmed_by`, `confirmed_at`, `confirmed_hash`, then `createAdFromDraft`. Returns the draft | `ads.advert_create` with the summary lines and `max_spend` |
| `POST /drafts/:id/continue` | Resumes a `failed` or `needs_check` draft without asking for the total again, **only if** `draftFingerprint(spec) === confirmed_hash` | `ads.advert_continue` |
| `POST /adverts/:campaignExternalId/turn-on` | Body `{ typed }` must equal the remaining maximum (`daily × whole days left`, at least 1 day) shown in the dialog. Then `turnOnAdvert` | `ads.advert_turn_on` |
| `POST /objects/:level/:externalId/pause` | `pauseObject`. Does **not** require `manage_enabled` (pausing must always be possible) but does require `ads.manage` and a linked account | `ads.pause` |
| `POST /adsets/:externalId/budget` | Body `{ daily_budget, typed }`; `typed` must equal the new remaining maximum. `changeDailyBudget` | `ads.budget_change` with before and after |
| `GET /rules` / `POST /rules` / `PATCH /rules/:id` / `DELETE /rules/:id` | Body `{ name (1..60), threshold (> 0), lookback_days (1 \| 3 \| 7), min_spend (>= 0), scope_campaign_external_id \| null, is_active }`; `currency` is set from the account. Delete is a real delete (the log keeps what the rule did) | `ads.rule_create`, `ads.rule_update`, `ads.rule_delete` |

Error mapping for every Phase B route: `AdsManageError` → 409 with its staff message; a Meta refusal → 502 `{ error: { code: "meta_refused", message: "Meta refused this: <Meta's message>", meta_code } }`; unknown outcome → 502 `{ error: { code: "meta_unknown", message: "Meta did not answer, so we cannot tell if this went through. Nothing has been switched on. Open the advert to check." } }`.

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts` (functions in `apps/worker/src/jobs/ads.ts`; each returns at once when `metaConfigFromEnv()` is null or, for Meta-calling jobs, when there is no active link):

```ts
{ name: "ads_touch_scan", everyMs: 60_000, last: 0, run: () => runAdTouchScan(db, logger) },            // scanAdTouches — works with no ad account linked
{ name: "ads_attribute", everyMs: 5 * 60_000, last: 0, run: () => runAdAttribution(db, logger) },        // attributeOrders, then queuePurchaseReports
{ name: "ads_report_purchases", everyMs: 60_000, last: 0, run: () => runAdPurchaseReports(db, logger) }, // sendPurchaseReports; only when capi_enabled
{ name: "ads_sync", everyMs: 15 * 60_000, last: 0, run: () => runAdSyncIfDue(db, logger) },
{ name: "ads_guard", everyMs: 15 * 60_000, last: 0, run: () => runAdGuard(db, logger) },                 // Phase B: safetyBrake every run; evaluateRules when an hour has passed since any rule's last_evaluated_at
```

`runAdSyncIfDue`: a full `syncAdAccount` when `refresh_requested_at` is newer than `last_synced_at`, or when the Lagos hour is 7 or later and `last_sync_day` is not today; then set `last_sync_day`, clear `refresh_requested_at`. All jobs run under `withJobLock`. Rules for retry are in 5.3, 5.6 and 5.12; no job ever turns an advert on or raises a budget.

## 7. Screens

Files in `apps/suite/src/features/ads/`:

| File | Phase | What |
|---|---|---|
| `ads-api.ts`, `ads-logic.ts` + `ads-logic.test.ts`, `ads.css` | A | Calls, keys (`adsKeys`), pure helpers (`statusLabel`, `destinationLabel`, `reportedLabel`, `parseTyped`) |
| `AdsPage.tsx` | A | Frame and tabs |
| `AdsOverview.tsx`, `AdvertsTable.tsx`, `AdvertPage.tsx`, `AdChatsTable.tsx`, `AdsLog.tsx` | A | Tabs and the advert page |
| `AdsSettings.tsx`, `LinkAccountDialog.tsx`, `CalibrateDialog.tsx` | A (calibrate: B) | Owner settings |
| `AdvertForm.tsx`, `AdvertSummaryDialog.tsx`, `TurnOnDialog.tsx`, `BudgetDialog.tsx`, `RulesTab.tsx`, `RuleDialog.tsx` | B | Creating and managing |

Router: `/ads` → `AdsPage`; `/ads/adverts/$adId` → `AdvertPage`; `/ads/new` and `/ads/drafts/$draftId` → `AdvertForm`. Gate on `ads.view` with the `Needs` gate (reuse it if present; otherwise add it as spec 09 section 7 describes). Menu: under the heading "Marketing" (reuse or add), `{ to: "/ads", label: "Ads", Icon: Megaphone, cap: "ads.view" }`.

Charts follow `apps/admin/src/routes/inbox/reports.tsx` (recharts, `analytics-theme`, `Stat`, `StatHero`). Money uses `money()`; naira figures use `ngn` from `analytics-theme`.

### 7.1 Tabs

"Overview", "Adverts", "Chats from adverts", "Rules" (only when Phase B is built and the viewer has `ads.manage`), "Activity log", "Settings" (owner only). A date toolbar (From, To, "7 days", "30 days", "90 days"; default 30 days) sits above the first three, with "Refresh figures", "Download spreadsheet" and "Last updated {time}".

### 7.2 Not linked yet

A single card: heading "No ad account is linked yet". For the owner: the steps "1. In Meta Business Settings, open Users → System users → NEWUSERSYSTEM. 2. Choose Assign assets → Ad accounts, pick your ad account and allow it to view performance. 3. Come back and press 'Choose ad account'." and the button "Choose ad account". For others: "The owner needs to link the ad account first." The "Chats from adverts" tab still works, because it comes from our own inbox.

### 7.3 Overview

- Header (`StatHero`): eyebrow "Ads", title "What our adverts did", sub "Spend and results from Meta, and the orders we traced back to each advert."
- Tiles: "Spent" ; "Times shown" ; "Taps" ; "Chats started (Meta's count)" ; "Cost per chat" ; "Orders traced to adverts" ; "Sales from those orders" (always naira) ; "Cost per order" (only when the account is in naira; otherwise the hint "Shown only when the ad account is in naira.").
- Chart 1 "Spend and chats by day": bars for spend, a line for chats started; a day with no figure is a gap. Caption: "Days follow the ad account's clock ({timezone_name})." plus, when that is not `Africa/Lagos`, "That is not Lagos time, so a day here does not line up exactly with a shop day."
- Chart 2 "Orders traced to adverts by day" (Lagos days): bars for the number of orders. Caption "Days are Lagos days."
- A boxed note, always shown, titled "How we count an order for an advert": "We count a paid order when the same customer tapped an advert and started a chat with us up to {N} days before ordering. If they tapped more than one advert, the latest one gets the order. Cancelled and refunded orders are left out. We cannot see orders made under a different phone number or account than the one that chatted, so the real figure may be higher. Meta's own purchase count can differ from ours."
- When the account currency is not naira: "Spend is in {USD}; sales are in naira. We do not convert between them."
- States: loading and error through `DataState`; no rows in range: "No advert figures for these dates." ; sync problem: a banner with `account.problem`.

### 7.4 Adverts

Table: "Advert" (name, campaign name small, a tag "Made in the suite" when so), "Opens" (WhatsApp / Messenger / Instagram / Other), "State", "Spent", "Shown", "Taps", "Chats (Meta)", "Chats we saw", "Cost per chat", "Orders", "Sales". State wording (`statusLabel(effective_status)`): `ACTIVE` "Running"; `PAUSED` "Paused"; `CAMPAIGN_PAUSED`, `ADSET_PAUSED` "Paused"; `PENDING_REVIEW`, `IN_PROCESS` "Being checked by Meta"; `DISAPPROVED` "Rejected by Meta"; `WITH_ISSUES` "Has a problem"; `ARCHIVED`, `DELETED` "Ended"; anything else the raw value in lower case. (`ADSET_PAUSED` and `DISAPPROVED` are ad-level values not on the pages read: [unverified]; the fallback covers any other value.) Header button "New advert" (Phase B, `ads.manage`, `manage_enabled`). Rows link to the advert page. At 390 px rows become cards. Empty: "No adverts in these dates."

Under the table: "'Chats (Meta)' is Meta's count of chats started within 7 days of a tap. 'Chats we saw' is how many first messages reached our inbox marked as coming from this advert. The two are counted differently and will not always match."

### 7.5 Advert page

Headline, primary text, where it opens, state, dates, daily budget; the same tiles for this advert; the two charts; a list "Chats from this advert" (as 7.6). Phase B buttons for a suite-made advert: "Turn on" (when off), "Pause" (when running), "Change daily budget". For others: "Pause" only, and the note "This advert was made in Meta Ads Manager. To turn it on or change it, use Ads Manager."

### 7.6 Chats from adverts

Table: "When", "Channel", "Advert" (headline, or "Advert {id}" when unknown), "Customer" (name linking to `/inbox/{conversation_id}`, or "Not visible to you"), "Order" ("{order number} · ₦{value}" or "—"), "Reported to Meta" (`reportedLabel`: `none`/`queued`/`sending` "Waiting"; `sent` "Yes"; `skipped` "No — {capi_note}"; `failed` "Failed — {capi_note}"; `unknown` "Not sure — Meta did not answer"; blank when reporting is off). With `ads.manage`: a row action "Do not report this customer to Meta" / "Allow reporting again". Empty: "No chats have come from adverts in these dates."

### 7.7 Settings (owner)

Sections, top to bottom:

1. **Ad account.** Name, ID, currency, time zone, "Last updated". Buttons "Change" (`LinkAccountDialog`: a list from `GET /accounts/available`, each "{name} · {currency} · {time zone}"; empty list text: "Meta did not list any ad account for the suite. Assign one to the system user in Business Settings, then try again."; error text: "We could not ask Meta for your ad accounts: {reason}.") and "Unlink" (confirm: "Stop reading this ad account? Figures already collected are kept.").
2. **Counting orders.** "Count an order when it comes within [7] days of the advert tap." (1 to 28). Help text: "Changing this affects orders counted from now on."
3. **Tell Meta about purchases.** Switch "Report purchases to Meta", off by default. Text: "When a customer who came from a WhatsApp advert pays for an order, the suite tells Meta that a purchase of that amount happened. This helps Meta show what your adverts earn. We send only the amount, the time, and the click code Meta gave that advert tap. We never send names, phone numbers or what was bought." A required tick box before the switch can be turned on: "Our privacy policy tells customers that we share purchase information with Meta to measure our adverts." If Meta has refused, show under it: "Meta has not given the suite permission to report purchases yet." 
4. **Creating adverts from the suite** (Phase B). Switch "Allow adverts to be created and changed from the suite", off by default, with "This can spend money from your ad account. Only people you have given the 'manage ads' permission can use it. Everything is recorded in the activity log." Disabled until the budget unit is checked, with a button "Check the budget unit" (`CalibrateDialog`).
5. **Daily cap** (Phase B). "The most all running adverts together may be set to spend in a day: [ ] {currency}". Help: "The suite refuses to turn on an advert or raise a budget if that would take the total above this. It counts every running advert in the ad account, including ones made in Meta Ads Manager. Set 0 to stop anything being turned on. Meta can spend a little over a daily budget on a busy day, so also set an account spending limit in Meta Ads Manager."
6. **Rules** (Phase B). Switch "Let rules pause adverts by themselves", off by default. "Rules can only pause. Nothing turns an advert on by itself."

`CalibrateDialog`: title "Check the budget unit". Text: "Meta's system sends budgets as plain numbers, and we need to be certain how it writes them. Pick an ad set below, look it up in Meta Ads Manager, and type the daily budget shown there." A select of ad sets ("{name}"), an input "Daily budget shown in Ads Manager ({currency})", buttons "Cancel" / "Check". Success: "Checked. Meta writes ₦1 as {factor}." No ad sets: "There is no ad set with a daily budget to check against. In Meta Ads Manager create one ad set, switched off, with a daily budget you will recognise, then come back."

Saving any setting uses a confirm for the three switches when turning **on**: "Turn on '{label}'?" with the section's text repeated, buttons "Cancel" / "Turn on".

### 7.8 In the inbox (shared screen, `ContactPanel.tsx`)

When `GET /v1/ads/conversations/:id/source` returns data, show one line under the contact's details: "Came from an advert: "{headline}" · {Thu 19 Nov}". If the headline is missing: "Came from an advert · {date}". Request it with `retry: false` and show nothing on any error (the admin app may not have spec 12's routes yet).

### 7.9 New advert (Phase B, `AdvertForm.tsx`)

Fields, in order, each with its help text:

1. "Where should the advert open a chat?" — WhatsApp / Messenger / Instagram, then a select of the matching channel accounts.
2. "Name (only you see this)".
3. "Picture" — upload, JPEG or PNG up to 8 MB.
4. "Headline" (40), "Main text" (500), "Small print (optional)" (60), each with a counter.
5. "First message the customer sees from us" (300). For WhatsApp also "Message already typed for the customer (optional)" (300), help "They can change it before sending."
6. "Who should see it?" — "Everyone in Nigeria" or "People near the shop" with "Within [ ] km"; "Ages [18] to [65]".
7. "Daily budget ({currency})", with "Meta's minimum for this account: {₦X}" when known and "Your daily cap: {₦Y}".
8. "Starts" and "Ends" (Lagos time; ends at least a day after it starts and within 30 days).
9. "Is this advert about jobs, housing, loans or other financial services, politics or social issues, or gambling?" — "No" / "Yes". Choosing "Yes" disables the buttons and shows: "Adverts on these subjects have extra legal rules. Create this one in Meta Ads Manager, where Meta asks the right questions."
10. A live preview card: picture, headline, main text, and a button reading "Send message" (or "WhatsApp"), captioned "A close likeness. Meta may lay it out differently."

Buttons: "Save draft", "Review and create…". The second saves, calls `preview`, and opens the summary dialog.

### 7.10 Summary and typed confirmation (`AdvertSummaryDialog.tsx`, `ConfirmModal`, `tone="danger"`, `maxWidth` 640)

Title "Check this advert before it is created". Body: the `lines` from the server, as a list. For the example draft they read exactly:

- "This creates an advert on Facebook and Instagram that opens a WhatsApp chat with Mrs Samuel — Main line."
- "Headline: "Fresh juice, delivered today". Main text: "…"."
- "Shown to: people aged 18 to 65 in Nigeria."
- "Budget: up to ₦5,000 a day, from Mon 23 Nov 2026 9:00 am to Mon 30 Nov 2026 9:00 am (7 days)."
- "**The most this advert can spend: ₦35,000.**"
- "Meta takes the money from the ad account "Mrs Samuel Ads" using the payment method saved there."
- "It will be created **switched off**. Nothing is spent until you turn it on."
- "You have confirmed it is not about jobs, housing, loans or financial services, politics, or gambling."

Then any `warnings`, then the cap line "Your daily cap is ₦{cap}; ₦{alreadyCommitted} is already running." Then an input labelled "Type the total (35000) to confirm". The confirm button "Create advert" (busy "Creating…") is disabled until `parseTyped(input) === confirm_text`. Cancel: "Go back". After success: "The advert has been created and is switched off." and go to its page. On `failed`: show the draft's message and a "Continue" button. On `needs_check`: "Meta did not answer. Nothing can have been spent, because adverts are created switched off. Press Continue and we will check what was created."

`TurnOnDialog`: "Turn on "{name}"?" — "From now until {end date} it can spend up to ₦{daily} a day: **₦{remaining maximum} in total**. Meta will check the advert first, which usually takes under a day." Cap line as above. Input "Type the total ({remaining maximum}) to confirm". Buttons "Leave it off" / "Turn on".

`BudgetDialog`: current and new daily budget, the new remaining maximum, the same typed confirmation. Pausing uses a plain confirm: "Pause "{name}"? It stops spending within a few minutes." Buttons "Keep running" / "Pause".

### 7.11 Rules tab and activity log

Rules: a list "Pause if a chat costs more than ₦{X} over the last {N} day(s), once at least ₦{Y} has been spent — {all adverts made in the suite / advert name}", each with a switch, "Edit", "Delete", "Last checked {time}", "Last paused something {time}". Button "New rule". A banner when `rules_enabled` is false: "Rules are switched off. The owner can turn them on in Settings." `RuleDialog` fields: "Name", "Pause when a chat costs more than ({currency})", "Looking at the last [1 / 3 / 7] days", "Only after this much has been spent ({currency})", "Applies to" (all, or one advert).

Activity log: newest first — "{time} · {who}" (a person's name, "Rule: {name}", "Safety stop" or "The suite") · the `summary` · an outcome tag: "Done", "Refused by Meta — {meta_message}", "Blocked by the cap", "No answer from Meta", "In progress". Footer: "This log cannot be edited or deleted."

## 8. Rules and edge cases

Phase A

1. **Read-only.** No Phase A code path issues a `POST` or `DELETE` to an ad object. The only Phase A writes to Meta are `POST /{waba}/dataset` and `POST /{dataset}/events`, both behind `capi_enabled`.
2. **One ad account** is linked at a time (unique index).
3. **A missing day is not zero.** No row → `null` → a gap.
4. **Days.** Ad figures keep the ad account's day and zone; orders use Lagos days; the two are never drawn on one axis.
5. **Currency.** Spend is shown in the account's currency. Sales are naira. No conversion. Cost per order only when the account is in naira.
6. **Attribution** follows 5.5 exactly. Changing the window affects only orders attributed afterwards.
7. **Never credited twice.** `sale_order_id` is unique; `source_key` is unique.
8. **Visibility.** Customer names and conversation links follow `canSeeConversation`; counts do not need it.
9. **Erase.** Erasing a customer's inbox history removes their touches and attributions (cascade). Nothing is sent to Meta about it.
10. **Purchase reports** follow the six rules in 5.6. `unknown` is never retried. One event per order.
11. **Click IDs are personal data.** `ctwa_clid` is never returned by any route and is shortened in the log.
12. **Rate care.** Sync stops at 80% usage (5.3). A sync never runs more than once per 10 minutes.

Phase B

13. **Three locks.** Every create, turn-on and budget change needs: `ads.manage`, `manage_enabled`, and a calibrated account in NGN or USD.
14. **Special categories.** The form's answer must be "No"; the API rejects any draft whose `special_category` is not the literal `false` (422 "Create adverts on these subjects in Meta Ads Manager."). The suite always sends `special_ad_categories: []`.
15. **Created off.** Campaign, ad set and ad are all created `PAUSED`; a test asserts no create body contains `"ACTIVE"`.
16. **The cap is checked against Meta, not the cache,** immediately before the call; if Meta cannot be read the action is refused.
17. **The cap counts everything live** in the account, whoever made it.
18. **Typed confirmation** is checked on the server, not only in the browser.
19. **What was confirmed is what is sent** (`confirmed_hash`); editing a draft clears the confirmation.
20. **Budgets are verified by reading back**; a mismatch blocks the advert from being turned on in the suite.
21. **Rules and the safety brake only pause.** No unattended code path sets `ACTIVE` or raises a budget.
22. **Refusals are shown, kept and never retried automatically.** Meta's code and message are stored in the log.
23. **The log is append-only** (trigger); a test proves `UPDATE` and `DELETE` fail.
24. **Log before call.** No Graph write happens without a `requested` row already committed.
25. **Unknown outcomes.** Creation: safe, resolved by name tag (5.11). Turn-on: read back once. Budget: read back once.
26. **End date required,** at most 30 days out, so the maximum spend is always a finite number.
27. **No lifetime budgets, no bid caps, no audiences from customer lists** are created by the suite.
28. **Pausing always works** for anyone with `ads.manage`, even with `manage_enabled` off.
29. **Double click.** Draft claim and the 30-second rule (A7) make a second identical request fail with 409 "This is already in progress."
30. **Phone width.** All screens usable at 390 px; the typed-confirmation input is at least 44 px tall.

## 9. Tests

`packages/shared/src/ads.test.ts`
- `summariseActions: reads conversations started and first replies`
- `summariseActions: prefers omni_purchase and never adds the purchase types together`
- `summariseActions: missing lists give zeros`
- `toUnits / fromUnits: ₦5,000 at factor 100 is 500000; at factor 1 is 5000`
- `runDays / maxSpend: 7 days at ₦5,000 is ₦35,000; 25 hours counts as 2 days`
- `evaluateCap: refuses when cap is 0; refuses when others + requested exceeds cap; allows exactly at the cap`
- `costPerConversation: null when either is zero`
- `nameTag: stable 8 hex characters`
- `destinationOf: maps the three destination types, other otherwise`
- `extractAdReferrals: finds message.referral on an Instagram message with source ADS`
- `extractAdReferrals: finds a messaging_referrals item on a Page event`
- `extractAdReferrals: ignores referrals whose source is not ADS`
- `extractAdReferrals: accepts a whole body and a single entry`

`packages/domain/src/meta/ads.test.ts` (fetch stubbed)
- `readAdsUsage: parses the three headers; malformed headers give nulls`
- `syncAdAccount: first run asks for 90 days, later runs for 8`
- `syncAdAccount: upserts objects and never clears created_by_suite`
- `syncAdAccount: stops at 80% usage and records busy`
- `syncAdAccount: code 190 records the problem and raises one alert per day`

`packages/domain/src/meta/ads-attribution.test.ts`
- `scanAdTouches: a WhatsApp message with a referral creates one touch; running twice creates one`
- `scanAdTouches: a Messenger event waits until the identity exists`
- `attributeOrders: paid order within 7 days of a touch is attributed`
- `attributeOrders: order before the touch, or 8 days after, is not`
- `attributeOrders: two touches — the later one wins`
- `attributeOrders: unpaid and cancelled orders are ignored`
- `attributeOrders: follows the conversation's customer after a merge`
- `buildPurchaseEvent: exact shape; contains no phone, name or email`
- `queuePurchaseReports: skips when blocked, no click id, not WhatsApp, too old`
- `sendPurchaseReports: writes the requested log row before calling Meta`
- `sendPurchaseReports: a timeout leaves unknown and is not retried`
- `sendPurchaseReports: nothing is sent when capi_enabled is false`

`packages/domain/src/meta/ads-manage.test.ts` (Phase B)
- `assertCanManage: each of the five refusals`
- `checkCap: counts live ad sets made outside the suite`
- `checkCap: refuses when Meta cannot be read`
- `build*Body: no body contains "ACTIVE"; special_ad_categories is []`
- `buildCreativeBody: WhatsApp uses WHATSAPP_MESSAGE and the autofill welcome message`
- `buildAdSummary: lines and total for the example in 7.10`
- `createAdFromDraft: saves each id and resumes without repeating a finished step`
- `createAdFromDraft: budget read back differently marks failed and not created_by_suite`
- `createAdFromDraft: needs_check adopts an object found by name tag`
- `turnOnAdvert: activates the campaign last; over the cap makes no call and logs blocked`
- `changeDailyBudget: fifth change in an hour is refused`
- `evaluateRules: pauses above the threshold; does nothing under min_spend; never activates`
- `safetyBrake: pauses suite-made campaigns when today's spend reaches the cap`

`apps/api/test/integration/ads.test.ts`
- `403 without ads.view; Phase B routes 403 without ads.manage`
- `admin with ads.manage granted still cannot change settings, link, or calibrate (owner only)`
- `link: only an account Meta lists can be linked; a second link replaces the first`
- `overview: totals, null for missing days, orders by Lagos day`
- `chats: hides the customer for a viewer who cannot see the conversation`
- `conversation source: needs inbox.view and visibility, not ads.view`
- `settings: capi_enabled is refused without the privacy tick`
- `create: wrong typed total is 400; stale hash is 409; over cap is 409 and logs blocked`
- `create: with manage_enabled off is 409 and calls nothing`
- `pause works with manage_enabled off`
- `ad_action_log: UPDATE and DELETE raise`
- `no response or log row contains "itest-token" or a full ctwa_clid`

`apps/suite/src/features/ads/ads-logic.test.ts`
- `statusLabel covers every state in 7.4`
- `parseTyped: "₦35,000" and " 35 000 " both give "35000"`
- `reportedLabel covers every capi_status`

## 10. Manual check

Phase A (app-role account, a test ad account assigned to the system user for viewing):

1. As owner: Ads shows "No ad account is linked yet". "Choose ad account" lists the test account; link it. Within a few minutes Overview shows figures (or "No advert figures" for an empty account).
2. Compare spend and chats for one advert and one week with Meta Ads Manager (columns set to the account's attribution setting). Note differences.
3. From a tester's phone, tap a click-to-WhatsApp test advert and send the first message. Within two minutes: the conversation's contact panel says "Came from an advert: …"; "Chats from adverts" lists it.
4. Create and pay a shop order for that customer. Within ten minutes "Orders traced to adverts" is 1 with the right value, and the advert's row shows it.
5. Cancel the order: the figure returns to 0.
6. Settings → turn on "Report purchases to Meta" (tick the statement). Repeat steps 3–4. The chat row shows "Reported to Meta: Yes"; Meta Events Manager shows one Purchase. If Meta refuses, the row shows "Failed — Meta has not given the suite permission…" and nothing else breaks.
7. Press "Do not report this customer to Meta" on a new chat before paying: the row shows "No — A staff member chose not to report this customer."
8. As an admin: sees figures, cannot see Settings. As a manager: no Ads menu line.

Phase B (owner; a test ad account with a small real payment method, or with none):

9. Settings → "Check the budget unit" against an ad set made in Ads Manager with a daily budget of 2,000. Type 2000: accepted. Type 20: refused.
10. Turn on "Allow adverts to be created…"; set the daily cap to 3,000.
11. New advert → WhatsApp → fill in → daily budget 5,000: the summary shows the cap refusal. Change to 2,000 for 2 days: summary shows "The most this advert can spend: ₦4,000". Type 4001: button stays disabled. Type 4000: created. Meta Ads Manager shows campaign, ad set and ad, all off, budget 2,000.
12. Turn on with the typed total. Ads Manager shows it in review. Pause it. Both actions are in the activity log with your name.
13. Create a second advert at 2,000 and try to turn it on while the first is running: refused by the cap, and logged as "Blocked by the cap".
14. Make a rule with a threshold of 1 and minimum spend 0, turn rules on, wait for the hourly check (or run the job by hand): the running advert is paused, the log says "Rule: …".
15. Repeat step 11 for Messenger and Instagram. If Meta refuses either creative, record Meta's message in the pull request (C11, C12 are partly unverified).
16. All of the above once at 390 px.

## 11. Done when

Phase A
- [ ] Migration `0080` applies twice; journal and Drizzle match; `UPDATE`/`DELETE` on `ad_action_log` fail.
- [ ] `ads.view` and `ads.manage` exist; only the owner has `ads.manage` by default.
- [ ] Linking, daily sync, Overview, Adverts, advert page, Chats, export and the log work with a test account.
- [ ] A WhatsApp chat from an advert is labelled in the inbox and counted; Messenger and Instagram likewise once spec 02 is in.
- [ ] Orders are attributed by the rule in 5.5, shown with the explanation box.
- [ ] Purchase reporting is off by default, sends only the fields in 5.6, never twice, and can be blocked per customer.
- [ ] No Phase A code can change an advert.

Phase B
- [ ] Nothing can be created or turned on until the switch is on, the unit is calibrated and a cap above 0 is set.
- [ ] Every create is `PAUSED`; every create, turn-on and budget change shows the summary and needs the typed total, checked on the server.
- [ ] The cap is enforced from a fresh Meta read and counts all live ad sets.
- [ ] Pause, turn on, budget change, rules and the safety stop work and are logged before and after.
- [ ] All tests in section 9 pass; lint, type-check and suite build are clean; checked at 390 px.
- [ ] The pull request lists every **[unverified]** fact (sections 3.1–3.6) with what was found, especially C6, C11, C12, C15, E9 and all of 3.5.

## 12. Out of scope

- Lead-form adverts (spec 13). Boosting an existing post. Catalogue and shopping adverts (spec 08). Video and carousel adverts. Adverts that open more than one app.
- Custom audiences, lookalikes, uploading customer lists, interest targeting, placements, A/B tests, bid caps, lifetime budgets, campaign budget optimisation.
- Editing an advert's picture or text after creation; deleting adverts (use Ads Manager).
- Reporting Messenger and Instagram purchases, and events other than Purchase.
- The hashed-details matching path. Website pixel events.
- Currency conversion. More than one ad account. Ad accounts in currencies other than naira and US dollars (Phase B).
- Call-tracking numbers per advert (blueprint stage 9). The owner dashboard (stage 16).
- Changing the storefront's privacy page.

## 13. Work order

Phase A

1. Permissions `ads.view`, `ads.manage`.
2. Migration `0080`, journal, Drizzle, `ADS_SETTINGS_KEY`. Apply twice; prove the trigger.
3. `packages/shared/src/ads.ts` with tests.
4. `graph()` `onResponse` option; `ads.ts` domain file: usage headers, reads, `syncAdAccount`, tests.
5. Routes: status, accounts, link, unlink, settings, refresh. Worker `ads_sync`. Integration tests.
6. `scanAdTouches` (WhatsApp first), worker `ads_touch_scan`, the conversation-source route, the inbox line (7.8).
7. `extractAdReferrals` wiring for Messenger and Instagram against spec 02's real stored payloads.
8. `attributeOrders`, worker `ads_attribute`, routes overview, adverts, advert, chats, export.
9. Suite: `AdsPage`, not-linked card, Settings (sections 1–3), Overview, Adverts, advert page, Chats, log. Route and menu.
10. Purchase reporting: `ensureDataset`, `buildPurchaseEvent`, queue and send, block/unblock routes, worker job, tests. **First** check E9 against the live account with one test event; if Meta refuses a direct business, leave the switch hidden and say so in the pull request.
11. Check the Phase A **[unverified]** facts (A5, A9, R4, R6, R7, T3, T5) on the live test account. Manual check steps 1–8. Pull request. **Stop for review.**

Phase B (new branch from the merged Phase A)

12. Calibration routes and dialog; `assertCanManage`; settings sections 4–6.
13. `checkCap` with tests.
14. Draft CRUD, `buildAdSummary`, body builders, `draftFingerprint`, with tests; image upload helpers.
15. `createAdFromDraft` (WhatsApp), `preview`, `create`, `continue` routes; form and summary dialog.
16. `turnOnAdvert`, `pauseObject`, `changeDailyBudget`, their routes and dialogs.
17. Rules: table routes, `evaluateRules`, `safetyBrake`, worker `ads_guard`, Rules tab.
18. Messenger and Instagram creatives; check C11, C12, C15, C16, C10 (`OPT_OUT`) live with adverts that stay switched off.
19. Manual check steps 9–16. Pull request, listing everything in section 3.5 as still unconfirmed unless tested.

## 14. Open questions

| # | Question | Recommended default so work is not blocked |
|---|---|---|
| Q1 | What unit is `daily_budget` in? (C6) | Never assume. The calibration step (5.9) measures it against a number the owner can see; Phase B is locked until then |
| Q2 | May a business use the Conversions API for business messaging directly for its own WhatsApp account, without being a registered partner and without `partner_agent`? (E9) Does the token have `whatsapp_business_manage_events`, and is Marketing API full access really required for it (E8)? | Build it last in Phase A, behind the owner switch. Test with one event (work order 10). If refused, keep attribution and reporting in the suite, hide the switch, and raise it with Tes; the alternative is sending events through a partner, which is a business decision |
| Q3 | Is anything in section 3.5 (Nigeria) true? | Treat every item as unknown. The suite shows Meta's own refusal if one comes. Ask the owner to confirm N1 and N2 by creating one advert in Ads Manager before Phase B starts |
| Q4 | Should an order count toward an advert by subtotal or by total including delivery? | Subtotal (`subtotal_ngn`), because the delivery fee is passed on to the courier |
| Q5 | Should the cap count adverts made outside the suite? | Yes (rule 17). It is the owner's daily exposure that matters, and it fails safe |
| Q6 | Should the suite also set a spending limit at Meta (campaign `spend_cap`, minimum about US$100, or the account spending limit) as a second ceiling? | Not in this version: the minimum is above typical budgets here and the naira minimum is unknown. The Settings text tells the owner to set an account spending limit in Ads Manager |
| Q7 | Messenger and Instagram creative fields are documented inconsistently (C11, C12) | Build WhatsApp first; build the other two from the bodies in 5.11 and verify live with switched-off adverts (work order 18). If Meta refuses, ship WhatsApp only and hide the other two choices behind a constant `ENABLED_DESTINATIONS` |
| Q8 | Where does the referral sit on a brand-new Messenger thread? (T5) | `extractAdReferrals` looks in all three places (`referral`, `message.referral`, `postback.referral`) and in the `messaging_referrals`, `messages` and `messaging_postbacks` events. Spec 02 must subscribe the Page to `messaging_referrals` and `messaging_postbacks`, and must store those events even if it does nothing else with them |
| Q9 | **Foundation contradiction:** section 6 reserves four tables for this spec. Eight are needed | Added `ad_touch`, `ad_order_attribution`, `ad_draft`, `ad_rule`, all with the reserved `ad_` prefix, all in migration `0080`. Attribution is stored in `ad_touch` instead of new columns on `inbox_conversation` and `customer`, to honour D2 ("existing customer rows are never modified") and to keep `0080` free of changes to shared tables |
| Q10 | **Foundation contradiction:** D10 lists the temporary error codes. The Marketing API adds `80000`, `80003`, `80004`, `80014` | Treated as temporary in `ADS_TEMPORARY_CODES`. Suggest adding them to D10 |
| Q11 | **Foundation gap:** section 4 says the system-user token "holds every permission these specs need". `whatsapp_business_manage_events`, `page_events`, `instagram_manage_events` and `pages_manage_ads` are not in the blueprint's list | Confirm by reading the token's permissions (`GET /me/permissions` [unverified]) at work-order steps 10 and 12 |
| Q12 | **Foundation gap:** the blueprint says ad creation needs "higher ads access". The docs say standard access is enough for the business's own ad account (A1); what is limited is the call rate (A3: 60 points, 5-minute block) | Phase B fits inside the limited tier for one account (a create is 4 writes = 12 points). Apply for full access only if the sync starts being throttled |
| Q13 | **Foundation gap:** rule 7 forbids unattended actions that spend money. Rules and the safety stop act unattended | They can only pause (reduce spending). Rules need the owner switch `ads_settings.rules_enabled`; the safety stop is on whenever `manage_enabled` is on, and is named here as required by rule 7 |
| Q14 | `graph()` hides response headers; this spec adds an `onResponse` option to shared code owned by spec 01 | Additive and optional. If spec 01's author prefers, `adsGraph` can instead be a small separate fetch wrapper in `ads.ts` that reuses `MetaApiError` |
| Q15 | The inbox line (7.8) is added to a shared admin screen and calls `/v1/ads/...`, which exists in the same API for both apps | Keep the call silent on any error |
