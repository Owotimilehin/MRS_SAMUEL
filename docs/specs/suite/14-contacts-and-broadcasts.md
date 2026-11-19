# Suite build specs — 14: Contacts and broadcasts

Read `00-foundation.md` first (section 9 overrides the rest). Size L, suggested model Opus, built in **two phases that ship separately**.

| | Phase A: Contacts | Phase B: Broadcasts on WhatsApp |
|---|---|---|
| Migration | `0082_contacts.sql` (journal `when` 1787300000000) | `0083_broadcasts.sql` (journal `when` 1787400000000) |
| Table prefix | `contact_` | `broadcast_` |
| Permissions | `contacts.view`, `contacts.manage` | `broadcasts.send` (owner only) |
| Needs Meta | No | Yes: spec 06 templates, and Meta unblocking the account |
| Screens | `apps/suite/src/features/contacts/` | `apps/suite/src/features/broadcasts/` |

Meta facts were checked on 19 Nov 2026. Words used here: a **contact** is a row of the shop's `customer` table (one record, shared with the shop). A **list** is a named group of contacts. A **broadcast** is one approved WhatsApp template sent to a list. **Consent** means the person has agreed to receive promotions; **opt-out** means they asked us to stop.

The owner asked: "can I also have a contact list that lists all my customers, that are easily identified: name, phone number, email, and addresses. This is for promotional, marketing and advertising purposes, so you can just pick clients and add them to a broadcast list."

---

## 1. Outcome

**Phase A.** Staff can say:

- "Contacts shows every customer in one place: name, phone, email, address, how they reach us, what they have ordered and spent, and when we last spoke."
- "I can search by name, by phone typed any way (0803…, 803…, +234…), by email or by Instagram name, and filter: has a phone, ordered in the last 60 days, never ordered, spent at least ₦50,000, agreed to promotions."
- "I can open a contact, correct their name, email, address and notes, and see who changed what."
- "I can add a contact by hand or bring in a spreadsheet. Before anything is saved I see which rows are new, which we already have, and which are refused and why. Nothing we already hold is overwritten."
- "I can tick contacts and put them on a list, or save a filter as a list that keeps itself up to date. I can download a list."
- "For each contact I can see whether they agreed to promotions on WhatsApp, how and when, and who recorded it. If a customer replies STOP on WhatsApp they are taken off promotions at once, everywhere, and told so."

**Phase B.** The owner can say:

- "I pick a list and an approved template, fill the blanks, send it to my own phone first, and see exactly who will and will not get it and why."
- "Before I press Send I am told the number of people. I can send now or pick a time."
- "It sends at a steady pace in the daytime only, never twice to the same person, and stops itself and tells me if WhatsApp reports a problem."
- "Afterwards I see sent, delivered, read, replied, failed (with the reason), who asked to stop, and how many of them ordered in the next 7 days. Replies arrive in the normal inbox."

## 2. Depends on

**Phase A.** Specs 01 (`inbox_identity`, `findOrCreateCustomer` with identity-first matching) and 02 (channels on conversations), both on this branch. Nothing at Meta. Optional later, for R31 only: subscribe the Meta app to the WhatsApp webhook field `user_preferences` (App Dashboard → WhatsApp → Configuration → Webhook fields; label **[unverified]**).

**Phase B.** Phase A; spec 06 (template authoring and review columns on `inbox_template`); spec 05 (`getNumberInfo` reading `whatsapp_business_manager_messaging_limit`). **Things a person must do first** (blueprint section 8, rows 1 to 4 and 9):

1. Owner: fix the payment method on the WhatsApp account, finish business verification, complete the business profile, add the real WhatsApp number. Until then Meta refuses every business-started message, and this phase can be built and tested only against the Graph stub.
2. Owner, with drafts from staff: write and get approved at least one MARKETING template that tells people how to stop (R42).
3. Tes: in the App Dashboard subscribe the app to the WhatsApp webhook fields `account_update`, `business_capability_update`, `user_preferences`, in addition to the existing `messages`, `phone_number_quality_update` and the template fields.
4. Owner: the decisions in section 14 (Q-B1 to Q-B6), then switch broadcasts on in Broadcast settings.

## 3. Meta reference

Short names for pages, all under `https://developers.facebook.com/documentation/business-messaging/whatsapp/` unless a full address is given: **LIM** `messaging-limits` · **ERR** `support/error-codes` · **OPT** `getting-opt-in` · **PRI** `pricing` · **THR** `throughput` · **SND** `messages/send-messages.md` · **STA** `webhooks/reference/messages/status` · **UPW** `webhooks/reference/user_preferences` · **ACU** `webhooks/reference/account_update` · **BCU** `webhooks/reference/business_capability_update` · **PQU** `webhooks/reference/phone_number_quality_update` · **PUL** `templates/marketing-templates/per-user-limits.md` · **MKT** `templates/marketing-templates` · **TQ** `templates/template-quality` · **TPA** `templates/template-pacing` · **TPU** `templates/template-pausing` · **MED** `business-phone-numbers/media` · **MMO** `marketing-messages/overview` · **MMS** `marketing-messages/send-marketing-messages.md` · **MMB** `marketing-messages/onboarding` · **HS** `support/health-status/` · **CHG** `changelog`. **MPO** = `https://developers.facebook.com/docs/messenger-platform/policy/policy-overview`. **MMF** = `https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/faq.md`.

Phase A uses only the rows marked (A). Everything else is Phase B.

| # | Fact | Status |
|---|---|---|
| M1 | A business-started message needs an approved template: when the 24-hour customer service window closes "you can only send pre-approved template messages". The window starts when the person messages or calls and resets to 24 hours each time they do. Send endpoint `POST /{phone-number-id}/messages` | [verified: SND, 19 Nov 2026] |
| M2 (A) | Opt-in: a business must obtain opt-in before messaging people on WhatsApp; it must clearly state that the person is opting in to receive messages from the business and state the business's name; it must comply with local law. The opt-in "can be general and not specifically for WhatsApp, as long as businesses comply with all local laws". Meta also says: give clear instructions for opting out, honour opt-out requests, and get separate opt-ins per message category | [verified: OPT, 19 Nov 2026] |
| M3 (A) | People can stop or resume marketing messages from one business in WhatsApp's own "Offers and announcements" setting. Webhook field `user_preferences`, object `whatsapp_business_account`: `value.user_preferences[] = { wa_id?, user_id?, detail, category: "marketing_messages", value: "stop" \| "resume", timestamp }`; `value.metadata.phone_number_id` names our number. "Interested / Not interested" feedback sends no webhook | [verified: UPW and MKT, 19 Nov 2026] |
| M4 | Sending a marketing template to someone who stopped them: "the API will process the request but not send the message"; the status webhook then fails with code `131050` (recipient opted out of marketing; do not retry) | [verified: MKT and ERR, 19 Nov 2026] |
| M5 | No API reads a person's current stop/resume choice; only the webhook reports it | [unverified] (UPW describes no read call) |
| M6 | Messaging limit: the number of **unique** WhatsApp users we may message **outside** customer service windows in a rolling 24 hours. Tiers 250 (new), 2,000, 10,000, 100,000, unlimited. The limit is **shared by all numbers in the business portfolio** | [verified: LIM, 19 Nov 2026] |
| M7 | Reading the limit: `GET /{phone-number-id}?fields=whatsapp_business_manager_messaging_limit`, example value `"TIER_250"`; `messaging_limit_tier` is deprecated. The code already reads both (`getNumberInfo`, `numberMessagingLimit` in `packages/domain/src/inbox/meta.ts`) | [verified: LIM, 19 Nov 2026] |
| M8 | The full set of values for that field is `TIER_50`, `TIER_250`, `TIER_2K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`, `TIER_NOT_SET` | [unverified] for the read field (these values are documented for the webhooks in PQU and BCU, verified 19 Nov 2026; LIM shows only `TIER_250`). R51 treats anything unknown as 250 |
| M9 | Limit increases: to 2,000 by business verification (or by 2,000 delivered messages to unique numbers in 30 days with good quality); after that one level up within 6 hours when quality is high and at least half the current limit was used in the last 7 days | [verified: LIM, 19 Nov 2026] |
| M10 | Limit changes arrive as webhook field `business_capability_update` with `max_daily_conversations_per_business` (documented values `TIER_250` … `TIER_UNLIMITED`; Meta's own example shows the integer `2000`, so accept both) | [verified: BCU, 19 Nov 2026] |
| M11 | The error code returned when the portfolio's limit is reached | [unverified] (LIM names none). R55's failure-spike stop covers it |
| M12 | Per-user marketing limit: WhatsApp may hold back a marketing template from a person who has had enough promotions lately, from **any** business; it adapts to their read rate. Each delivered marketing template counts; messages inside an open customer service window do not. A held-back message arrives as status `failed` with error code **`131049`**. Wait at least 24 hours before trying that person again; repeated retries can block them for up to 24 hours more | [verified: PUL and ERR, 19 Nov 2026] |
| M13 | WhatsApp does not deliver marketing templates to United States (+1) numbers; these also fail with `131049` | [verified: PUL, 19 Nov 2026] |
| M14 | Phone-number quality is scored from the last 7 days of user feedback, weighted by recency: blocks, reports, mutes, archives and the reasons people give when blocking. Low quality moves the number from Connected to **Flagged**; no tier increase while Flagged; if it does not recover within 7 days the limit drops one level | [verified through a search extract of `https://www.facebook.com/business/help/896873687365001` (Meta's help centre, not the developer docs) and LIM, 19 Nov 2026]: re-read before relying on the timing |
| M15 | `phone_number_quality_update` webhook: `value = { display_phone_number, event, current_limit, old_limit?, max_daily_conversations_per_business? }`. Documented events are `ONBOARDING` and `THROUGHPUT_UPGRADE` only; `current_limit` / `old_limit` are being removed | [verified: PQU, 19 Nov 2026] |
| M16 | That webhook also sends the events `FLAGGED`, `UNFLAGGED`, `DOWNGRADE`, `UPGRADE` | [unverified] (older documentation; not on PQU today). So quality is **polled** (section 6, `broadcast_health`), not taken from this webhook alone |
| M17 | `quality_rating` on the phone number node returns `GREEN`, `YELLOW`, `RED`, `UNKNOWN` or `NA` | `GREEN`, `UNKNOWN`, `NA` [verified: `business-phone-numbers/phone-numbers`, 19 Nov 2026]; `YELLOW`, `RED` [unverified] |
| M18 | `health_status` field on the WhatsApp Business Account, phone number and template nodes: `can_send_message` is `AVAILABLE`, `LIMITED` or `BLOCKED`, with an `entities[]` list (phone number, template, account, business, app) and `errors[]` describing each block | [verified through a search extract of HS, 19 Nov 2026]; the exact `errors[]` field names are [unverified] |
| M19 | Template quality `quality_score`: `GREEN`, `YELLOW`, `RED`, `UNKNOWN`, from negative feedback and low read rates. A template at `RED` is paused: 1st time 3 hours, 2nd time 6 hours, 3rd time disabled. A paused template cannot be sent; attempts are rejected, not charged and do not count against the limit. Webhook `message_template_status_update` fires on pause and on return to active | [verified: TQ and TPU, 19 Nov 2026] |
| M20 | Template pacing (new, un-paused or not-yet-green MARKETING templates): after an unpublished threshold, later messages are **held** while WhatsApp gathers feedback; good feedback releases them, bad feedback **drops** them, each as status `failed` with code `132015`. The send response then carries `message_status: "held_for_quality_assessment"` instead of `"accepted"` | [verified: TPA, 19 Nov 2026] |
| M21 | Throughput: 80 messages per second per number by default; exceeding it gives error `130429`. Too many messages to the same person in a short time gives `131056` (pair rate limit) | [verified: THR and ERR, 19 Nov 2026] |
| M22 | Status webhook: `statuses[] = { id, status, timestamp, recipient_id?, recipient_user_id?, biz_opaque_callback_data?, conversation?, pricing?, errors? }`; `status` is `sent`, `delivered`, `read`, `failed` (or `played`). `delivered` is skipped when the person reads at once. `errors[] = { code, title, message, error_data.details, href }`. `biz_opaque_callback_data` is "included only if the business set this value when sending" | [verified: STA, 19 Nov 2026] |
| M23 | The send request accepts a top-level string `biz_opaque_callback_data` (up to 512 characters) | [unverified] (SND as fetched does not list it). R58 is written to be safe if Meta ignores it |
| M24 | Pricing: per delivered message since 1 July 2025; categories marketing, utility, authentication, service. Marketing templates are always charged on delivery. From 1 Oct 2026 utility templates inside the window and service messages beyond 1,000 a month per number are charged too. `pricing = { billable, pricing_model, type, category, subtype? }` appears on the `sent` **or** the `delivered`/`read` status. Nigeria is a named market on the rate card | [verified: PRI and STA, 19 Nov 2026]. **The owner has said cost is not a concern; the screens still show the count of people, never a naira estimate** |
| M25 | The Marketing Messages API for WhatsApp (formerly "Marketing Messages Lite") is Meta's successor route for marketing templates: `POST /{phone-number-id}/marketing_messages`, same body as the Cloud API, marketing templates only (anything else is an error), optional `product_policy` (`CLOUD_API_FALLBACK` default, or `STRICT`) and `message_activity_sharing`. Same billing; adds delivery optimisation, time-to-live, benchmarks. Status webhooks then carry `pricing.category = "marketing_lite"`. It is send-only | [verified: MMO and MMS, 19 Nov 2026] |
| M26 | **Cloud API stops carrying marketing templates on 13 Oct 2027**; accounts created on or after 13 Apr 2027 cannot use it for marketing at all | [verified: MMO, 19 Nov 2026] |
| M27 | Onboarding to M25: a person with full control of the business accepts the terms (WhatsApp Manager → Overview → Alerts → "Accept terms", or App Dashboard → WhatsApp → Quickstart). Read `GET /{waba-id}?fields=marketing_messages_onboarding_status` → `ELIGIBLE` or `ONBOARDED`. Webhook `account_update` with event `MM_LITE_TERMS_SIGNED` | [verified: MMB, 19 Nov 2026] |
| M28 | Availability for Nigeria: the route is "available in all regions where Cloud API is also available"; only sanctioned regions are excluded; some optimisation features vary by country | [verified through a search extract of CHG and MMB, 19 Nov 2026]. **No Meta page names Nigeria**, so treat as [unverified] until `marketing_messages_onboarding_status` is read on the real account (section 10, step B2) |
| M29 | `account_update` webhook: `value = { event, ban_info?, violation_info?, restriction_info?: [{ restriction_type, expiration }] }`. Events used here: `ACCOUNT_VIOLATION`, `ACCOUNT_RESTRICTION`, `DISABLED_UPDATE`, `ACCOUNT_DELETED`. Restriction type `RESTRICTED_BIZ_INITIATED_MESSAGING` | [verified: ACU, 19 Nov 2026] |
| M30 | Media: `POST /{phone-number-id}/media` (multipart: `messaging_product=whatsapp`, `file`, `type`) returns `{ id }`; the ID lasts 30 days. Images JPEG or PNG up to 5 MB; MP4 video up to 16 MB; PDF up to 100 MB | [verified: MED, 19 Nov 2026] |
| M31 | A template's header picture can be sent by that ID: `{ type: "header", parameters: [{ type: "image", image: { id } }] }` | [unverified] (MED does not cover templates) |
| M32 | Error codes used by the engine: `131026` undeliverable (not on WhatsApp, terms not accepted, or an old app); `131049`; `131050`; `131048` sending restricted after blocks or spam reports; `131056`; `130429`; `80007` account rate limit; `131042` payment problem; `131031` account locked; `368` restricted for policy; `131064` limited for template misclassification; `132001` template missing or not approved; `132015` paused; `132016` disabled; `132000` wrong number of blanks; `132012` blank formatted wrongly; `130472` left out by Meta's own experiment; `131057` maintenance; `131000` unknown error | [verified: ERR, 19 Nov 2026] |
| M33 | Messenger: the standard window is 24 hours; outside it only message tags for approved non-promotional uses (Human Agent: 7 days, manual replies). Promotional content outside the window is possible only through **paid** features: Sponsored Messages (not available for Instagram) and Marketing Messages on Messenger | [verified: MPO, 19 Nov 2026] |
| M34 | Marketing Messages on Messenger: paid per delivered message, only to people who opted in to that Page's subscription, one per person per day, and available to businesses only in a list of countries that **does not include Nigeria** (Australia, Brazil, Chile, Colombia, Hong Kong, India, Indonesia, Israel, Malaysia, Mexico, New Zealand, Peru, Philippines, Saudi Arabia, Singapore, Taiwan, Thailand, UAE, United States, Vietnam) | [verified: MMF, 19 Nov 2026] |
| M35 | Instagram: a business may message only in reply, inside 24 hours (7 days with Human Agent); there is no feature for unrequested promotional direct messages | [unverified] (the Instagram send page read on 19 Nov 2026 lists no window rule; MPO covers Instagram only by saying Sponsored Messages are not available there) |

**Error classes for the engine** (`classifyBroadcastError`, 5.9). Per-recipient result, never retried: `131026`, `131049`, `131050`, `130472`, `131062`, and anything not listed. Temporary (recipient goes back to waiting): `130429`, `131056`, `80007`, `4`, `2`, `131057`, `131000`, HTTP 429, HTTP 5xx with a Meta error body. Stop the broadcast: `131042` (payment); `131031`, `368`, `131064`, `131048` (account or quality); `132001`, `132015`, `132016` (template); `132000`, `132012`, `131008`, `135000` (blanks do not fit); `190`, `10`, `200`, `299`, `283` (configuration, foundation D10 and C2).

**The law (Nigeria).** Nothing here is legal advice. Every line is marked **[legal check]**: the owner must confirm it with a lawyer or the Nigeria Data Protection Commission before Phase B is used.

- The Nigeria Data Protection Act 2023 is understood to require a lawful reason for using a person's details, and consent is the safest reason for promotions. **[legal check]**
- A person is understood to have the right to say no to direct marketing at any time, and stopping must be as easy as agreeing was. **[legal check]**
- The business is understood to need a record of who agreed, when, how, and to what wording. **[legal check]**
- Whether an existing customer may be sent promotions without a fresh "yes" (sometimes called soft opt-in) is **not settled here**. The default is the strict rule: recorded agreement only (Q-B2). **[legal check]**
- A person may ask for their details to be deleted; the existing erase route does that for inbox history, and this spec keeps only the fact that they said stop. **[legal check]**

## 4. Data

### 4.1 Where the facts come from today (read before building)

| Fact shown on Contacts | Real source |
|---|---|
| Name, phone, email, notes, source | `customer.name`, `.phone`, `.email`, `.notes`, `.source` (enum `customer_source`: `walkup_anonymous`, `online`, `phone`, `whatsapp`, `chowdeck`). Soft delete: `customer.deleted_at` |
| Address | **`customer.default_address` when it is not blank; otherwise the most recent `sale_order.delivery_address_formatted`** (by `created_at_local`, status not `cancelled` or `failed`). Shown with a small tag saying which: `Saved address` or `From their last delivery`. `delivery_order.dropoff_address` is not used: dispatch copies it from one of those two, so it adds nothing. `default_address` is written once by `resolveCustomer` (`apps/api/src/lib/customers.ts`) and never refreshed, which is why the last delivery is the fallback and why staff may edit it here |
| Orders, spent, last order | `sale_order` where `customer_id` matches and `status NOT IN ('cancelled','failed')`: the same rule as the shop's Customers page (`NON_COUNTING_STATUSES` in `apps/api/src/routes/customers.ts`), so the two screens always agree. Amount `total_ngn`, date `created_at_local`. Index `idx_sale_order_customer` exists |
| How they reach us | `inbox_identity.channel` (`whatsapp`, `messenger`, `instagram`); `phone` when an `inbox_call` row exists for the customer |
| Last contact | `max(inbox_conversation.last_activity_at)` for the customer |
| Conversations | `inbox_conversation` (`customer_id`, `phone_number_id`, `channel`, `status`, `labels text[]`) |

### 4.2 Migration `packages/db/migrations/0082_contacts.sql` (Phase A)

```sql
-- Contacts (suite spec 14, Phase A). Additive only: new contact_* tables. No existing table is altered.
-- Undo: DROP TABLE "contact_import_row", "contact_consent", "contact_origin", "contact_import",
--   "contact_list_member", "contact_list", "contact_label_member", "contact_label", "contact_alias",
--   "contact_summary" (in that order). Nothing else depends on them.

CREATE TABLE IF NOT EXISTS "contact_summary" (
  "customer_id" uuid PRIMARY KEY REFERENCES "customer"("id") ON DELETE CASCADE,
  "name_sort" text COLLATE "C" DEFAULT '~' NOT NULL,
  "search_text" text DEFAULT '' NOT NULL,
  "phone_digits" text,
  "has_phone" boolean DEFAULT false NOT NULL,
  "has_email" boolean DEFAULT false NOT NULL,
  "has_address" boolean DEFAULT false NOT NULL,
  "address" text,
  "address_source" text CHECK ("address_source" IN ('saved','last_delivery')),
  "channels" text[] DEFAULT '{}'::text[] NOT NULL,
  "orders_count" integer DEFAULT 0 NOT NULL,
  "spent_ngn" bigint DEFAULT 0 NOT NULL,
  "first_order_at" timestamptz,
  "last_order_at" timestamptz,
  "last_order_key" timestamptz DEFAULT '-infinity' NOT NULL,
  "last_contact_at" timestamptz,
  "last_contact_key" timestamptz DEFAULT '-infinity' NOT NULL,
  "created_key" timestamptz DEFAULT now() NOT NULL,
  "wa_unreachable_at" timestamptz,
  "refreshed_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_name" ON "contact_summary" ("name_sort","customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_last_order" ON "contact_summary" ("last_order_key" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_spent" ON "contact_summary" ("spent_ngn" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_last_contact" ON "contact_summary" ("last_contact_key" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_created" ON "contact_summary" ("created_key" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_phone" ON "contact_summary" ("phone_digits");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_alias" (
  "customer_id" uuid PRIMARY KEY REFERENCES "customer"("id") ON DELETE CASCADE,
  "into_customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CHECK ("customer_id" <> "into_customer_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_alias_into" ON "contact_alias" ("into_customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_label" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "name_key" text NOT NULL UNIQUE,
  "colour" text DEFAULT 'green' NOT NULL CHECK ("colour" IN ('green','amber','red','blue','purple','grey')),
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_label_member" (
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "label_id" uuid NOT NULL REFERENCES "contact_label"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "admin_user"("id"),
  "added_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("customer_id","label_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_label_member_label" ON "contact_label_member" ("label_id","customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_list" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "name_key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('static','smart')),
  "description" text,
  "filter" jsonb,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "archived_at" timestamptz,
  CHECK (("kind" = 'smart') = ("filter" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_contact_list_name" ON "contact_list" ("name_key") WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_list_member" (
  "list_id" uuid NOT NULL REFERENCES "contact_list"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "admin_user"("id"),
  "added_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("list_id","customer_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_list_member_customer" ON "contact_list_member" ("customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_import" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "filename" text NOT NULL,
  "status" text DEFAULT 'uploaded' NOT NULL CHECK ("status" IN ('uploaded','previewed','applying','applied','failed','cancelled')),
  "headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "mapping" jsonb,
  "source_label" text,
  "customer_source" text DEFAULT 'phone' NOT NULL CHECK ("customer_source" IN ('walkup_anonymous','online','phone','whatsapp','chowdeck')),
  "consent_declared" text DEFAULT 'none' NOT NULL CHECK ("consent_declared" IN ('none','marketing_whatsapp')),
  "consent_method" text,
  "consent_wording" text,
  "consent_collected_on" date,
  "fill_blanks" boolean DEFAULT false NOT NULL,
  "label_id" uuid REFERENCES "contact_label"("id") ON DELETE SET NULL,
  "list_id" uuid REFERENCES "contact_list"("id") ON DELETE SET NULL,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "new_count" integer DEFAULT 0 NOT NULL,
  "matched_count" integer DEFAULT 0 NOT NULL,
  "rejected_count" integer DEFAULT 0 NOT NULL,
  "applied_rows" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "previewed_at" timestamptz,
  "applied_at" timestamptz,
  "rows_purged_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_import_row" (
  "import_id" uuid NOT NULL REFERENCES "contact_import"("id") ON DELETE CASCADE,
  "row_no" integer NOT NULL,
  "raw" jsonb NOT NULL,
  "name" text,
  "phone_e164" text,
  "email" text,
  "address" text,
  "notes" text,
  "outcome" text DEFAULT 'pending' NOT NULL CHECK ("outcome" IN ('pending','new','matched','rejected')),
  "reason" text,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE SET NULL,
  "filled" jsonb,
  "applied_at" timestamptz,
  PRIMARY KEY ("import_id","row_no")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_import_row_customer" ON "contact_import_row" ("customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_origin" (
  "customer_id" uuid PRIMARY KEY REFERENCES "customer"("id") ON DELETE CASCADE,
  "origin" text NOT NULL CHECK ("origin" IN ('manual','import')),
  "import_id" uuid REFERENCES "contact_import"("id") ON DELETE SET NULL,
  "source_label" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_consent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "channel" text NOT NULL CHECK ("channel" IN ('whatsapp','sms','email','phone')),
  "purpose" text NOT NULL CHECK ("purpose" IN ('marketing','service')),
  "state" text NOT NULL CHECK ("state" IN ('granted','withdrawn')),
  "method" text NOT NULL CHECK ("method" IN ('staff','import','keyword','whatsapp_setting','meta_refusal','erase_request','carried_over','merge')),
  "wording" text,
  "note" text,
  "collected_on" date,
  "recorded_by" uuid REFERENCES "admin_user"("id"),
  "import_id" uuid REFERENCES "contact_import"("id") ON DELETE SET NULL,
  "message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "confirm_state" text DEFAULT 'none' NOT NULL CHECK ("confirm_state" IN ('none','pending','sending','sent','skipped','failed')),
  "recorded_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_contact_consent_current" ON "contact_consent" ("customer_id","channel","purpose") WHERE "is_current";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_consent_history" ON "contact_consent" ("customer_id","recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_consent_state" ON "contact_consent" ("channel","purpose","state") WHERE "is_current";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_consent_confirm" ON "contact_consent" ("recorded_at") WHERE "confirm_state" = 'pending';
```

Journal entry: `{ "idx": <last idx on master + 1; 74 on this branch today>, "version": "7", "when": 1787300000000, "tag": "0082_contacts", "breakpoints": true }`. Foundation ruling 9.2.1 applies: at merge time `when` must be the largest on `master`.

**Column notes**

- `contact_summary` is a **derived** table: one row per live customer who is not an alias. It can be deleted and rebuilt at any time (5.4). It exists so that sorting by spend or last order can use an index and page by key. `name_sort` is `lower(btrim(name))`, or `'~'` when there is no name (sorts last under collation `C`). `phone_digits` is the phone with everything but digits removed and a leading `234` or `0` removed, so `0803…`, `803…` and `+234803…` are one value. `search_text` is the lower-cased name, email and every identity username and display name, joined by spaces. `last_order_key` and `last_contact_key` are the same times with `-infinity` in place of null, so key paging never meets a null. `wa_unreachable_at` is set when a WhatsApp message to this contact failed with `131026` and cleared when they next write (Phase B writes it; Phase A only reads it).
- `contact_alias`: "this customer record is the same person as that one". Written by the inbox **merge** (5.6). An alias has no summary row, so it is not on the Contacts page; its orders are counted under the contact it points to. The shop's `customer` rows are untouched.
- `contact_label.name_key` and `contact_list.name_key` are `lower(btrim(name))`.
- `contact_list.filter` is a `ContactFilter` (5.2) for a smart list, null for a static list. Smart lists have no member rows.
- `contact_consent` is a history: rows are never updated except `is_current` and `confirm_state`. The **current** answer for a contact, channel and purpose is the one row with `is_current`. No row means "not asked". `message_id` is the customer's own STOP or START message. `confirm_state` drives the automatic confirmation (R29).
- `contact_origin`: where a contact created here came from. `customer.source` cannot gain values (ruling 9.2.7), so a hand-added or imported contact gets the `customer_source` the person chose and this row records the truth.
- `contact_import_row.raw` is the row as uploaded (`{ "<header>": "<cell>" }`). `filled` lists the blank fields this import filled on a matched contact, with the values, so the change can be undone by hand.

### 4.3 Migration `packages/db/migrations/0083_broadcasts.sql` (Phase B)

```sql
-- Broadcasts (suite spec 14, Phase B). Additive only: new broadcast_* tables. No existing table is altered.
-- Undo: DROP TABLE "broadcast_event", "broadcast_recipient", "broadcast" (in that order).

CREATE TABLE IF NOT EXISTS "broadcast" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft','scheduled','sending','paused','stopped','done','cancelled')),
  "stop_reason" text,
  "stop_detail" text,
  "phone_number_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "template_id" uuid REFERENCES "inbox_template"("id") ON DELETE SET NULL,
  "template_name" text,
  "template_language" text,
  "template_category" text,
  "list_id" uuid REFERENCES "contact_list"("id") ON DELETE SET NULL,
  "list_name" text,
  "blanks" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "header_media_key" text,
  "header_media_mime" text,
  "header_media_id" text,
  "header_media_uploaded_at" timestamptz,
  "route" text DEFAULT 'cloud' NOT NULL CHECK ("route" IN ('cloud','mm')),
  "fingerprint" text,
  "test_fingerprint" text,
  "test_to" text,
  "test_message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "test_sent_at" timestamptz,
  "scheduled_at" timestamptz,
  "confirmed_by" uuid REFERENCES "admin_user"("id"),
  "confirmed_at" timestamptz,
  "confirmed_count" integer,
  "attribution_days" integer DEFAULT 7 NOT NULL,
  "warmup_until" timestamptz,
  "wait_until" timestamptz,
  "temp_errors" integer DEFAULT 0 NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_status" ON "broadcast" ("status","scheduled_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_recipient" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "broadcast_id" uuid NOT NULL REFERENCES "broadcast"("id") ON DELETE CASCADE,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE SET NULL,
  "to_wa" text,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending','skipped','sending','sent','delivered','read','failed','unknown')),
  "skip_reason" text,
  "values" jsonb,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz,
  "claimed_at" timestamptz,
  "message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "wa_message_id" text,
  "error_code" text,
  "error_text" text,
  "sent_at" timestamptz,
  "delivered_at" timestamptz,
  "read_at" timestamptz,
  "failed_at" timestamptz,
  "replied_at" timestamptz,
  "opted_out_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_broadcast_recipient_customer" ON "broadcast_recipient" ("broadcast_id","customer_id") WHERE "customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_broadcast_recipient_number" ON "broadcast_recipient" ("broadcast_id","to_wa") WHERE "to_wa" IS NOT NULL AND "state" <> 'skipped';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipient_work" ON "broadcast_recipient" ("broadcast_id","state","next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipient_customer" ON "broadcast_recipient" ("customer_id","sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipient_message" ON "broadcast_recipient" ("message_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "broadcast_id" uuid NOT NULL REFERENCES "broadcast"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "detail" text,
  "user_id" uuid REFERENCES "admin_user"("id"),
  "at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_event" ON "broadcast_event" ("broadcast_id","at");
```

Journal entry: `{ "idx": <last + 1>, "version": "7", "when": 1787400000000, "tag": "0083_broadcasts", "breakpoints": true }`.

**Column notes**

- `broadcast.blanks`: `BroadcastBlanks` (5.2): how each blank of the template is filled. `fingerprint` is the SHA-256 of `{ template_id, template components, blanks, header_media_key, phone_number_id }`; `test_fingerprint` is the fingerprint at the last successful test. They must be equal to confirm (R44).
- `status`: `draft` → (`scheduled` →) `sending` → `done`. A **person** pauses (`paused`) or cancels (`cancelled`); the **system** stops (`stopped`, with `stop_reason`). `stop_reason` is one of `switched_off`, `quality`, `template`, `account`, `payment`, `config`, `blanks`, `failure_spike`, `optout_spike`, `meta_busy`, `media_expired`, `too_long`.
- `broadcast_recipient`: one row per contact per broadcast, written at confirmation. `values` holds the filled blanks for that person (`{ body: string[], header?: string }`), so what was sent can be shown later. `skip_reason` is one of `no_phone`, `opted_out`, `not_whatsapp`, `no_consent`, `duplicate_number`, `recent`, `held_back`, `erased`, `cancelled`. The two unique indexes are the "never twice" guarantee (R57).
- `broadcast_event.kind`: `confirmed`, `started`, `paused`, `resumed`, `stopped`, `cancelled`, `finished`, `waiting_hours`, `waiting_limit`, `warmup`.

**Settings** (no migration: two rows in the existing `app_settings` table, keys `contact_settings` and `broadcast_settings`; shapes and defaults in 5.2).

### 4.4 Drizzle

Add `packages/db/src/schema/contact.ts` (Phase A) exporting `contactSummary`, `contactAlias`, `contactLabel`, `contactLabelMember`, `contactList`, `contactListMember`, `contactImport`, `contactImportRow`, `contactOrigin`, `contactConsent`, and `packages/db/src/schema/broadcast.ts` (Phase B) exporting `broadcast`, `broadcastRecipient`, `broadcastEvent`. Mirror the SQL exactly (camelCase property names; `text("name_sort")` needs no collation in Drizzle, the SQL carries it). Type the jsonb columns with the interfaces in 5.2 (`ContactFilter`, `ImportMapping`, `BroadcastBlanks`). Export both from `packages/db/src/schema/index.ts`.

## 5. Server

### 5.1 Permissions (`packages/shared/src/permissions.ts`)

| Permission | Phase | Lets a person | Default |
|---|---|---|---|
| `contacts.view` | A | See the Contacts page, a contact's details, lists and (Phase B) broadcast results | owner, admin, manager |
| `contacts.manage` | A | Edit a contact; add by hand; import; labels; lists; record consent; (Phase B) pause a broadcast | owner, admin |
| `broadcasts.send` | B | Create, test, confirm, schedule, resume and cancel a broadcast; change broadcast settings | **owner only**. Not in `ADMIN_CAPS` or `MANAGER_CAPS`; grantable per person |

Add each to `CAPABILITIES` with a comment, to the role lists above, to `GateEditor` in the admin app (the per-user permission screen) and to `permissions.test.ts`, as spec 06 did for `templates.manage`. **Downloads** need `inbox.export` as well as `contacts.view` (the existing export permission; owner and admin).

Contact and broadcast routes use `requireAuth()` and `requireCapability(...)` from `apps/api/src/middleware/auth.js`, as `apps/api/src/routes/templates.ts` does. They do **not** use `withViewer`, because a person may hold `contacts.view` without `inbox.view`.

### 5.2 Shared, browser-safe: `packages/shared/src/contacts.ts` (A) and `packages/shared/src/broadcasts.ts` (B)

```ts
// contacts.ts
export type ContactChannel = "whatsapp" | "messenger" | "instagram" | "phone";
export type ContactSource = "walkup_anonymous" | "online" | "phone" | "whatsapp" | "chowdeck" | "manual" | "import";
export type ConsentView = "agreed" | "stopped" | "not_asked";          // marketing on WhatsApp
export type ContactSort = "name" | "last_order" | "spent" | "last_contact" | "added";

export interface ContactFilter {
  q?: string;                         // not allowed in a smart list
  channels?: ContactChannel[];        // any of
  has_phone?: boolean; has_email?: boolean; has_address?: boolean;
  ordered_within_days?: number;       // 1..3650
  never_ordered?: boolean;
  min_spent_ngn?: number;             // >= 0
  min_orders?: number;                // >= 1
  last_contact_within_days?: number;  // 1..3650
  label_ids?: string[];               // any of
  sources?: ContactSource[];          // any of
  consent?: ConsentView;
  list_id?: string;                   // a static list; not allowed in a smart list
}
export function parseContactFilter(input: unknown, o: { forSmartList: boolean }): { ok: true; filter: ContactFilter } | { ok: false; error: string };
export function describeContactFilter(f: ContactFilter, labelNames: Record<string, string>): string[]; // plain-English lines, 7.3

export const STOP_WORDS = ["stop", "stop all", "stopall", "unsubscribe", "opt out", "optout", "opt-out", "remove me", "stop promo", "stop promotions", "no more messages"] as const;
export const START_WORDS = ["start", "unstop", "subscribe", "opt in", "optin", "opt-in", "resume"] as const;
/** The whole message, trimmed, lower-cased, with trailing . ! and surrounding quotes removed, must equal one word in the list. */
export function consentKeyword(body: string | null | undefined): "stop" | "start" | null;

export interface ContactSettings { stop_confirmation: boolean; stop_text: string; start_text: string }
export const DEFAULT_CONTACT_SETTINGS: ContactSettings = {
  stop_confirmation: true,
  stop_text: "You will not get promotions from Mrs. Samuel Fruit Juice on WhatsApp any more. We will still answer your messages and send updates about your orders. Reply START if you change your mind.",
  start_text: "Welcome back. You will get offers and news from Mrs. Samuel Fruit Juice on WhatsApp again. Reply STOP at any time to stop them.",
};

/** RFC 4180 parser: quoted cells, doubled quotes, CR LF or LF, a leading UTF-8 byte-order mark. Never throws. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] };
export type ImportField = "name" | "first_name" | "last_name" | "phone" | "email" | "address" | "notes";
export type ImportMapping = Partial<Record<ImportField, string>>;      // field -> header text
export function suggestMapping(headers: string[]): ImportMapping;       // R17
export function firstName(name: string | null | undefined): string | null; // R45

// broadcasts.ts
export type BlankSource = { from: "first_name" | "full_name"; fallback: string } | { from: "fixed"; text: string };
export interface BroadcastBlanks { body: BlankSource[]; header?: BlankSource; buttons?: { index: number; text: string }[] }
export function fillBlanks(b: BroadcastBlanks, contact: { name: string | null }): { body: string[]; header?: string };
export interface BroadcastSettings {
  enabled: boolean;                 // the owner switch (foundation C6)
  send_from: string; send_until: string;   // "HH:MM", Africa/Lagos
  rate_per_minute: number;          // 6..60
  min_days_between: number;         // 0..90
  attribution_days: number;         // 1..30
  audience_rule: "consent_only" | "consent_or_recent_customer";
  recent_customer_months: number;   // 1..24
  daily_share: number;              // 0.1..1: share of the WhatsApp limit a day's sending may use
  route: "cloud" | "mm";
}
export const DEFAULT_BROADCAST_SETTINGS: BroadcastSettings = { enabled: false, send_from: "09:00", send_until: "19:00",
  rate_per_minute: 20, min_days_between: 7, attribution_days: 7, audience_rule: "consent_only", recent_customer_months: 12, daily_share: 0.8, route: "cloud" };
/** "TIER_250" -> 250, "TIER_2K" -> 2000, "TIER_10K", "TIER_100K", "TIER_UNLIMITED" -> Infinity; a bare number as text or integer -> that number; "TIER_50" -> 50; anything else, null or "TIER_NOT_SET" -> 250. */
export function tierToNumber(tier: string | number | null | undefined): number;
export function withinSendingHours(now: Date, s: Pick<BroadcastSettings, "send_from" | "send_until">): boolean;   // uses localParts(now, "Africa/Lagos")
export function nextSendingStart(now: Date, s: Pick<BroadcastSettings, "send_from" | "send_until">): Date;
export const SKIP_REASON_TEXT: Record<string, string>;   // 7.8
export const STOP_REASON_TEXT: Record<string, string>;   // 7.10
export function plainFailure(code: string | null): string; // 7.10
```

### 5.3 Domain, Phase A: `packages/domain/src/contacts/` (re-exported from the package index)

```ts
// match.ts
/** The read half of findOrCreateCustomer, exported from inbox/core.ts so both use one rule (see 5.5). */
// summary.ts
export function refreshContactSummary(db: DbExecutor, customerIds: string[]): Promise<void>;       // 5.4; no-op for []
export function refreshChangedSummaries(db: DbClient, since: Date, now: Date): Promise<number>;    // worker
export function rebuildAllSummaries(db: DbClient): Promise<number>;                                 // worker, nightly
// filter.ts
/** A WHERE fragment over contact_summary aliased "s" (and customer "c"). The only place a ContactFilter becomes SQL. */
export function contactFilterSql(f: ContactFilter, now: Date): SQL;
export function listMembersSql(list: { id: string; kind: "static" | "smart"; filter: ContactFilter | null }, now: Date): SQL; // customer ids of a list
// consent.ts
export type ConsentChange = { channel: "whatsapp" | "sms" | "email" | "phone"; purpose: "marketing" | "service"; state: "granted" | "withdrawn";
  method: "staff" | "import" | "keyword" | "whatsapp_setting" | "meta_refusal" | "erase_request" | "carried_over" | "merge";
  wording?: string | null; note?: string | null; collectedOn?: string | null; recordedBy?: string | null; importId?: string | null; messageId?: string | null; confirm?: boolean };
/** Insert a history row and make it current, in the caller's transaction. Returns false (and writes nothing) when the current row already has this state. */
export function recordConsent(db: DbExecutor, customerId: string, c: ConsentChange): Promise<boolean>;
export function currentConsent(db: DbExecutor, customerId: string): Promise<{ channel: string; purpose: string; state: string; method: string; recorded_at: Date }[]>;
/** Called by WhatsApp ingest for every inbound customer message (R27). No Meta call. */
export function applyConsentKeyword(db: DbExecutor, a: { customerId: string; messageId: string; type: string; body: string | null; at: Date }): Promise<"stop" | "start" | null>;
/** Called by WhatsApp ingest for a user_preferences change (R31). */
export function applyUserPreference(db: DbExecutor, p: { wa_id?: string; user_id?: string; category?: string; value?: string; timestamp?: number }): Promise<boolean>;
/** Worker (R29). */
export function sendConsentConfirmations(db: DbClient, cfg: MetaConfig | null, now?: Date): Promise<number>;
// import.ts
export function previewImport(db: DbClient, importId: string): Promise<{ new: number; matched: number; rejected: number }>;   // R18 to R21
export function applyImportBatch(db: DbClient, importId: string, size: number): Promise<{ done: boolean; applied: number }>; // R22, worker
/** Create a contact by hand or from an import row, or return the match. Runs inside a transaction. */
export function findOrCreateContact(db: DbExecutor, input: { name?: string | null; phone?: string | null; email?: string | null; address?: string | null; notes?: string | null;
  customerSource: "walkup_anonymous" | "online" | "phone" | "whatsapp" | "chowdeck"; origin: "manual" | "import"; importId?: string | null; sourceLabel?: string | null; createdBy: string | null }):
  Promise<{ customerId: string; created: boolean; matchedBy: "phone" | "email" | null }>;
```

### 5.4 The summary: exact refresh

`refreshContactSummary(db, ids)` runs these two statements (`$1` = `ids::uuid[]`):

```sql
INSERT INTO contact_summary AS s (customer_id, name_sort, search_text, phone_digits, has_phone, has_email, has_address, address, address_source,
  channels, orders_count, spent_ngn, first_order_at, last_order_at, last_order_key, last_contact_at, last_contact_key, created_key, refreshed_at)
SELECT c.id,
  coalesce(nullif(lower(btrim(c.name)), ''), '~'),
  lower(concat_ws(' ', c.name, c.email, i.handles)),
  nullif(regexp_replace(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), '^(234|0)', ''), ''),
  nullif(btrim(coalesce(c.phone, '')), '') IS NOT NULL,
  nullif(btrim(coalesce(c.email, '')), '') IS NOT NULL,
  coalesce(nullif(btrim(c.default_address), ''), o.last_address) IS NOT NULL,
  coalesce(nullif(btrim(c.default_address), ''), o.last_address),
  CASE WHEN nullif(btrim(c.default_address), '') IS NOT NULL THEN 'saved' WHEN o.last_address IS NOT NULL THEN 'last_delivery' END,
  array_remove(ARRAY[CASE WHEN i.wa THEN 'whatsapp' END, CASE WHEN i.ms THEN 'messenger' END, CASE WHEN i.ig THEN 'instagram' END, CASE WHEN k.called THEN 'phone' END], NULL),
  coalesce(o.n, 0), coalesce(o.spent, 0), o.first_at, o.last_at, coalesce(o.last_at, '-infinity'),
  v.last_at, coalesce(v.last_at, '-infinity'), c.created_at, now()
FROM customer c
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n, sum(so.total_ngn)::bigint AS spent, min(so.created_at_local) AS first_at, max(so.created_at_local) AS last_at,
    (array_agg(so.delivery_address_formatted ORDER BY so.created_at_local DESC) FILTER (WHERE nullif(btrim(so.delivery_address_formatted), '') IS NOT NULL))[1] AS last_address
  FROM sale_order so
  WHERE so.status NOT IN ('cancelled','failed')
    AND (so.customer_id = c.id OR so.customer_id IN (SELECT a.customer_id FROM contact_alias a WHERE a.into_customer_id = c.id))
) o ON true
LEFT JOIN LATERAL (
  SELECT bool_or(channel = 'whatsapp') AS wa, bool_or(channel = 'messenger') AS ms, bool_or(channel = 'instagram') AS ig,
    string_agg(concat_ws(' ', username, display_name), ' ') AS handles
  FROM inbox_identity WHERE customer_id = c.id
) i ON true
LEFT JOIN LATERAL (SELECT max(last_activity_at) AS last_at FROM inbox_conversation WHERE customer_id = c.id) v ON true
LEFT JOIN LATERAL (SELECT true AS called FROM inbox_call WHERE customer_id = c.id LIMIT 1) k ON true
WHERE c.id = ANY($1) AND c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM contact_alias a WHERE a.customer_id = c.id)
ON CONFLICT (customer_id) DO UPDATE SET
  name_sort = excluded.name_sort, search_text = excluded.search_text, phone_digits = excluded.phone_digits, has_phone = excluded.has_phone,
  has_email = excluded.has_email, has_address = excluded.has_address, address = excluded.address, address_source = excluded.address_source,
  channels = excluded.channels, orders_count = excluded.orders_count, spent_ngn = excluded.spent_ngn, first_order_at = excluded.first_order_at,
  last_order_at = excluded.last_order_at, last_order_key = excluded.last_order_key, last_contact_at = excluded.last_contact_at,
  last_contact_key = excluded.last_contact_key, created_key = excluded.created_key, refreshed_at = now();

DELETE FROM contact_summary s USING customer c
WHERE s.customer_id = ANY($1) AND c.id = s.customer_id
  AND (c.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM contact_alias a WHERE a.customer_id = c.id));
```

`wa_unreachable_at` is never touched by the refresh. `refreshChangedSummaries(db, since, now)` collects the customer IDs changed since `since − 5 minutes` from `customer.updated_at`, `customer.created_at`, `sale_order.updated_at` (its `customer_id`, and the alias target if any), `inbox_conversation.last_activity_at`, `inbox_identity.updated_at`, `inbox_call.started_at` and `contact_alias.created_at`, and refreshes them in batches of 500. `rebuildAllSummaries` refreshes every live customer in batches of 500 ordered by `id`, then deletes summary rows whose customer no longer qualifies. Every route in 5.7 that changes a contact calls `refreshContactSummary(tx, [id])` before it commits, so staff see their own change at once. Order figures from the shop can lag by up to one minute (section 6); the page says so (7.2).

### 5.5 Changes to existing files, Phase A

- **`packages/domain/src/inbox/core.ts`.** Extract the matching in `findOrCreateCustomer` into an exported function and call it from `findOrCreateCustomer` with no change in behaviour:
  ```ts
  /** Lock the number, then: a live WhatsApp identity for it wins; else the oldest live customer whose phone has the same digits. Runs inside a transaction. */
  export async function matchCustomerForPhone(db: DbExecutor, e164: string): Promise<{ id: string } | null>;
  ```
  It takes `lockPhone`, calls `identityByKey` then `matchCustomerByPhone`, exactly as lines 225 to 233 do today. `findOrCreateContact` (5.3) calls it. **This is what "the same matching rules as `findOrCreateCustomer`" means: the same function.** The existing tests in `inbox.test.ts` and `inbox-identities.test.ts` must pass unchanged.
- **`packages/domain/src/inbox/whatsapp-ingest.ts`.**
  1. In `ingestMessage`, after the message row is inserted and only when `fromCustomer` is true: `const kw = await applyConsentKeyword(db, { customerId: who.customerId, messageId: row.id, type: parsed.type, body: parsed.body, at });`. When `kw` is not null, also `update inbox_message set payload = payload || '{"_suite":{"consent":"<kw>"}}'` for that row. The message is stored, shown and counted as unread exactly as before.
  2. In `ingestWhatsAppPayload`, before the `change.field !== "messages"` line: `if (change.field === "user_preferences") { for (const p of (value as { user_preferences?: unknown[] }).user_preferences ?? []) await applyUserPreference(db, p as never); continue; }`.
- **`packages/domain/src/inbox/send.ts`.** Widen `SendInput.auto` to `"after_hours" | "opt_out" | "opt_in"`. No other change in Phase A: an automatic text is already sent with `userId: null`, keeps the list preview, and writes `payload.auto`.
- **`packages/domain/src/inbox/auto-reply.ts`.** `sendAfterHoursAutoReplies` must skip a conversation whose newest inbound message has `payload->'_suite'->>'consent'` set, so a person who writes STOP at night gets one reply, not two.
- **`apps/api/src/routes/inbox.ts`** (ruling 9.2.8): 5.6.
- **`apps/api/src/test-app.ts`**: `app.route("/v1/contacts", contactRoutes(db));` after the templates line.

### 5.6 Merge and erase (`apps/api/src/routes/inbox.ts`)

**Merge** (`POST /contacts/:customerId/merge`), inside its transaction, after the identities move. `F` = `fromId`, `T` = `intoId`.

1. Labels: `INSERT INTO contact_label_member (customer_id, label_id, added_by, added_at) SELECT T, label_id, added_by, added_at FROM contact_label_member WHERE customer_id = F ON CONFLICT DO NOTHING;` then `DELETE FROM contact_label_member WHERE customer_id = F;`
2. Lists: the same two statements on `contact_list_member` (`list_id` in place of `label_id`).
3. Consent, for each `(channel, purpose)` pair that `F` has rows for: set `is_current = false` on every row of `F` and `T` for the pair; `UPDATE contact_consent SET customer_id = T WHERE customer_id = F` for the pair; then make one row current: **the newest `withdrawn` row if either side's current row was `withdrawn`** (a "stop" always wins), otherwise the newest `granted` row. Insert nothing new.
4. Import rows: `UPDATE contact_import_row SET customer_id = T WHERE customer_id = F;`
5. Origin: if `T` has no `contact_origin` row, `UPDATE contact_origin SET customer_id = T WHERE customer_id = F`; otherwise `DELETE` `F`'s row.
6. Alias: `UPDATE contact_alias SET into_customer_id = T WHERE into_customer_id = F;` then `INSERT INTO contact_alias (customer_id, into_customer_id, created_by) VALUES (F, T, <user>) ON CONFLICT (customer_id) DO UPDATE SET into_customer_id = excluded.into_customer_id;`. If `T` is itself an alias, refuse before the transaction: 400 `Pick the main contact, not one that was merged into another.`
7. Phase B: `UPDATE broadcast_recipient r SET customer_id = T WHERE customer_id = F AND NOT EXISTS (SELECT 1 FROM broadcast_recipient x WHERE x.broadcast_id = r.broadcast_id AND x.customer_id = T);` Rows that would clash keep `F` (the history stays true; the unique index is never broken).
8. `refreshContactSummary(tx, [F, T])`. `F` leaves the Contacts page; its orders now count under `T`. Add `moved_labels`, `moved_lists`, `alias: true` to the audit `after` and to the response.

The shop's `customer` rows are not changed, as today.

**Erase** (`POST /contacts/:customerId/erase`), inside its transaction, after the identities are deleted:

1. `DELETE FROM contact_label_member WHERE customer_id = <id>;` and the same for `contact_list_member` and `contact_origin`.
2. `UPDATE contact_import_row SET raw = '{}'::jsonb, name = NULL, phone_e164 = NULL, email = NULL, address = NULL, notes = NULL, filled = NULL WHERE customer_id = <id>;`
3. Consent: `recordConsent(tx, id, { channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "erase_request" })` (a person who asks to be deleted must never get a promotion; no-op if already withdrawn). Then `DELETE FROM contact_consent WHERE customer_id = <id> AND NOT (is_current AND state = 'withdrawn');` and `UPDATE contact_consent SET wording = NULL, note = NULL, confirm_state = 'none' WHERE customer_id = <id>;`. **The "stop" itself is kept on purpose**; say so in the route's comment.
4. Phase B: `UPDATE broadcast_recipient SET state = 'skipped', skip_reason = 'erased' WHERE customer_id = <id> AND state = 'pending';` then `UPDATE broadcast_recipient SET customer_id = NULL, to_wa = NULL, "values" = NULL, error_text = NULL WHERE customer_id = <id>;` (the rows stay so a broadcast's counts stay true; `message_id` clears itself when the messages are deleted).
5. `UPDATE contact_summary SET wa_unreachable_at = NULL WHERE customer_id = <id>;` then `refreshContactSummary(tx, [id])`. Add `contact_labels`, `contact_lists`, `consent_kept_as_stopped: true` to the counts returned and audited.

The customer row stays (existing behaviour), so the person remains a contact with their shop details and is marked stopped.

### 5.7 Routes, Phase A: `apps/api/src/routes/contacts.ts` (new)

`export function contactRoutes(db: DbClient)`. `r.use("*", requireAuth())`. Declare fixed paths (`/labels…`, `/lists…`, `/imports…`, `/settings`, `/export.csv`, `/bulk…`) **before** `/:id`. Audit with `writeAudit(db, c, { …, notify: false })` unless stated. All bodies are zod `.strict()`. `V` = `contacts.view`, `M` = `contacts.manage`.

| Method and path | Cap | Request | Response `data` / behaviour | Audit |
|---|---|---|---|---|
| `GET /` | V | query: `filter` (URL-encoded JSON `ContactFilter`), `sort` (`ContactSort`, default `name`), `limit` (default 50, max 200), `cursor?` | `{ contacts: ContactRow[], next_cursor: string \| null, total: number \| null }`. R1 to R6. `total` is returned only when `cursor` is absent | — |
| `GET /:id` | V | — | `ContactDetail` (below). 404 for a deleted customer; for an alias, 200 with `{ merged_into: <id> }` only | — |
| `POST /` | M | `{ name?, phone?, email?, address?, notes?, customer_source, source_label?, consent?: { wording, collected_on, method_note? } }` | 201 `{ id, created: true }`, or 200 `{ id, created: false, matched_by }` when the person already exists (nothing on the existing contact changes; consent, if given, is recorded). R13, R14 | `contacts.create` |
| `PATCH /:id` | M | any of `{ name: string(1..120), email: string \| null, address: string \| null (max 500), notes: string \| null (max 4000) }` | the updated `ContactDetail`. R10 to R12 | `contacts.update`, with `before` and `after` holding only the changed fields |
| `GET /:id/history` | V | — | `{ consent: ConsentRow[], edits: [{ at, by_name, action, changed: string[] }] }`; edits are `audit_log` rows with `entity_type = 'customer'`, `entity_id = <id>` and action in (`contacts.update`, `contacts.create`, `inbox.contact_update`, `inbox.contact_merge`, `inbox.contact_erase`), newest first, max 100 | — |
| `POST /:id/consent` | M | `{ channel, purpose, state, wording?: string(max 1000), collected_on?: "YYYY-MM-DD", note?: string(max 500) }` | the contact's current consent. `method = "staff"`, `recorded_by` = the user. A `granted` change needs `wording` (422 `Say what the customer agreed to.`). R24 to R26 | `contacts.consent` |
| `PUT /:id/labels` | M | `{ label_ids: uuid[] (max 20) }` | the contact's labels (replaces the set) | `contacts.labels` |
| `GET /labels` | V | — | `[{ id, name, colour, contacts: n }]` | — |
| `POST /labels` | M | `{ name: string(1..40), colour? }` | the label. 409 `A label with that name already exists.` | `contacts.label_create` |
| `PATCH /labels/:id` | M | `{ name?, colour? }` | the label | `contacts.label_update` |
| `DELETE /labels/:id` | M | `{ confirm: true }` | `{ removed_from: n }` | `contacts.label_delete` |
| `POST /bulk/labels` | M | `{ customer_ids: uuid[] (1..500), add?: uuid[], remove?: uuid[] }` | `{ changed: n }` | `contacts.bulk_labels` with counts |
| `GET /lists` | V | `include_archived?` | `[{ id, name, kind, description, count, created_by_name, updated_at, archived_at }]`; `count` is live (R23) | — |
| `POST /lists` | M | `{ name: string(1..80), kind, description?, filter? (smart), customer_ids?: uuid[] (static, max 500) }` | the list. 409 `A list with that name already exists.` 422 when a smart list's filter fails `parseContactFilter(…, { forSmartList: true })` | `contacts.list_create` |
| `GET /lists/:id` | V | — | the list, plus `filter_lines` for a smart list | — |
| `PATCH /lists/:id` | M | `{ name?, description?, filter? (smart only), archived?: boolean }` | the list | `contacts.list_update` |
| `POST /lists/:id/members` | M | `{ customer_ids?: uuid[] (max 500) }` **or** `{ filter: ContactFilter }` (add everyone matching now, max 20,000) | `{ added: n, already: n }`. 409 `kind_smart`: `This list fills itself from its rules. Change the rules instead.` | `contacts.list_add` with counts |
| `DELETE /lists/:id/members` | M | `{ customer_ids: uuid[] (max 500) }` | `{ removed: n }` | `contacts.list_remove` |
| `GET /export.csv` | V + `inbox.export` | `filter` or `list_id` | CSV by `toCsv` (`apps/api/src/lib/csv.ts`). R7 | `contacts.export` with the row count, the filter or list name; **`notify: true`** when rows > 500 |
| `POST /imports` | M | `{ filename: string, csv_text: string (max 2,000,000 characters) }` | 201 `{ id, headers, total_rows, sample: string[][] (first 5), suggested_mapping }`. R15, R16 | `contacts.import_upload` |
| `POST /imports/:id/preview` | M | `{ mapping: ImportMapping, source_label: string(1..80), customer_source, consent_declared, consent_method?, consent_wording?, consent_collected_on?, fill_blanks: boolean, label_id?, list_id? }` | `{ new, matched, rejected, rows: ImportRowView[] (first 200, rejected first), reasons: [{ reason, count }] }`. R17 to R21 | — |
| `GET /imports/:id` | M | `outcome?`, `limit`, `after_row?` | status, counts, progress (`applied_rows`), rows page | — |
| `POST /imports/:id/apply` | M | `{ confirm: true, expect_new: n, expect_matched: n }` | 202 `{ queued: true }`. 409 `changed` when the counts differ from the stored preview: `The preview is out of date. Check it again.` R22 | `contacts.import_apply` with the counts and consent declared; **`notify: true`** |
| `POST /imports/:id/cancel` | M | — | `{ cancelled: true }` (only before `applying`) | `contacts.import_cancel` |
| `GET /settings` | V | — | `ContactSettings` | — |
| `PUT /settings` | M | `ContactSettings` (texts 1..600 characters) | saved to `app_settings` key `contact_settings` (upsert, `updated_by`) | `contacts.settings` |

```ts
ContactRow = { id, name, phone, email, address, address_source: "saved" | "last_delivery" | null, channels: ContactChannel[], handles: string[] /* up to 3, "@name" */,
  source: ContactSource, last_contact_at, orders_count, spent_ngn, last_order_at, labels: { id, name, colour }[], consent: ConsentView, wa_unreachable: boolean, created_at };
ContactDetail = ContactRow & { notes, saved_address: string | null, last_delivery_address: string | null, origin: { origin, source_label, import_filename, created_by_name, created_at } | null,
  identities: IdentityRow[], orders: { count, spent_ngn, first_at, last_at, recent: { id, order_number, created_at, total_ngn, status, channel }[] /* newest 5, every status */ },
  conversations: { id, channel, number_label, status, last_activity_at, labels: string[] }[], conversation_labels: string[],
  lists: { id, name, kind }[], consent_now: { channel, purpose, state, method, recorded_at, recorded_by_name }[], shop_profile_url: string };
ConsentRow = { id, channel, purpose, state, method, wording, note, collected_on, recorded_at, recorded_by_name, is_current };
ImportRowView = { row_no, name, phone, email, address, outcome, reason, matched_name: string | null };
```

`identities` and `conversations` follow the inbox's rule (foundation rule 6): build the viewer with `loadViewer(db, userId, capabilities)`; `conversations` is filtered with `conversationScope(viewer)` and is `[]` for a person without `inbox.view`; `identities` comes from `identitiesFor` (export it from `inbox.ts`), which already hides a Messenger or Instagram identity from staff who may not use that line. The **channel chips** in `ContactRow.channels` are shown to everyone with `contacts.view`. `shop_profile_url` is `<PUBLIC_ADMIN_URL>/owner/customers/<id>`.

### 5.8 Routes, Phase B: `apps/api/src/routes/broadcasts.ts` (new), mounted `/v1/broadcasts`

`S` = `broadcasts.send`, `V` = `contacts.view`, `M` = `contacts.manage`. Fixed paths (`/settings`, `/options`, `/health`) before `/:id`.

| Method and path | Cap | Request | Response `data` / behaviour | Audit |
|---|---|---|---|---|
| `GET /settings` | V | — | `BroadcastSettings` plus `{ limit: { tier, per_day, used_24h, left_today }, quality_rating, mm_status: "ELIGIBLE" \| "ONBOARDED" \| null }` | — |
| `PUT /settings` | S | `BroadcastSettings` | saved to `app_settings` key `broadcast_settings`. Turning `enabled` on needs `{ …, confirm_enable: true }`. `route: "mm"` is refused with 409 unless `mm_status` is `ONBOARDED`: `Meta has not switched on its marketing route for this account yet.` `audience_rule` other than `consent_only` needs `{ confirm_legal: true }` | `broadcasts.settings` with before and after; **`notify: true`** |
| `GET /options` | S | — | `{ lines: [{ id, label, e164, quality_rating }], templates: [{ id, name, language, category, quality_score, body_text, needs: TemplateNeeds, has_stop_wording, usable, why_not }], lists: [{ id, name, kind, count }] }`. Templates: `status = 'APPROVED'` and category `MARKETING` or `UTILITY` for the line's `waba_id`; `usable` and `why_not` per R41, R42 | — |
| `GET /` | V | `status?`, `limit` (50, max 200), `before?` | `[BroadcastRow]`, newest first | — |
| `POST /` | S | `{ name: string(1..80), phone_number_id, list_id, template_id }` | 201 the draft. Sets `blanks` to the defaults (R45) | `broadcasts.create` |
| `GET /:id` | V | — | `BroadcastRow` plus `blanks`, `preview_text`, `test`, `can` (`{ edit, test, confirm, pause, resume, cancel }` for this viewer and status), `events` (newest 50) | — |
| `PATCH /:id` | S | any of `{ name, list_id, template_id, phone_number_id, blanks, scheduled_at: ISO \| null }` | the draft. Only while `draft`; otherwise 409 `This broadcast can no longer be changed.` Any change recomputes `fingerprint` | `broadcasts.update` |
| `POST /:id/header-upload` | S | `{ mime, size_bytes }` | `{ upload_url, media_key }` from `presignInboxPut`; stores `header_media_key`, `header_media_mime`. Refused unless the template needs header media of that kind and the size fits M30 | — |
| `GET /:id/audience` | S | `group?` (`will_send` or a skip reason), `limit` (50), `cursor?` | `{ counts: { list, will_send, skipped: { <reason>: n } }, estimate: { per_day, days, first_day }, people: [{ customer_id, name, phone, reason }], next_cursor }`. R46 to R52. Never writes | — |
| `POST /:id/test` | S | `{ to: string }` | `{ message_id, status }`. R43, R44 | `broadcasts.test` |
| `POST /:id/confirm` | S | `{ confirm_count: n, when: "now" \| "scheduled" }` | `{ status, recipients: n, skipped: n }`. R53. This is the foundation rule 7 click | `broadcasts.confirm` with the count, list, template and time; **`notify: true`** |
| `POST /:id/pause` | S or M | — | `{ status: "paused" }` (from `sending` or `scheduled`) | `broadcasts.pause` |
| `POST /:id/resume` | S | `{ confirm_count: n }` (people still waiting) | `{ status }` (from `paused` or `stopped`; R56) | `broadcasts.resume`; **`notify: true`** |
| `POST /:id/cancel` | S | `{ confirm: true }` | `{ status: "cancelled", not_sent: n }`; waiting recipients become `skipped` / `cancelled` | `broadcasts.cancel` |
| `DELETE /:id` | S | — | only a `draft` | `broadcasts.delete` |
| `GET /:id/results` | V | — | R62 | — |
| `GET /:id/recipients` | V | `state?`, `skip_reason?`, `limit` (50, max 200), `cursor?` | `[{ id, customer_id, name, phone, state, skip_reason, plain_reason, sent_at, delivered_at, read_at, replied_at, opted_out_at, conversation_id \| null }]`; `conversation_id` only when the viewer may see it | — |
| `GET /:id/recipients.csv` | V + `inbox.export` | — | CSV: Name, Phone, Result, Reason, Sent, Delivered, Read, Replied, Asked to stop | `broadcasts.export` with the row count |
| `GET /health` | S | — | reads `getNumberInfo` and `GET /{waba}?fields=marketing_messages_onboarding_status` now; `{ tier, quality_rating, status, mm_status, problems: [{ code, plain }] }`. Never throws | — |

`BroadcastRow` = `{ id, name, status, stop_reason, stop_text, list_name, template_name, template_category, line_label, scheduled_at, started_at, finished_at, confirmed_count, confirmed_by_name, counts: { waiting, sent, delivered, read, replied, failed, unknown, skipped, opted_out } }`.

### 5.9 Domain, Phase B: `packages/domain/src/meta/broadcasts.ts` and `packages/domain/src/contacts/audience.ts`

```ts
// audience.ts
export interface AudienceRow { customerId: string; name: string | null; toWa: string | null; reason: string | null /* null = will send */ }
/** The list's members with the reason each would be skipped, in the order of R47. Pure read. */
export function buildAudience(db: DbExecutor, b: { listId: string; phoneNumberId: string; templateCategory: string; broadcastId: string }, s: BroadcastSettings, now: Date): Promise<AudienceRow[]>;
export function dailyAllowance(db: DbExecutor, lineId: string, s: BroadcastSettings, now: Date): Promise<{ tier: string | null; perDay: number; used24h: number; leftToday: number }>; // R51
// meta/broadcasts.ts
export function classifyBroadcastError(code: string | null, httpStatus?: number): { cls: "recipient" | "temporary" | "stop"; stopReason?: string };
export function uploadWaMedia(cfg: MetaConfig, phoneNumberId: string, file: { bytes: Uint8Array; mime: string; filename: string }): Promise<string>; // POST {id}/media via graphRaw (spec 05)
export function getMmStatus(cfg: MetaConfig, wabaId: string): Promise<"ELIGIBLE" | "ONBOARDED" | null>;   // null on any error
export function confirmBroadcast(db: DbClient, cfg: MetaConfig, id: string, a: { userId: string; confirmCount: number; when: "now" | "scheduled"; headerBytes?: Uint8Array }, now: Date): Promise<{ recipients: number; skipped: number }>;
/** Worker. One tick for one broadcast (section 6). */
export function runBroadcastTick(db: DbClient, cfg: MetaConfig | null, broadcastId: string, now: Date): Promise<"sent" | "waiting" | "stopped" | "done">;
export function checkBroadcastSafety(db: DbExecutor, b: typeof broadcast.$inferSelect, s: BroadcastSettings, now: Date): Promise<{ stop: string; detail: string } | null>; // R55
export function stopBroadcast(db: DbExecutor, id: string, reason: string, detail: string): Promise<void>;            // status, event, owner alert
/** Called from applyStatus in whatsapp-ingest for every status of a known message, and for an unknown one that carries our callback data (R58). */
export function applyBroadcastStatus(db: DbExecutor, a: { messageId: string | null; waMessageId: string; callbackData?: string | null; status: string; at: Date; errorCode?: string | null; errorTitle?: string | null }): Promise<boolean>;
/** Called from ingestMessage for every inbound customer message (R60). */
export function markBroadcastReply(db: DbExecutor, customerId: string, at: Date): Promise<void>;
/** Called from the account_update and business_capability_update branches of ingestWhatsAppPayload (R55). */
export function applyAccountEvent(db: DbExecutor, wabaId: string, field: string, value: Record<string, unknown>): Promise<void>;
```

### 5.10 Changes to existing files, Phase B

- **`packages/domain/src/inbox/meta.ts`.**
  - `OutboundContent` template `headerMedia` becomes `{ type: "image" | "video" | "document"; link?: string; id?: string; filename?: string }` (exactly one of `link`, `id`). `buildTemplateComponents` sends `{ id }` when `id` is set, else `{ link }`.
  - `sendMessage(cfg, phoneNumberId, to, content, opts?: { endpoint?: "messages" | "marketing_messages"; callbackData?: string })`. `buildSendPayload(to, content, callbackData?)` adds `biz_opaque_callback_data: callbackData` when given. Default endpoint `messages`; existing callers are unchanged.
- **`packages/domain/src/inbox/send.ts`** (ruling 9.2.6: this stays the only send function).
  - `SendInput.auto` gains `"broadcast"`; `SendInput.broadcast?: { broadcastId: string; recipientId: string; route: "cloud" | "mm" }`.
  - In the WhatsApp branch, when `input.auto === "broadcast"`: write `payload = { auto: "broadcast", broadcast_id, recipient_id }` on the queued row; call `sendMessage(…, { callbackData: "bc:" + recipientId, endpoint: route === "mm" && tpl.category === "MARKETING" ? "marketing_messages" : "messages" })`; and **skip** the first-reply and claim update, `touchConversation` and both `publishInboxEvent` calls. A broadcast must not move 500 chats to the top of everyone's list or assign them to the owner. The message is in the thread when someone opens it.
- **`packages/domain/src/inbox/whatsapp-ingest.ts`.**
  - `WaStatus` gains `biz_opaque_callback_data?: string`.
  - `applyStatus`: when the message is not known by `wa_message_id` and the status carries callback data starting `bc:`, call `applyBroadcastStatus` with `messageId: null` first (R58); if it returns true, continue as a known message. After every successful status update of a known message, call `applyBroadcastStatus`.
  - `ingestMessage`: after `applyConsentKeyword`, `await markBroadcastReply(db, who.customerId, at)`; and `update contact_summary set wa_unreachable_at = null where customer_id = …`.
  - `ingestWhatsAppPayload`: `if (change.field === "account_update" || change.field === "business_capability_update") { if (entry.id && await wabaIsOurs(db, entry.id)) await applyAccountEvent(db, entry.id, change.field, value as never); continue; }`.
- **`apps/api/src/lib/inbox-alerts.ts`**: add `"broadcast.stopped"` and `"broadcast.finished"` to `alertOnce`'s type list. **`apps/worker/src/outbox.ts`**: section 6.
- **`apps/api/src/test-app.ts`**: `app.route("/v1/broadcasts", broadcastRoutes(db));`.

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts`. New files `apps/worker/src/jobs/contacts.ts` (A) and `apps/worker/src/jobs/broadcasts.ts` (B). Each runs under `withJobLock` like its neighbours.

**Phase A**

| Job | Every | What it does |
|---|---|---|
| `contact_summary_refresh` | 60 s | Read the watermark from `app_settings` key `contact_summary_watermark` (`{ at }`; missing = run `rebuildAllSummaries` once). `refreshChangedSummaries(db, at, now)`, then store `now` |
| `contact_summary_rebuild` | 24 h | `rebuildAllSummaries(db)`: the safety net if a change was missed |
| `contact_consent_confirm` | 10 s | `sendConsentConfirmations` (R29). Returns at once when `metaConfigFromEnv()` is null |
| `contact_import_apply` | 5 s | For the oldest import with `status = 'applying'`: `applyImportBatch(db, id, 200)`; when done set `applied`, `applied_at`. An exception sets `failed` and `error` (rows already applied stay; R22) |
| `contact_import_cleanup` | 24 h | For imports applied, failed or cancelled more than 30 days ago with `rows_purged_at` null: delete their `contact_import_row` rows and set `rows_purged_at`. Counts stay |

**Phase B**

| Job | Every | What it does |
|---|---|---|
| `broadcast_start` | 30 s | `scheduled` broadcasts with `scheduled_at <= now` → `sending`, `started_at`, `warmup_until = null`, event `started`. One line sends one broadcast at a time: a scheduled broadcast is left as `scheduled` while another on the same line is `sending`, and starts on a later tick, oldest `scheduled_at` first. If the owner switch is off: `stopBroadcast(…, "switched_off", …)` instead |
| `broadcast_send` | 5 s | For each `sending` broadcast, oldest first: `runBroadcastTick` |
| `broadcast_sweep` | 60 s | Recipients in `sending` with `claimed_at` older than 5 minutes: if an `inbox_message` exists with `payload->>'recipient_id' = id` and a `wa_message_id`, set `sent`; otherwise set `unknown` (**never back to `pending`**). Broadcasts `sending` with no `pending`, `sending` recipients left → `done`, `finished_at`, event, `broadcast.finished` alert |
| `broadcast_health` | 5 min | Only while a broadcast is `sending`, `scheduled` or `paused`: `getNumberInfo` for its line; store `quality_rating` and `messaging_limit` on `inbox_phone_number` (as the existing settings route does). Errors are logged, not thrown |

**`runBroadcastTick(db, cfg, id, now)`**, in this order:

1. Load the broadcast and `BroadcastSettings`. Not `sending` → return.
2. `checkBroadcastSafety` (R55). A result → `stopBroadcast`, return `stopped`.
3. Not `withinSendingHours(now, s)` → write event `waiting_hours` once per day, return `waiting`.
4. `wait_until > now` or `warmup_until > now` → return `waiting`.
5. `dailyAllowance(...)`; `leftToday <= 0` → event `waiting_limit` once per day, return `waiting`.
6. Take `n = min(ceil(s.rate_per_minute / 12), leftToday)` recipients: `state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now)`, ordered by `created_at, id`, `FOR UPDATE SKIP LOCKED`, and in the same statement set `state = 'sending'`, `claimed_at = now`, `attempts = attempts + 1`. **The claim commits before Meta is called** (foundation rule 9).
7. For each claimed recipient, one after another:
   a. Re-check the person **now** (R54). Not eligible → `skipped` with the reason; next.
   b. Find the thread without disturbing the inbox: the newest `inbox_conversation` for `(customer_id, phone_number_id)`, whatever its status; if there is none, insert one with `status = 'closed'`, `closed_at = now`, `channel = 'whatsapp'`, the line's default team, and the customer's WhatsApp identity if they have one. Never call `findOrOpenConversation` here (it would reopen a closed chat).
   c. `sendFromConversation(db, cfg, { conversationId, userId: null, auto: "broadcast", broadcast: { broadcastId, recipientId, route }, content: { type: "template", name, language, bodyParams: values.body, headerText: values.header, headerMedia: header_media_id ? { type, id: header_media_id } : undefined, buttonParams } }, now)`.
   d. Map the result. Message `sent` → recipient `sent`, `message_id`, `wa_message_id`, `sent_at`; reset `temp_errors` to 0. Message `failed` with `payload.unconfirmed` → recipient **`unknown`** (it may have arrived; never resent; R58). An `InboxSendError` thrown before anything was written (`no_phone`, `template_not_approved`, `template_incomplete`, `template_unsupported`, `no_whatsapp`) → `no_phone` marks the recipient `skipped` / `no_phone`; the others stop the broadcast (`template` or `config`) and put the recipient back to `pending`. Otherwise `classifyBroadcastError(code)`: `recipient` → `failed` with `error_code`, `error_text = plainFailure(code)`, `failed_at` (and for `131026` set `contact_summary.wa_unreachable_at = now`; for `131050` `recordConsent(… withdrawn, method "meta_refusal")`); `temporary` → recipient back to `pending` with `next_attempt_at = now + 10 minutes`, `temp_errors + 1`, `wait_until = now + min(60 s × 2^temp_errors, 15 min)`, stop this tick; a third `temporary` for the same recipient → `failed`; `temp_errors >= 5` → `stopBroadcast(…, "meta_busy", …)`; `stop` → `stopBroadcast` with its reason, recipient stays `failed` with the code, stop this tick.
   e. Wait `60 000 / rate_per_minute` ms before the next recipient, minus the time the send took.
8. **Warm-up:** when the count of recipients ever claimed for this broadcast first reaches 20 and more remain, set `warmup_until = now + 10 minutes`, event `warmup`. The safety check then sees the first results before the rest go.

**Owner alerts** (ruling 9.2.10; add both cases to `format()` in `apps/worker/src/outbox.ts`):

- `broadcast.stopped`, payload `{ account: "<broadcast id>:<reason>", name, reason_text, sent, waiting }`: `` `⛔ *Broadcast stopped*\n“${p["name"]}”: ${p["reason_text"]}\nSent so far: ${p["sent"]}. Still waiting: ${p["waiting"]}. Nothing more goes out until someone presses Resume.\n👉 ${SUITE_URL}/broadcasts/${id}` ``.
- `broadcast.finished`, payload `{ account: "<broadcast id>:finished", name, sent, failed, skipped }`: `` `📣 *Broadcast finished*\n“${p["name"]}”: sent ${p["sent"]}, failed ${p["failed"]}, left out ${p["skipped"]}.\n👉 ${SUITE_URL}/broadcasts/${id}` ``.

Both are raised with `alertOnce`, so each is sent once.

## 7. Screens

### 7.1 Menu and routes

`apps/suite/src/SuiteShell.tsx`: widen `NavItem["to"]` with `"/contacts"` and `"/broadcasts"`. After "Conversations" add `{ heading: "Customers", items: [{ to: "/contacts", label: "Contacts", Icon: Users, cap: "contacts.view" }] }` (Phase A) and add to it `{ to: "/broadcasts", label: "Broadcasts", Icon: Megaphone, cap: "contacts.view" }` (Phase B). Add the same entries, in the same position, to `SUITE_PAGES` in `apps/suite/src/nav.ts` and extend `nav.test.ts`. `apps/suite/src/router.tsx`: routes through `page(node, cap)`, all added to `routeTree`:

| Address | Screen | Cap | Phase |
|---|---|---|---|
| `/contacts` | `ContactsPage` | `contacts.view` | A |
| `/contacts/lists` | `ListsPage` | `contacts.view` | A |
| `/contacts/lists/$listId` | `ListPage` | `contacts.view` | A |
| `/contacts/import` | `ImportPage` | `contacts.manage` | A |
| `/contacts/$customerId` | `ContactPage` | `contacts.view` | A |
| `/broadcasts` | `BroadcastsPage` | `contacts.view` | B |
| `/broadcasts/new` and `/broadcasts/$broadcastId/edit` | `BroadcastEditorPage` | `broadcasts.send` | B |
| `/broadcasts/$broadcastId` | `BroadcastResultsPage` | `contacts.view` | B |

Declare `/contacts/lists`, `/contacts/import` before `/contacts/$customerId`, and `/broadcasts/new` before `/broadcasts/$broadcastId`.

**Files, Phase A** (`apps/suite/src/features/contacts/`): `ContactsPage.tsx`, `ContactFilters.tsx`, `ContactTable.tsx`, `ContactPage.tsx`, `EditContactDialog.tsx`, `AddContactDialog.tsx`, `ConsentDialog.tsx`, `LabelsDialog.tsx`, `AddToListDialog.tsx`, `SaveListDialog.tsx`, `ListsPage.tsx`, `ListPage.tsx`, `ImportPage.tsx`, `ContactSettingsDialog.tsx`, `contacts-api.ts` (calls and `contactKeys`), `contacts-logic.ts`, `contacts-logic.test.ts`, `contacts.css`.

**Files, Phase B** (`apps/suite/src/features/broadcasts/`): `BroadcastsPage.tsx`, `BroadcastEditorPage.tsx`, `BlankFiller.tsx`, `AudiencePanel.tsx`, `TestSendPanel.tsx`, `ConfirmSendDialog.tsx`, `BroadcastResultsPage.tsx`, `BroadcastSettingsDialog.tsx`, `broadcasts-api.ts`, `broadcasts-logic.ts`, `broadcasts-logic.test.ts`, `broadcasts.css`.

Use the suite's existing building blocks (`@admin/components/Modal.js`, `ConfirmModal.js`, `DataState.js`, `toast`). Money is shown with `ngn()`, times in Lagos time with `dayLabel`. Every screen must work at 390 px: tables become cards.

**How this relates to the shop's Customers screens.** The shop admin has `/owner/customers` (customers **who have ordered**: name, phone, orders, lifetime spend, last order; search; its own CSV) and `/owner/customers/$customerId` (the full order history). Contacts does **not** copy those. It lists **every** customer, including people who have only chatted or were added by hand; it adds reach, labels, lists and consent; and for orders it shows only the totals and the latest five, with a link **See all orders in the shop admin** (`shop_profile_url`, new tab). The shop screens are not changed.

### 7.2 Contacts page (`/contacts`)

Title **Contacts**. Sub-line: `Everyone the business knows: shop customers and people who have messaged or called.`

- **No permission:** handled by `Needs`. **Loading:** `DataState` loading. **Error:** `We couldn't load your contacts. Check your connection and try again.` + **Try again**.
- **Header buttons:** **Add contact** (M), **Import** (M, goes to `/contacts/import`), **Lists** (goes to `/contacts/lists`), **Download** (needs `inbox.export`; confirm: `Download <n> contacts as a spreadsheet? The file holds names, phone numbers, emails and addresses. Keep it safe and delete it when you are done.` Buttons **Download** / **Cancel**), and a gear for `ContactSettingsDialog` (M).
- **Search box:** `Search name, phone, email or @name`. Runs 300 ms after typing stops, from 2 characters.
- **Filters** (`ContactFilters.tsx`; a row of chips on desktop, a **Filters** sheet on a phone): **Reaches us by** (WhatsApp, Messenger, Instagram, Phone call), **Has a phone number**, **Has an email**, **Has an address**, **Ordered in the last** (30, 60, 90, 180, 365 days, or a number), **Never ordered**, **Spent at least ₦** (number), **Label**, **Came from** (In the shop, Website, Phone order, WhatsApp, Chowdeck, Added by hand, Imported), **Promotions on WhatsApp** (Agreed, Asked us to stop, Not asked yet), **On list**. **Clear filters**. When any filter is on, a button **Save as a list…** (M).
- **Sort:** `Name (A to Z)`, `Latest order`, `Highest spend`, `Latest contact`, `Newest contact`.
- **Count line:** `<total> contacts` or `<total> contacts match`. Under it, small: `Order totals can be up to a minute behind the shop.`
- **Table columns:** tick-box · **Name** (with labels as small pills, and `Stopped promotions` in red when consent is `stopped`) · **Phone** · **Email** · **Address** (cut to one line; title attribute holds all of it) · **Reaches us by** (icons with text alternatives) · **Orders** (`<n> · ₦<spent>`) · **Last order** · **Last contact**. A missing value shows `—`. A missing name shows `No name` in grey. Tapping a row opens `/contacts/<id>`.
- **Paging:** a **Show more** button loads the next page with `next_cursor`; `Showing <shown> of <total>`.
- **When rows are ticked** (bar at the bottom): `<n> selected` · **Add to list** (M) · **Label** (M) · **Clear**. A header tick-box selects the rows shown. A link `Select all <total> that match` appears when more match than are shown; it sends the **filter**, not IDs, to `POST /lists/:id/members`.
- **Empty, no contacts at all:** `No contacts yet. They appear here when someone orders, messages or calls, or when you add them.` **Empty after filters:** `Nobody matches. Try fewer filters.`

### 7.3 Contact page (`/contacts/$customerId`)

Header: name (or `No name`), phone, **Edit** (M), **Open in shop admin**. If the contact was merged away: `This record was merged into another contact.` + **Open that contact**.

Cards, in this order:

1. **Details.** Name, Phone, Email, Address with its tag (`Saved address` / `From their last delivery`), Notes, `Came from: <source>` and, when there is an origin, `Added by hand by <name> on <date>` or `Imported from “<filename>” (<source_label>) on <date>`.
2. **Promotions and consent.** One line per channel and purpose that has a record, plus always **WhatsApp promotions**: `Agreed on <date> (<how>)`, `Asked us to stop on <date> (<how>)`, or `Not asked yet`. `<how>` by method: `staff` → `recorded by <name>`; `import` → `from an import`; `keyword` → `they replied STOP` / `they replied START`; `whatsapp_setting` → `they changed it in WhatsApp`; `meta_refusal` → `WhatsApp told us`; `erase_request` → `they asked us to delete their history`; `carried_over` → `from an earlier record of the same number`; `merge` → `from a merged contact`. Button **Record consent** (M). Link **History** opens the full list of changes with wording, who and when.
3. **How they reach us.** One row per identity: channel, `@username` or name, last seen. Empty: `They have not messaged or called yet.`
4. **Orders.** `<count> orders · ₦<spent> · first <date> · last <date>`, then the latest five (number, date, total, status). Link **See all orders in the shop admin**. Empty: `No orders yet.`
5. **Conversations.** Each: channel icon, line, status, last activity; opens `/inbox/<id>`. Under it, `Labels on their chats: <conversation labels>` (read only). Without `inbox.view`: `You don't have access to conversations.` Empty: `No conversations you can see.`
6. **Labels and lists.** Label pills with **Change** (M). Lists they are on, each with **Remove** for a static list; a smart list shows `(fills itself)`. **Add to a list** (M).
7. **Changes.** Who edited what, newest first: `<name> changed the email and address · <date>`.

**Edit dialog** (`EditContactDialog.tsx`). Fields **Name**, **Email**, **Address**, **Notes**. Phone is shown but locked, with: `The phone number can't be changed here, because messages and orders are matched by it.` Above the fields: `This changes the customer's record in the shop too.` Errors: `Enter a name.` `That email doesn't look right.` Buttons **Save** / **Cancel**. Toast `Saved.`

**Record consent dialog** (`ConsentDialog.tsx`). **What for:** `Promotions` / `Order and service messages`. **Where:** `WhatsApp`, `SMS`, `Email`, `Phone calls`. **They:** `Agreed` / `Asked us to stop`. When Agreed: **What did they agree to?** (required; placeholder `For example: “Yes, send me offers on WhatsApp” — said at the counter`) and **When?** (date, default today). **Note** (optional). Help text: `Only record a yes the customer really gave. You are named on this record.` When the current state is "asked us to stop" and the person chooses Agreed: `This customer asked us to stop on <date>. Only change this if they have clearly asked to get promotions again.` with a tick-box `They asked to get promotions again` that must be ticked. Buttons **Save** / **Cancel**.

**Labels versus chat labels.** A **contact label** describes the person (`Bulk buyer`, `Events`, `Staff family`) and stays with them. A **chat label** (`inbox_conversation.labels`) describes one conversation (`lead`, `complaint`) and is managed in the inbox. They are separate lists; the contact page shows chat labels read-only and nothing copies between them.

### 7.4 Add contact dialog

Fields **Name**, **Phone**, **Email**, **Address**, **Notes**, **How did they first reach us?** (`In the shop`, `Website`, `Phone call`, `WhatsApp`, `Chowdeck`; default `In the shop`), **Where did you get these details?** (text, required; placeholder `For example: order book, event sign-up sheet`). A tick-box **They agreed to promotions on WhatsApp** reveals the two consent fields of 7.3. Rules: at least a phone or an email. Refusals: `Add a phone number or an email.` `That phone number doesn't look right. Use a number like 0803 123 4567.` `That email doesn't look right.` When the person already exists the dialog closes and a toast says `<Name> is already a contact. Nothing was changed.` and the page opens that contact.

### 7.5 Lists (`/contacts/lists`, `/contacts/lists/$listId`)

**Lists page.** Title **Lists**. Sub-line: `Groups of contacts. Pick them by hand, or save a filter that keeps itself up to date.` Rows: name, kind (`Picked by hand` / `Fills itself`), count, made by, updated. Buttons **New list** (M). Empty: `No lists yet. Tick contacts on the Contacts page and press “Add to list”, or filter and press “Save as a list”.`

**Save as a list dialog** (from the Contacts filters). **Name**. Two choices: `Keep it up to date` (help: `People join and leave the list by themselves as they start or stop matching.`) and `Just the people who match today` (help: `A fixed list. You can add or remove people later.`). It shows the filter in words (`describeContactFilter`), for example `Ordered in the last 60 days · Spent at least ₦20,000 · Has a phone number`, and `<n> people match now.` A search term cannot be saved in an up-to-date list: `Clear the search box first. A list that keeps itself up to date can only use filters.`

**List page.** Header: name, kind, `<count> people`, description. Buttons: **Rename** (M), **Download** (`inbox.export`), **Archive** (M; confirm `Archive “<name>”? It will no longer be offered for broadcasts. Nothing is deleted.`), and in Phase B **Send a broadcast** (`broadcasts.send`). A smart list shows **Rules** with the filter in words and **Change rules** (opens Contacts with the filter loaded and a **Save changes to “<name>”** button). The same table as 7.2 without filters; a static list has **Remove from list** for ticked rows (confirm `Remove <n> people from “<name>”?`).

### 7.6 Import (`/contacts/import`)

A four-step page. Title **Import contacts**.

1. **Choose a file.** `Choose a spreadsheet saved as CSV. The first row must be the column names. Up to 5,000 rows.` The browser reads the file as text and posts it. Refusals: `That file is not a CSV. In Excel or Google Sheets choose “Save as” or “Download” and pick CSV.` `This file has more than 5,000 rows. Split it into smaller files.` `This file is empty.` `We couldn't read this file. Save it again as “CSV UTF-8”.`
2. **Match the columns.** One select per field: **Name**, **First name**, **Last name**, **Phone**, **Email**, **Address**, **Notes**; each lists the file's column names and `Not in this file`; pre-filled from `suggested_mapping`; the first five rows are shown beside it. Must map Phone or Email, else `Choose the column that holds the phone number or the email.`
3. **Say where they came from.** **Where did you get this list?** (required text). **How did these people first reach the business?** (as 7.4). **Did these people agree to get promotions on WhatsApp?** `No, or I'm not sure` (default) / `Yes, every person on this list agreed`. Yes reveals: **How did they agree?** (required), **What were they told?** (required), **When?** (date, required) and the notice `You are stating that every person on this list agreed. Your name is recorded with this import.` Then **For contacts we already have:** tick-box `Fill in details that are missing (name, email, address). Nothing we already hold is changed.` (default off). Optional **Add everyone to a list** and **Give everyone a label**.
4. **Check before saving.** Three tiles: `New contacts <n>`, `Already contacts <n>`, `Rows we can't use <n>`. A table with tabs for each; rejected rows show the reason (R19 wording). Line: `Nothing has been saved yet.` Buttons **Import <new + matched> contacts** / **Back**. Confirm: `Import <n> contacts? <new> will be new. <matched> are already contacts and will not be changed<, except for missing details>.` While running: `Saving… <applied> of <total>.` Done: `Done. <new> new contacts added, <matched> already here.` + **See them** (Contacts filtered to this import's list or label when one was chosen, otherwise sorted Newest). Failed: `The import stopped part-way: <applied> of <total> rows were saved. Nothing was saved twice. Tell Tes.`

### 7.7 Contact settings dialog

Title **STOP and START replies**. Switch **Reply automatically when someone writes STOP or START** (`stop_confirmation`). Two text areas, **Reply to STOP** and **Reply to START**, with the defaults of 5.2. Help: `Customers who write STOP on WhatsApp are taken off promotions straight away, whether or not this reply is on.` Buttons **Save** / **Cancel**.

### 7.8 Broadcasts list (`/broadcasts`) — Phase B

Title **Broadcasts**. Sub-line: `One approved WhatsApp message sent to a list of contacts.`

- **Banner, switch off:** `Broadcasts are switched off. You can prepare and test one, but nothing is sent to customers until the owner switches them on.` + **Broadcast settings** (S).
- **Banner, Meta not ready** (the line has no WhatsApp, or `GET /health` reports a block): `WhatsApp is not ready to send broadcasts: <plain problem>.`
- **Rows:** name, status pill, list, template, `<sent> sent · <delivered> delivered · <read> read · <failed> failed`, date. Status pills: `Draft`, `Scheduled for <time>`, `Sending`, `Paused`, `Stopped`, `Finished`, `Cancelled`.
- **Button** **New broadcast** (S). Without it: nothing is shown in its place. **Empty:** `No broadcasts yet.`
- Refresh every 15 seconds while any row is `Sending`.

`SKIP_REASON_TEXT`: `no_phone` → `No phone number`; `opted_out` → `Asked us to stop promotions`; `not_whatsapp` → `This number is not on WhatsApp (an earlier message could not be delivered)`; `no_consent` → `Has not agreed to promotions on WhatsApp`; `duplicate_number` → `Same phone number as someone else on this list`; `recent` → `Got a broadcast in the last <n> days`; `held_back` → `WhatsApp held back our last promotion to them, so we are leaving them a day`; `erased` → `Asked us to delete their history`; `cancelled` → `The broadcast was cancelled before their turn`.

### 7.9 Broadcast editor (`/broadcasts/new`, `/broadcasts/$id/edit`) — Phase B

One page, five numbered sections; each shows a green tick when complete. The right side (below, on a phone) shows the message as the customer will see it (`TemplatePreview` from `features/templates/`).

1. **Name and number.** **Name** (`For your own records. Customers don't see it.`) and **Send from** (the WhatsApp lines).
2. **Who.** A list picker (name, kind, count). Help: `Make lists on the Contacts page.` Empty: `You have no lists yet.` + **Go to Contacts**.
3. **Message.** Approved templates as cards (name, `Promotion` / `Update`, quality). A template that cannot be used is greyed with its reason (R41, R42): `This template has a part broadcasts can't send yet.` · `This template does not tell people how to stop. Add the footer “Reply STOP to stop these messages” in Templates and send it for approval.` · `WhatsApp has paused this template.` · `WhatsApp rates this template as low quality.` Empty: `No approved promotion templates yet. Write one under Templates and forms.` + link.
4. **Fill the blanks** (`BlankFiller.tsx`). For each blank `{{n}}`: a select `The customer's first name` / `The customer's full name` / `The same words for everyone`. A name choice shows **If we don't know their name, say:** (required, default `there`); the last choice shows a text box. A link button's blank takes fixed text only. A picture heading shows **Choose picture** with the limits (`JPG or PNG, up to 5 MB`). Under it: `<n> people on this list have no name and will get “<fallback>”.`
5. **Check and send.**
   - **Who will get it** (`AudiencePanel.tsx`): a headline `<will_send> of <list> people will get this message.` then one expandable line per reason with its count, for example `38 · Has not agreed to promotions on WhatsApp`, each opening the names (50 at a time). Below: `Your WhatsApp limit lets you start <per_day> new conversations a day. This will take about <days> day(s).` and, always: `WhatsApp decides the final delivery. It may hold back a promotion from someone who has had too many lately.` and `WhatsApp charges for each message delivered. This broadcast is <will_send> messages.`
   - **Send a test first** (`TestSendPanel.tsx`): **Your WhatsApp number** (pre-filled from the staff member's own phone if set) and **Send test**. States: `Sending…`, `Test sent to <number>. Check your phone, then come back.`, `Test delivered.`, `The test did not go: <plain reason>.` If the message changes afterwards: `You changed the message after the test. Send a new test.`
   - **When:** `Send now` / `Send later` with a date and time (Lagos). Refusals: `Pick a time at least 10 minutes from now.` `Pick a time between <send_from> and <send_until>.` `Pick a time in the next 30 days.`
   - Button **Review and send**. It is disabled, with the reason beside it, until every section is complete: `Send a test first.` · `Nobody on this list can be sent this message.` · `Broadcasts are switched off.` · `This would take <days> days at your current WhatsApp limit. Choose a smaller list.` (R52).

**Confirm dialog** (`ConfirmSendDialog.tsx`; foundation rule 7). Title `Send to <n> people?` Body: `“<template name>” will go to <n> people on the list “<list>”, from <line label>, <now | on <date> at <time>>.` Then the filled message for the first person as an example, then: `<skipped> people on the list will not get it.` · `Sending happens between <send_from> and <send_until>, about <rate> a minute, and stops by itself if WhatsApp reports a problem.` · `You can't unsend a WhatsApp message.` A box: **Type the number of people to confirm** (must equal `<n>`). Buttons **Send to <n> people** / **Schedule for <n> people**, and **Cancel**. If the count changed: `The number of people changed from <old> to <new> while you were looking. Check the list again.`

**Broadcast settings dialog** (`BroadcastSettingsDialog.tsx`, S). Switch **Allow broadcasts** (off by default; turning on asks `Switch on broadcasts? Messages will be sent to customers when you, or anyone you have given this permission, confirm a broadcast.`). **Send between** two times (`Lagos time`). **Speed** `<n> messages a minute` (6 to 60). **Leave at least <n> days between broadcasts to the same person**. **Count an order as coming from a broadcast if placed within <n> days**. **Who may be sent promotions:** `Only people who have agreed (recommended)` / `People who have agreed, and customers who ordered in the last <n> months` with, under the second: `Check with a lawyer before choosing this. It sends promotions to people who have not said yes.` and a required tick-box `I have checked this is allowed`. **Use only <n>% of the daily WhatsApp limit** (10 to 100). Read-only lines: `WhatsApp daily limit: <per_day> new conversations (<tier>)`, `Number quality: <High | Medium | Low | Not rated yet>`, `Meta's marketing route: <Not available yet | Available, not switched on | On>` with a switch enabled only when it is `ONBOARDED`.

### 7.10 Broadcast results (`/broadcasts/$broadcastId`) — Phase B

Header: name, status pill, `Confirmed by <name> on <date> for <n> people`, list, template, line. Buttons by `can`: **Pause** (`Pause this broadcast? <waiting> people have not been sent it yet.`), **Resume** (dialog as the confirm dialog, titled `Send to the remaining <n> people?`, with the type-the-number box), **Cancel broadcast** (`Cancel for good? <waiting> people will not get it. People who already got it are not affected.`).

- **Banner, stopped:** red, `Stopped: <STOP_REASON_TEXT>` + `<stop_detail>` + what to do.
- **Banner, waiting:** grey, one of `Waiting for <send_from>. Broadcasts only go out in the daytime.` · `Today's WhatsApp limit is used. It continues tomorrow.` · `Sent the first 20. Checking how they land before sending the rest (about 10 minutes).`
- **Tiles:** `Sent`, `Delivered`, `Read`, `Replied`, `Failed`, `Asked to stop`, `Not confirmed`, `Left out`, each with a share of Sent (Left out: of the list). `Not confirmed` has the help text `We did not hear back from WhatsApp for these. They may have arrived. We do not send again.`
- **Orders afterwards:** `<n> of the people who got this ordered within <days> days: <orders> orders, ₦<total>.` Under it, always: `This shows who ordered after the message, not proof that the message was the reason. Orders at the counter with no name are not counted.`
- **Why some failed:** a table of plain reason and count.
- **People:** the recipients table with a filter by result; a row opens the contact; a chat icon opens the conversation when the viewer may see it. **Download** (`inbox.export`).
- **What happened:** the events, newest first (`Started`, `Paused by <name>`, `Stopped: …`).
- Refresh every 15 seconds while `Sending`.

`STOP_REASON_TEXT`: `switched_off` → `Broadcasts were switched off.`; `quality` → `WhatsApp lowered the quality rating of our number. Too many people blocked or reported us. Do not resume until it recovers.`; `template` → `WhatsApp paused or removed this template.`; `account` → `WhatsApp has restricted the business account. Open WhatsApp Manager to see why.`; `payment` → `WhatsApp could not take payment. Fix the payment method in Meta Business Settings.`; `config` → `Our connection to Meta needs attention. Tell Tes.`; `blanks` → `The blanks did not fit the template. Open the broadcast and check them.`; `failure_spike` → `Too many messages were failing, so we stopped to protect the number.`; `optout_spike` → `Many people asked us to stop after this message.`; `meta_busy` → `WhatsApp kept asking us to slow down.`; `media_expired` → `The picture has expired at WhatsApp. Make a new broadcast.`; `too_long` → `This broadcast ran for 14 days without finishing.`

`plainFailure(code)`: `131026` → `Not on WhatsApp, or their WhatsApp is out of date`; `131049` → `WhatsApp held it back: they have had enough promotions lately`; `131050` → `They have switched off promotions from us in WhatsApp`; `130472` → `WhatsApp left them out as part of its own test`; `131062` → `They hide their number, and WhatsApp can't deliver this kind of message to them`; `132015`, `132016` → `WhatsApp paused the template`; `131042` → `WhatsApp could not take payment`; anything else → `WhatsApp refused it (code <code>)`; null → `It did not go`.

## 8. Rules and edge cases

### Phase A

**The list**

- R1. `GET /` reads `contact_summary s JOIN customer c ON c.id = s.customer_id`. Deleted customers and aliases have no summary row, so they never appear.
- R2. **Key paging.** Order and key per sort: `name` → `(s.name_sort ASC, s.customer_id ASC)`; `last_order` → `(s.last_order_key DESC, s.customer_id DESC)`; `spent` → `(s.spent_ngn DESC, s.customer_id DESC)`; `last_contact` → `(s.last_contact_key DESC, s.customer_id DESC)`; `added` → `(s.created_key DESC, s.customer_id DESC)`. The next page is `WHERE (key, customer_id) > ($k, $id)` (or `<` for descending), a row comparison that uses the matching index of 4.2. The cursor is base64url of `{ s: <sort>, k: <key as text from SQL, e.g. s.last_order_key::text>, id }`; a cursor whose `s` differs from the request's sort is a 400 `Start the list again.` No `OFFSET` anywhere.
- R3. **Search.** `q` trimmed, 2 to 80 characters. With `d` = its digits with a leading `234` or `0` removed: when `d` has 4 or more digits, match `s.phone_digits LIKE '%d%'`; always also match `s.search_text LIKE '%' || lower(q without a leading @) || '%'` (escape `%`, `_`, `\` as `likeTerm` in `inbox.ts` does). Either match counts. This is a scan of a narrow table, measured acceptable to about 100,000 contacts; no extension is added (section 14, Q-A6).
- R4. **Filters** (`contactFilterSql`), all combined with AND: `channels` → `s.channels && $array`; `has_*` → the boolean columns; `ordered_within_days` → `s.last_order_key >= now − N days`; `never_ordered` → `s.orders_count = 0`; `min_spent_ngn` → `s.spent_ngn >= N`; `min_orders` → `s.orders_count >= N`; `last_contact_within_days` → `s.last_contact_key >= now − N days`; `label_ids` → `EXISTS` on `contact_label_member`; `sources` → `c.source::text = ANY(...)` for the five shop values, `manual` / `import` → `EXISTS` on `contact_origin` with that origin; `consent` → `agreed`: a current `whatsapp` / `marketing` row with `granted`; `stopped`: one with `withdrawn`; `not_asked`: none; `list_id` → `EXISTS` on `contact_list_member` (a smart list's ID here is a 422). `never_ordered` together with `ordered_within_days`, `min_spent_ngn > 0` or `min_orders` is a 422 `Those filters can't be used together.`
- R5. `total` is `count(*)` with the same WHERE, only on the first page.
- R6. Labels, handles and consent for the page's rows are fetched in three follow-up queries by `customer_id = ANY(page ids)`, not by joins that multiply rows.
- R7. **Download.** Columns: Name, Phone, Email, Address, Reaches us by, Came from, Orders, Total spent (NGN), Last order, Last contact, Labels, Promotions on WhatsApp. At most 20,000 rows; more is a 422 `That is more than 20,000 contacts. Narrow the filter first.` Cells beginning with `=`, `+`, `-` or `@` are prefixed with `'` so a spreadsheet never runs them as a formula (the phone `+234…` is written as text the same way). Every download is audited with its row count; over 500 rows also alerts the owner.

**Editing**

- R8. **Who may change a customer.** The inbox never changes an existing customer on ingest (foundation D2); that rule stands and nothing in this spec's ingest code breaks it. A **person** with `contacts.manage` may change name, email, address and notes here, each change audited with before and after. The older inbox route (`PATCH /v1/inbox/contacts/:id`, name and notes, `inbox.reply`) stays as it is.
- R9. The phone number is not editable (section 14, Q-A3). Changing it would silently re-point matching for messages and orders.
- R10. `PATCH /:id`: `name` trimmed, 1 to 120; `email` trimmed and lower-cased, null or matching `^[^@\s]+@[^@\s]+\.[^@\s]+$`; `address` writes `customer.default_address` (blank becomes null, which makes the last delivery address show again); `notes` up to 4,000. Sets `updated_at`. A body that changes nothing returns 200 and writes no audit row.
- R11. An alias or a deleted customer cannot be edited (404).
- R12. After any write, `refreshContactSummary` runs in the same transaction.

**Adding by hand**

- R13. `findOrCreateContact`: normalise the phone with `toE164` (`packages/shared/src/inbox.ts`: `0803…`, `803…`, `234…`, `+234…` all become `+234…`; a number that already looks international keeps its own code). A phone given but unusable is a 422. With a phone: `matchCustomerForPhone` (5.5); a match is returned untouched. With no phone but an email: the oldest live customer where `lower(email)` equals it. No match: insert `customer { name, phone: e164, email, default_address, notes, source: customerSource }` and a `contact_origin` row. **No WhatsApp identity is written**: we do not know the number is on WhatsApp.
- R14. **A stop outlives the record.** When a new contact is created with a phone, look for any other customer (deleted or not) whose `phone` has the same digits and holds a current `withdrawn` row for `whatsapp` / `marketing`; if there is one, `recordConsent(new, withdrawn, method "carried_over")`, and ignore any "agreed" declared in the same request.

**Import**

- R15. `POST /imports`: `parseCsv`; refuse (422) no header row, no data rows, more than 5,000 data rows, more than 40 columns, or duplicate header names (`Two columns are both called “<name>”. Rename one.`). Store headers and one `contact_import_row` per data row with `raw`. Rows whose cells are all blank are dropped and not counted.
- R16. Only the person who uploaded an import, or the owner, may preview, apply or cancel it (403 otherwise).
- R17. `suggestMapping`: lower-case each header and strip non-letters; `phone` ← `phone`, `phonenumber`, `mobile`, `tel`, `telephone`, `whatsapp`, `number`; `email` ← `email`, `emailaddress`, `mail`; `name` ← `name`, `fullname`, `customer`, `customername`; `first_name` ← `firstname`, `first`; `last_name` ← `lastname`, `surname`, `last`; `address` ← `address`, `deliveryaddress`, `location`; `notes` ← `notes`, `note`, `comment`, `comments`. First header that matches wins; a header is used once.
- R18. **Preview is a dry run.** For each row build `name` (the Name column, else First + " " + Last, trimmed, cut to 120), `phone_e164`, `email` (R10's rule; an invalid email is dropped with a warning, not a rejection, when the row has a usable phone), `address` (cut to 500), `notes` (cut to 4,000). Then set `outcome` and `reason`. It writes only to `contact_import_row` and `contact_import`; no customer is touched and no lock is held between rows.
- R19. Rejections, first that applies: `no_contact` → `No phone number or email`; `bad_phone` → `The phone number doesn't look right: “<cell>”` (and there is no usable email); `bad_email` → `The email doesn't look right: “<cell>”` (and there is no phone); `duplicate_in_file` → `Same phone number as row <n>` (or `Same email as row <n>` when neither row has a phone); the first such row is kept.
- R20. Otherwise: `matched` when a customer is found by the R13 rule (`customer_id` and `matched_name` set; reason `Already a contact`); else `new`. A new row whose email equals an existing customer's while its phone does not match gets the note `Same email as <name>, different phone number: check for a duplicate` and stays `new`.
- R21. A row whose number carries a kept "stop" (R14, or a current withdrawn row on the matched contact) is flagged `Asked us to stop promotions: consent will not be recorded`.
- R22. **Apply** (worker, batches of 200, one transaction per row so a bad row cannot undo good ones): skip rows with `applied_at`; re-resolve the row with `findOrCreateContact` (so two imports or a webhook at the same moment cannot make a duplicate; the per-number advisory lock is the same one the inbox uses). **New:** insert as R13 with origin `import`. **Matched:** change nothing, unless `fill_blanks` is on, in which case set only those of `name`, `email`, `default_address` that are currently null or blank, record them in `filled`, and never touch `phone`, `notes` or `source`. **Never overwrite a value that exists.** Then, when `consent_declared = 'marketing_whatsapp'` and the row has a phone and the contact has no current `withdrawn` row: `recordConsent(granted, method "import", wording, collectedOn, recordedBy = importer, importId)`. Then add the label and the list membership if chosen. Set `applied_at`, `customer_id`, bump `applied_rows`. Re-running after a crash is safe: every step is skipped or is `ON CONFLICT DO NOTHING`.

**Lists**

- R23. A static list's count is `count(*)` of its members that still have a summary row. A smart list's members are whoever matches `contactFilterSql(filter, now)` at the moment of asking; its count is computed live and is never stored. Archiving hides a list from pickers; nothing is deleted.

**Consent**

- R24. A consent record is one of: channel `whatsapp`, `sms`, `email`, `phone`; purpose `marketing` (promotions) or `service` (order and service messages); state `granted` or `withdrawn`; with how (`method`), the wording the person agreed to, when it was given (`collected_on`), when it was recorded and by whom. History is never edited or deleted, except by erase (5.6).
- R25. `recordConsent`: in one transaction set `is_current = false` on the current row for the pair, insert the new row with `is_current = true`. When the state is unchanged it writes nothing and returns false. It takes `pg_advisory_xact_lock(hashtext('contact-consent:' || customer_id))` first.
- R26. **A stop always wins over a bulk yes.** A `granted` change with method `import` or `carried_over` is refused (returns false) when the current row is `withdrawn`. Only `staff` (with the tick-box of 7.3), `keyword` (START) or `whatsapp_setting` (resume) can lift a stop.
- R27. **STOP and START.** `applyConsentKeyword` acts only on an inbound WhatsApp message of type `text`, `button` or `interactive` whose whole body is one of the words (`consentKeyword`). `"stop"` → `recordConsent(whatsapp, marketing, withdrawn, method "keyword", messageId, confirm: true)`. `"start"` → **only when the current row is `withdrawn`**: `recordConsent(…, granted, method "keyword", wording: "Replied START on WhatsApp", messageId, confirm: true)`; otherwise nothing (a bare "start" from someone who never stopped is an ordinary message, not an agreement). A message that merely contains the word (`please stop calling the driver`) is ordinary. `cancel`, `end` and `quit` are deliberately not stop words: in this shop "cancel" usually means an order.
- R28. STOP withdraws **promotions on WhatsApp only**. Replies to the customer's own messages and order updates continue. It is honoured everywhere a promotion could be sent: the filter `Promotions on WhatsApp`, every Phase B audience (R47) and the re-check at send time (R54). It applies to the **contact**, so it covers every number merged into them.
- R29. **The automatic confirmation** (`sendConsentConfirmations`, worker). Rows with `confirm_state = 'pending'`, oldest first, 20 per tick. For each: mark `sending` and commit; if `stop_confirmation` is off, or the row is older than 10 minutes, or the customer has no conversation on a WhatsApp line with `waWindowOpen(last_inbound_wa_at, now)`, or another confirmation of the same kind was sent to them in the last 24 hours → `skipped`. Otherwise `sendFromConversation(db, cfg, { conversationId: <the conversation of the STOP message>, userId: null, auto: "opt_out" | "opt_in", content: { type: "text", body: stop_text | start_text } })`; `sent` if the message is not `failed`, else `failed`. **Never retried** (a `sending` row found after a crash becomes `skipped`). Because the person has just written, the 24-hour window is open and the reply is a normal free-text service message; it is never sent as a template and never outside the window. This is the one unattended message in Phase A: a direct answer to the customer's own request, inside the window, not public and not a promotion (foundation rule 7 names public posts, profile changes and spending; section 14, Q-A5).
- R30. A second STOP while already stopped changes nothing and sends nothing.
- R31. `applyUserPreference` (M3): only `category === "marketing_messages"`. Find the contact by WhatsApp identity: `external_id = wa_id`, else `external_id = user_id`. None → ignore. `value === "stop"` → `recordConsent(withdrawn, method "whatsapp_setting")`. `value === "resume"` → only when the current row is `withdrawn` **with method `whatsapp_setting` or `meta_refusal`** → `recordConsent(granted, method "whatsapp_setting", wording: "Turned promotions back on in WhatsApp")`. A person who wrote STOP to us stays stopped until they write START or tell staff. No confirmation is sent for either.
- R32. Having no consent record means "not asked". Phase A does not block anything on it; Phase B does (R47).

**Permissions and audit**

- R33. Every route checks its capability on the server; hiding a button is not the check. A person with `contacts.view` and no `inbox.view` sees contacts and no conversation content.
- R34. Audit actions are listed per route in 5.7. Imports applied and downloads over 500 rows also notify the owner.

### Phase B

**Choosing**

- R40. **The owner switch** `broadcast_settings.enabled` is **off by default** (foundation C6). While off: drafts, the audience preview and the test send work; `POST /:id/confirm` and `POST /:id/resume` answer 409 `Broadcasts are switched off. The owner can switch them on in Broadcast settings.`; the worker stops any broadcast it finds `scheduled` or `sending` with reason `switched_off`. Switching it off is therefore an emergency stop for everything.
- R41. A template is usable when: `status = 'APPROVED'`; category `MARKETING` or `UTILITY`; it belongs to the line's `waba_id`; `templateNeeds(components, category).sendable`; its `quality_score` is not `RED`; and `review_info` shows no pause. Header media kind `image` only in this version (video and document: `why_not` `Broadcasts can only carry a picture heading for now.`).
- R42. **A promotion must say how to stop.** A `MARKETING` template is usable only if its body or footer text contains the word `STOP` (any case) or it has a `QUICK_REPLY` button whose text passes `consentKeyword(...) === "stop"`. Meta asks for clear opt-out instructions (M2), and this is what makes R27 reachable.
- R43. **Test send.** `to` must normalise with `toE164`. The route finds or creates the tester's customer with `findOrCreateCustomer(tx, to, { source: "whatsapp" })`, opens the conversation with `findOrOpenConversation`, fills the blanks from that contact, uploads the header picture to Meta if there is one (as R53 step 5, stored on the broadcast), and calls `sendFromConversation` as an ordinary template send by the signed-in user. A failed message answers 422 with the plain reason. On success set `test_to`, `test_message_id`, `test_sent_at`, `test_fingerprint = fingerprint`. A test needs no consent and is not a recipient row. At most 5 tests per broadcast per hour (429 `You've sent several tests. Wait a little.`).
- R44. Confirming needs a test with `test_fingerprint = fingerprint`, `test_sent_at` within 24 hours, and the test message not `failed`. Otherwise 409 `Send a test first.` / `You changed the message after the test. Send a new test.`
- R45. **Blanks.** `firstName(name)`: the first run of letters (Unicode letters, apostrophes and hyphens) in the trimmed name, with its first letter upper-cased; null when the name is empty, starts with `@`, or has no letters. `fillBlanks`: `first_name` → `firstName(name) ?? fallback`; `full_name` → trimmed name (unless it starts with `@`) `?? fallback`; `fixed` → its text. Every value is trimmed, has line breaks and tabs replaced by a space, and is cut to 60 characters. Defaults for a new draft: body blank 1 → `{ from: "first_name", fallback: "there" }`, every other blank → `{ from: "fixed", text: "" }` (which blocks confirming until filled). The number of body blanks must equal `templateNeeds(...).bodyParams`.

**Who gets it**

- R46. The audience is the list's members (`listMembersSql`) at the moment of asking. `GET /:id/audience` never stores anything; `confirm` stores it (R53).
- R47. `buildAudience` gives each member the **first** reason that applies, in this order, or none:
  1. `no_phone`: `whatsappRecipient(<their newest WhatsApp identity>, customer.phone)` is null.
  2. `opted_out`: a current `whatsapp` / `marketing` row is `withdrawn`. Applies to **both** template categories.
  3. `not_whatsapp`: `contact_summary.wa_unreachable_at` is set.
  4. `no_consent` (`MARKETING` only): no current `granted` row for `whatsapp` / `marketing`; under the rule `consent_or_recent_customer`, also allow a contact with `last_order_at` within `recent_customer_months` months. For `UTILITY`: skip with `no_consent` only a contact who has neither an order nor a WhatsApp identity (a stranger).
  5. `duplicate_number`: the same `to_wa` as an earlier member (order by `customer.created_at`, oldest keeps it).
  6. `recent` (`MARKETING` only, when `min_days_between > 0`): they have a `broadcast_recipient` row in another `MARKETING` broadcast with `sent_at` within that many days.
  7. `held_back`: they have a `broadcast_recipient` row with `error_code = '131049'` and `failed_at` within 24 hours (M12).
- R48. Meta gives no way to ask "is this number on WhatsApp?" before sending, so `not_whatsapp` is only ever learned from a failed delivery. The preview says WhatsApp decides the final delivery (7.9).
- R49. Nothing is sent to Messenger or Instagram identities, whatever the list holds (section 12).
- R50. A list with more than 20,000 members cannot be used: `This list is too big for one broadcast. Split it.`
- R51. **The daily allowance.** `perDay = floor(tierToNumber(inbox_phone_number.messaging_limit) × daily_share)` (Infinity → 20,000). `used24h` = distinct customers who were sent a template (`inbox_message.direction = 'out'`, `type = 'template'`, status not `failed`) in the last 24 hours on **any** line of the same `waba_id`, because the limit is shared by the whole business (M6). `leftToday = max(0, perDay − used24h)`. An unknown tier counts as 250.
- R52. `estimate.days = ceil(will_send / perDay)`; more than 14 days refuses confirmation.

**Confirming**

- R53. `POST /:id/confirm`, in this order; each refusal is a 409 with the wording shown:
  1. Status must be `draft` (`This broadcast has already been confirmed.`).
  2. R40 (switch), R41 and R42 (template; `This template can't be used: <why_not>`), the line is active and has `wa_phone_number_id` and `channels <> 'voice'` (`This number has no WhatsApp.`), every blank is filled (`Fill in every blank.`), a header picture is present when needed (`Add the picture.`), R44 (test), `when = "scheduled"` needs a valid `scheduled_at` (7.9).
  3. With `when = "now"`: no other broadcast for the same line has status `sending` (`Another broadcast is already going out from this number. Wait for it to finish, or schedule this one.`). A scheduled broadcast whose time arrives while another is `sending` on its line waits (section 6, `broadcast_start`).
  4. Recompute the audience. `will_send` must be at least 1 and equal `confirm_count`, else `count_changed` with both numbers. R52.
  5. If there is a header picture and `header_media_id` is null or older than 20 days: fetch the file from R2 (`presignInboxGet`, then `fetch`), `uploadWaMedia`, store `header_media_id`, `header_media_uploaded_at`. A failure here refuses the confirm with the plain Meta reason; nothing else has changed.
  6. One transaction: lock the broadcast row; insert one `broadcast_recipient` per audience member (`pending` with `to_wa` and `values = fillBlanks(...)`, or `skipped` with its reason; `ON CONFLICT DO NOTHING`); set `status` (`sending` or `scheduled`), `confirmed_by`, `confirmed_at`, `confirmed_count`, `template_name`, `template_language`, `template_category`, `list_name`, `attribution_days`, `route`, `started_at` (when now); insert event `confirmed`.
  The people are fixed at this moment: a smart list that changes later does not change who gets it.
- R54. **Re-check at send time.** Just before each send the worker re-reads the person: a current `withdrawn` row → `skipped` / `opted_out`; `wa_unreachable_at` set → `skipped` / `not_whatsapp`; the customer deleted or the row's `customer_id` null → `skipped` / `erased`; no recipient number now → `skipped` / `no_phone`. So a STOP that arrives between confirming and that person's turn is honoured.

**Stopping**

- R55. `checkBroadcastSafety` stops the broadcast (status `stopped`, `stop_reason`, event, one owner alert) when any of these is true:
  - `switched_off`: the switch is off.
  - `quality`: the line's `quality_rating` (upper-cased) is `RED`, or its `wa_status` is `FLAGGED` or `RESTRICTED`.
  - `template`: the template's `status` is no longer `APPROVED`, or its `quality_score` is `RED`, or the row is gone.
  - `account`: `app_settings` key `broadcast_account_block` exists for this `waba_id`. `applyAccountEvent` writes it (`{ waba_id, event, detail, at }`) on `account_update` events `ACCOUNT_VIOLATION`, `ACCOUNT_RESTRICTION` (when a `restriction_type` is `RESTRICTED_BIZ_INITIATED_MESSAGING`), `DISABLED_UPDATE`, `ACCOUNT_DELETED`. It is cleared only by a person: `PUT /settings` with `{ clear_account_block: true }` (S, audited). On `business_capability_update` it stores the new limit in `inbox_phone_number.messaging_limit` for every line of that account.
  - `failure_spike`: of the last 50 recipients that reached `sent`, `delivered`, `read` or `failed` (at least 20 must exist), 30% or more are `failed` with a code other than `131026` and `131050`.
  - `optout_spike`: at least 5 recipients have `opted_out_at`, and they are 5% or more of those delivered or read.
  - `media_expired`: there is a header picture and `header_media_uploaded_at` is more than 25 days ago.
  - `too_long`: `started_at` is more than 14 days ago.
  Stops raised from a send result (`payment`, `account`, `template`, `blanks`, `config`, `meta_busy`) go through the same `stopBroadcast`. A configuration stop also raises `inbox.meta_config` with `area: "whatsapp_broadcasts"` (add its branch in `outbox.ts`, linking to `/broadcasts`).
- R56. **The system only ever stops; it never starts or resumes.** `POST /:id/resume` needs `broadcasts.send`, the switch on, the template still usable, and `confirm_count` equal to the number still `pending`. It does not re-send to anyone who is `sent`, `delivered`, `read`, `failed`, `unknown` or `skipped`. It sets `sending`, clears `wait_until`, `temp_errors` and `warmup_until`, and restarts the warm-up count from the people sent after the resume.

**Never twice**

- R57. One recipient row per contact per broadcast (`uq_broadcast_recipient_customer`) and one per phone number (`uq_broadcast_recipient_number`). A row leaves `pending` only by the claim in step 6 of the tick, which commits before Meta is called, and nothing ever moves a row from `sending`, `sent`, `unknown` or `failed` back to `pending`, except a `temporary` refusal where Meta answered and said it did not send (`delivery === "not_sent"`).
- R58. **A timeout is "unknown", not "failed".** When the send call gets no answer, `sendFromConversation` already marks the message failed with `payload.unconfirmed = true` and has no Meta message ID. The recipient becomes `unknown` and is **not** sent again. It is settled by the delivery webhook: every broadcast send carries `biz_opaque_callback_data = "bc:<recipient id>"`, and Meta returns it on that message's statuses (M22). `applyBroadcastStatus` with `messageId: null`: parse the recipient ID; if that recipient is `unknown` or `sending` and has an `inbox_message` (found by `payload->>'recipient_id'`) with no `wa_message_id`, set that message's `wa_message_id` to the status's `id`, clear its error fields and `payload.unconfirmed`, and set its status to `sent`; set the recipient `sent` with `wa_message_id`; return true so the status is then applied normally. If Meta does not return the callback data (M23 is unverified), the recipient simply stays `Not confirmed`: the safe side.
- R59. `applyBroadcastStatus` for a known message: find the recipient by `message_id`. `sent` → `sent` (from `sending` or `unknown`); `delivered` → `delivered` + `delivered_at`; `read` → `read` + `read_at` (and `delivered_at` if empty); `failed` → `failed` + `error_code`, `error_text = plainFailure(code)`, `failed_at`, and the side effects of step 7d for `131026` and `131050`. States only move forward: `pending` < `sending` < `unknown` < `sent` < `delivered` < `read`; `failed` replaces `sending`, `unknown` or `sent` only.

**Results**

- R60. **Replied.** `markBroadcastReply`: on an inbound WhatsApp message from a customer, set `replied_at = at` on their newest recipient row with `sent_at` within the last 7 days and `replied_at` null. The reply itself is an ordinary inbound message: it reopens or opens the conversation, counts as unread and alerts staff exactly as any message does. Nothing is auto-answered except STOP and START (R29).
- R61. **Asked to stop after this message.** When `applyConsentKeyword` or `applyUserPreference` records a withdrawal, set `opted_out_at` on the same row R60 would pick.
- R62. `GET /:id/results` returns `{ counts: { list, waiting, sent, delivered, read, replied, failed, unknown, skipped, opted_out }, failures: [{ code, plain, count }], skipped: [{ reason, plain, count }], orders: { days, people, orders, total_ngn }, events }`. `sent` counts every recipient that reached `sent`, `delivered` or `read`; `delivered` counts `delivered` or `read`. **Order rule:** an order counts when its `customer_id` is the recipient's contact (or an alias of it), its status is not `cancelled` or `failed`, and its `created_at_local` is after the recipient's `sent_at` and within `attribution_days` days of it; if the same order falls inside two broadcasts' windows it counts for the one sent last. **Limits, stated on the screen:** it shows who ordered afterwards, not why; walk-up sales with no customer record are missed; a customer who orders under a different phone number is missed.
- R63. Delivery receipts can arrive late or never (a phone switched off, read receipts turned off). `Read` is therefore a floor, not a count of everyone who read it.

**Routes and pricing**

- R64. `route = "cloud"` sends through `POST /{phone-number-id}/messages`. `route = "mm"` sends `MARKETING` templates through `POST /{phone-number-id}/marketing_messages` with no `product_policy` (so Meta falls back to the Cloud API if the account is not ready) and `UTILITY` templates through `/messages` as before. `mm` may be chosen only when `getMmStatus` is `ONBOARDED`. Statuses arrive on the same webhook for both. **The default is `cloud` until the owner accepts Meta's terms; it must be `mm` before 13 Oct 2027 (M26).**
- R65. Cost: the owner has said cost is not a concern. No screen shows a naira estimate. Every screen that leads to a send shows the **number of messages**.

## 9. Tests

No test calls the real Meta API (rule 3). Integration tests use `setupTestDb`, `seedUser`, `loginAs`, `installGraphStub` as `apps/api/test/integration/inbox-whatsapp.test.ts` does.

### Phase A

**`packages/shared/src/contacts.test.ts`**

- `consentKeyword: STOP, stop., "Stop", UNSUBSCRIBE and opt out are stop; START and resume are start`
- `consentKeyword: a sentence containing stop, and cancel, end, quit, are not keywords`
- `parseCsv reads quoted cells, doubled quotes, commas and line breaks inside quotes`
- `parseCsv strips a byte-order mark and accepts LF or CR LF`
- `suggestMapping maps Phone Number, E-mail, Full Name, Surname and Delivery Address`
- `parseContactFilter refuses a search term and a list in a smart list, and never_ordered with min_spent`
- `describeContactFilter writes each filter as a plain line`
- `firstName: “ada obi” → Ada; “@ada_juice”, “0803…” and empty → null; “mrs. chi-chi” → Mrs`

**`packages/domain/src/contacts/contacts.test.ts`** (database, as `packages/domain/src/inbox/inbox.test.ts`)

- `matchCustomerForPhone and findOrCreateCustomer pick the same customer for 0803…, 803… and +234803…`
- `findOrCreateContact returns an existing customer untouched and creates no identity`
- `findOrCreateContact matches by email only when there is no phone`
- `findOrCreateContact carries a stop over from a deleted customer with the same number`
- `recordConsent keeps one current row per channel and purpose and keeps the history`
- `recordConsent refuses a granted from an import when the current row is withdrawn`
- `refreshContactSummary: counts orders that are not cancelled or failed, and sums total_ngn`
- `refreshContactSummary: address is default_address, else the newest delivery_address_formatted, with the right tag`
- `refreshContactSummary: an alias has no row and its orders count under the kept contact`
- `refreshContactSummary: channels come from identities and calls; a deleted customer loses its row`
- `contactFilterSql: each filter alone, and two together`

**`apps/api/test/integration/contacts.test.ts`**

- `GET /v1/contacts needs contacts.view; a manager sees the list, branch staff get 403`
- `GET /v1/contacts pages by key in every sort order with no row repeated or missed across 3 pages`
- `GET /v1/contacts with a cursor from another sort is refused`
- `search finds a contact by 0803…, by 803…, by +234 803…, by part of an email and by @username`
- `filters: channel, has phone, has email, has address, ordered in the last N days, never ordered, spent at least, label, source, consent, list`
- `GET /v1/contacts/:id returns orders summary, lists, labels and consent; conversations only within the viewer's scope; none without inbox.view`
- `PATCH /v1/contacts/:id changes name, email, address and notes, audits before and after, and refuses phone`
- `PATCH needs contacts.manage`
- `POST /v1/contacts creates a contact with an origin row; the same number again returns the existing contact unchanged`
- `POST /v1/contacts with an unusable phone is refused in plain words`
- `labels: create, rename, delete, set on a contact, bulk add and remove`
- `lists: a static list adds and removes members and counts them; a smart list follows its filter as orders arrive`
- `adding members to a smart list is refused`
- `export.csv needs inbox.export, audits the row count, escapes formula cells, and alerts the owner above 500 rows`
- `import: upload refuses more than 5,000 rows and duplicate column names`
- `import preview: new, matched and rejected rows with reasons; nothing is written to customer`
- `import preview: two rows with the same number, the second is rejected as a duplicate`
- `import apply: creates new contacts, leaves matched contacts unchanged, records origin and declared consent`
- `import apply with fill_blanks fills only empty fields and records what it filled`
- `import apply never records consent for a contact who asked us to stop`
- `import apply twice (worker re-run) creates nothing twice`
- `import apply is refused when the counts no longer match the preview`
- `POST /:id/consent: granted needs wording; lifting a stop is recorded with the staff member's name`

**`apps/api/test/integration/contacts-consent.test.ts`** (posts signed webhooks to `/v1/webhooks/whatsapp`)

- `an inbound "STOP" withdraws marketing consent, keeps the message in the inbox, and queues one confirmation`
- `the confirmation is sent as free text inside the 24-hour window and never twice`
- `no confirmation when the switch is off, and none after 10 minutes`
- `"START" restores consent only for someone who had stopped`
- `"please stop the delivery" changes nothing`
- `a second STOP changes nothing and sends nothing`
- `the after-hours auto-reply is not also sent for a STOP message`
- `a user_preferences stop withdraws consent; a resume lifts only a stop that came from WhatsApp`
- `merging contacts moves labels, lists and consent, a stop on either side wins, and the merged record leaves the list`
- `erasing a contact removes labels, lists, origin and import details, and keeps them marked as stopped`
- `ingest still never modifies an existing customer row` (name, email, address unchanged after STOP, START and an ordinary message)

**`apps/suite/src/features/contacts/contacts-logic.test.ts`**: `consent line wording for each method`; `address tag wording`; `filter chips to ContactFilter and back`; `select-all sends the filter, not IDs`; `import step is blocked until phone or email is mapped`; `rejection reason wording for each code`. **`apps/suite/src/nav.test.ts`**: `a person with only contacts.view lands on /contacts`.

### Phase B

**`packages/shared/src/broadcasts.test.ts`**

- `tierToNumber: TIER_250, TIER_2K, TIER_10K, TIER_100K, TIER_UNLIMITED, 2000, null and nonsense`
- `fillBlanks uses the first name, the fallback when there is none, and trims to 60 characters`
- `withinSendingHours and nextSendingStart at 08:59, 09:00, 18:59 and 19:00 Lagos time`
- `plainFailure and STOP_REASON_TEXT have wording for every code and reason in the spec`

**`packages/domain/src/meta/broadcasts.test.ts`**

- `classifyBroadcastError: 131026/131049/131050 are recipient results; 130429/131056/80007/429 temporary; 131042, 368, 131031, 132015, 132016, 190 stop with the right reason`
- `buildSendPayload adds biz_opaque_callback_data only when given`
- `buildTemplateComponents sends a header picture by id when id is set, by link otherwise`
- `sendMessage posts to marketing_messages only when asked`

**`apps/api/test/integration/broadcasts.test.ts`**

- `every write route needs broadcasts.send; an admin gets 403; contacts.view can read results`
- `confirm is refused while the owner switch is off`
- `options: a marketing template with no STOP wording is not usable, with the reason`
- `audience: each skip reason in turn, in the documented order, with counts`
- `audience under consent_only leaves out a customer with orders but no recorded consent; consent_or_recent_customer includes them`
- `a utility template skips people who asked to stop but not people with no marketing consent`
- `test send goes to the tester's number as a normal template message and records the fingerprint`
- `confirm is refused without a test, after the message changed, and when the count does not match`
- `confirm writes one recipient per contact, skips with reasons, and fixes the audience of a smart list`
- `confirm is refused when the estimate is over 14 days`
- `two contacts with the same number produce one message`
- `pause, resume (with the remaining count) and cancel move the statuses and write events`
- `results: counts by state, failures by plain reason, and orders within the window by the documented rule`
- `an order inside two broadcasts' windows counts for the later one`
- `merge and erase update recipient rows as section 5.6 says`

**`apps/worker/src/jobs/broadcasts.test.ts`** (Graph stub; a fixed clock)

- `a tick sends at most rate/12 messages, each through sendFromConversation with auto broadcast`
- `a recipient is claimed before Meta is called; a crash after the claim leaves it unknown, never pending`
- `running the tick twice at once sends each recipient once` (two concurrent calls)
- `a timeout makes the recipient unknown and it is not sent again`
- `a status webhook carrying bc:<id> settles an unknown recipient as sent, then delivered`
- `delivered and read statuses move the recipient forward only`
- `a failed status with 131049 is a recipient failure and blocks that person for 24 hours in the next audience`
- `131026 marks the contact not on WhatsApp; an inbound message clears it`
- `131050 records a withdrawal with method meta_refusal`
- `a 130429 answer puts the recipient back to waiting, backs off, and the fifth in a row stops the broadcast`
- `131042 stops with payment; 132015 stops with template; 190 stops with config and raises inbox.meta_config`
- `nothing is sent outside sending hours; sending continues at the next start`
- `nothing is sent beyond the daily allowance; templates sent from the inbox in the last 24 hours count against it`
- `after the first 20 the broadcast waits 10 minutes`
- `a RED quality rating, a paused template, an account_update restriction and the switch going off each stop it and raise one owner alert`
- `a failure rate of 30% over the last 50 stops it; 131026 failures do not count`
- `a STOP between confirm and that person's turn skips them`
- `a reply sets replied_at and lands as an unread message in the inbox; a STOP sets opted_out_at`
- `a broadcast send does not assign the conversation, change its preview or move it in the list`
- `a new conversation made for a broadcast is closed, and a reply reopens it`
- `the broadcast finishes when nobody is waiting and raises broadcast.finished once`
- `scheduled broadcasts start at their time, and are stopped instead if the switch is off`

**`apps/suite/src/features/broadcasts/broadcasts-logic.test.ts`**: `review button reason for each missing step`; `audience headline and reason lines`; `the confirm box accepts only the exact number`; `status pill and banner wording for each status and stop reason`.

## 10. Manual check

**Phase A** (no Meta account needed beyond the existing test number)

1. Sign in to the suite as the owner. Contacts is in the menu under "Customers". The list shows every customer, with order totals matching the shop admin's Customers page for three customers you pick.
2. Search a known customer by `0803…`, by `803…`, by `+234 803…` and by part of their email. Each finds them.
3. Filter "Ordered in the last 60 days" and "Spent at least ₦20,000". Sort by Highest spend. Press Show more twice; no row repeats.
4. Open a contact. Edit the address. The Changes card shows your name. Open the same customer in the shop admin: the address changed there too.
5. Add a contact by hand with a new number. Add the same number again: you are told they already exist and nothing changed.
6. Import a CSV of 10 rows: 5 new, 3 existing (one with a different name in the file), 1 with a bad phone, 1 duplicate of another row. Check the three tiles (5, 3, 2) and the reasons. Import. The existing customer's name is unchanged.
7. Tick five contacts → Add to list → new list "Test list". Filter "Never ordered" → Save as a list → Keep it up to date. Place a test order for one member: within two minutes they have left the smart list.
8. Download "Test list" as a file. Open it: phones show as text.
9. From a test phone send `STOP` to the business WhatsApp number. Within 15 seconds the phone gets the confirmation; the contact shows "Asked us to stop (they replied STOP)"; the message is in the inbox as usual. Send `START`: consent returns, with a second confirmation.
10. Sign in as a manager: Contacts is visible, Edit and Import are not. Sign in as branch staff: no Contacts menu.
11. Merge two test contacts in the inbox: the merged one leaves Contacts and its labels and lists are on the kept one. Erase a test contact: they remain, marked stopped, with no labels.
12. Repeat steps 1, 3, 4 and 6 at 390 px.

**Phase B** (needs section 2 done; until Meta unblocks the account, steps B4 onwards can only be done against the stub)

- B1. `GET /me/permissions` shows `whatsapp_business_messaging` and `whatsapp_business_management` (foundation C9). In the App Dashboard the WhatsApp webhook is subscribed to `account_update`, `business_capability_update`, `user_preferences`.
- B2. Broadcasts → Broadcast settings: the daily limit, quality and "Meta's marketing route" lines are filled. Note the route's value in the pull request (this settles M28).
- B3. With the switch off, make a draft, preview the audience and send a test to your own phone. Review and send is refused with "Broadcasts are switched off."
- B4. Switch broadcasts on. Make a list of 5 app-role tester phones: 3 with recorded consent, 1 without, 1 who has replied STOP. The audience shows 3 will get it and the two reasons.
- B5. Send a test, then confirm by typing 3. The three phones receive the message with their first names. Results show sent, then delivered, then read as you open them.
- B6. Reply from one phone: the reply is in the inbox, unread; Results shows 1 replied. Reply STOP from another: Results shows 1 asked to stop, and that contact is marked stopped.
- B7. Make a second broadcast to the same list at once: all three are left out as "Got a broadcast in the last 7 days".
- B8. Schedule a broadcast for tomorrow 20:00: refused. Schedule for tomorrow 10:00: accepted, shows Scheduled; press Pause, then Cancel.
- B9. Start a broadcast to 3 people, press Pause after the first, then Resume (type the remaining number). Nobody gets it twice.
- B10. Switch broadcasts off while one is sending: it stops and the owner gets one Telegram alert.
- B11. Place an order as one recipient; the next day Results shows it under "Orders afterwards".
- B12. Repeat B4, B5 and the results page at 390 px. Record in the pull request what Meta actually returned for M8, M11, M16, M17, M23 and M31.

## 11. Done when

**Phase A**

- [ ] Migration 0082, journal entry and Drizzle schema are in; lint and type-check pass.
- [ ] `contacts.view` and `contacts.manage` exist with the defaults in 5.1 and appear in the admin app's permission editor.
- [ ] `/contacts` lists every live customer with the columns in 7.2, pages by key, and never uses `OFFSET`.
- [ ] Search finds a phone typed three ways.
- [ ] Editing changes only name, email, address and notes, and every edit is audited.
- [ ] Hand-add and import use `matchCustomerForPhone`; a test proves `findOrCreateCustomer` and import pick the same customer.
- [ ] An import never overwrites an existing value (test), shows a dry run first, and records origin and declared consent.
- [ ] STOP and START work from the existing WhatsApp ingest; ingest still never modifies an existing customer row (test).
- [ ] Merge and erase handle every `contact_` table (tests).
- [ ] Downloads need `inbox.export` and are audited.
- [ ] All Phase A tests exist and pass; screens work at 390 px.

**Phase B**

- [ ] Migration 0083, journal entry and schema are in.
- [ ] `broadcasts.send` exists and is the owner's only.
- [ ] The owner switch is off by default and nothing reaches a customer while it is off (test).
- [ ] A broadcast cannot be confirmed without a test send and the typed count.
- [ ] No recipient can be sent the same broadcast twice (concurrency test); a timeout is `unknown` and is settled only by the webhook (test).
- [ ] Every stop in R55 is tested and raises exactly one owner alert.
- [ ] A broadcast send does not disturb the inbox list; replies arrive as normal messages.
- [ ] Results show the counts, plain failure reasons and the order rule with its limits.
- [ ] No token is logged, stored or returned. No test calls Meta.
- [ ] The pull request lists each **[unverified]** fact with what Meta returned, and the Graph version it was checked on (foundation C10).

## 12. Out of scope

- **Broadcasts on Messenger and Instagram.** Meta allows free messages there only inside 24 hours of the customer writing (7 days for a person's manual reply). Promotions outside that are possible only through paid features: Sponsored Messages (not on Instagram) and Marketing Messages on Messenger, which needs its own opt-in and is offered only in countries that do not include Nigeria (M33, M34 verified; M35 for Instagram unverified). Sending promotions with message tags risks the Page. Contacts still shows who is on those channels.
- **SMS and email broadcasts.** No provider is connected for either, and each has its own consent and sender rules. The consent table already has `sms` and `email` so that agreements can be recorded now and used later.
- **Phone-number editing and true record merging** (joining two `customer` rows, with their orders). The shop owns those rows; this spec hides duplicates with `contact_alias` instead.
- Creating templates (spec 06); carousel, video-heading and document-heading templates; per-contact pictures or links; blanks filled from order data.
- A/B tests, automatic re-sends to people who did not open, drip sequences, birthday messages. A re-send is exactly what Meta's per-user limit punishes (M12).
- A naira cost estimate (R65). Meta's Conversions API and click tracking; order attribution is by time only (R62).
- Automatic deletion of contacts after a period (section 14, Q-A7). Syncing contacts to Meta custom audiences for adverts (spec 12's area).
- Consent capture on the storefront checkout (a tick-box "send me offers on WhatsApp"). It is the best source of consent and should be the next small piece of work; it touches `apps/customer`, which these specs do not (Q-B3).

## 13. Work order

**Phase A** (one pull request, or two split after task 8)

1. Permissions `contacts.view`, `contacts.manage` (5.1), admin `GateEditor`, test. Build packages.
2. Migration 0082, journal, `packages/db/src/schema/contact.ts`, index export. Apply on a local database.
3. `packages/shared/src/contacts.ts` (types, `parseContactFilter`, `describeContactFilter`, `consentKeyword`, `parseCsv`, `suggestMapping`, `firstName`, settings) with unit tests.
4. `matchCustomerForPhone` in `core.ts` (5.5); run the existing inbox tests unchanged.
5. `summary.ts` (5.4) and `filter.ts`; domain tests. Worker jobs `contact_summary_refresh` and `contact_summary_rebuild`.
6. Routes: `GET /`, `GET /:id`, `GET /:id/history`; register in `test-app.ts`; tests for paging, search and filters.
7. `PATCH /:id`, `POST /` with `findOrCreateContact`; labels routes; tests.
8. Lists routes and `export.csv`; tests.
9. `consent.ts`; `POST /:id/consent`; the two hooks in `whatsapp-ingest.ts`; `SendInput.auto` widening; the `auto-reply.ts` skip; worker job `contact_consent_confirm`; settings routes; `contacts-consent.test.ts`.
10. Import: routes, `previewImport`, `applyImportBatch`, worker jobs `contact_import_apply` and `contact_import_cleanup`; tests.
11. Merge and erase changes in `inbox.ts` (5.6, steps for `contact_` tables only); tests.
12. Suite: nav, `SUITE_PAGES`, routes; `ContactsPage`, filters, table, `ContactPage`, the dialogs; logic tests; check at 390 px.
13. Suite: `ListsPage`, `ListPage`, `SaveListDialog`, `AddToListDialog`; `ImportPage`; `ContactSettingsDialog`.
14. Manual check, Phase A. Pull request, stating the journal `when` and `idx` used (ruling 9.2.1).

**Phase B** (a separate pull request, after Phase A is merged)

15. Permission `broadcasts.send`; migration 0083, journal, schema.
16. `packages/shared/src/broadcasts.ts` with unit tests.
17. `meta.ts` changes (`headerMedia.id`, `sendMessage` options, callback data) and `send.ts` (`auto: "broadcast"`); unit tests; run every existing send test unchanged.
18. `audience.ts` (`buildAudience`, `dailyAllowance`); `meta/broadcasts.ts` (`classifyBroadcastError`, `uploadWaMedia`, `getMmStatus`); tests.
19. Routes: settings, options, health, CRUD, header upload, audience, test send; tests.
20. `confirmBroadcast` and the confirm, pause, resume, cancel routes; tests.
21. Worker: `runBroadcastTick`, `checkBroadcastSafety`, `stopBroadcast`; jobs `broadcast_start`, `broadcast_send`, `broadcast_sweep`, `broadcast_health`; alerts and their `outbox.ts` cases; worker tests including the concurrency test.
22. Ingest hooks: `applyBroadcastStatus`, `markBroadcastReply`, `applyAccountEvent`, `wa_unreachable_at`; tests.
23. Results route, recipients list and CSV; merge and erase steps for `broadcast_recipient`; tests.
24. Suite: `BroadcastsPage`, `BroadcastEditorPage` and its panels, `ConfirmSendDialog`, `BroadcastSettingsDialog`, `BroadcastResultsPage`; logic tests; 390 px.
25. Manual check, Phase B, as far as Meta allows; record every [unverified] fact in the pull request.

## 14. Open questions

**Phase A**

| # | Question | Recommended default (use this unless told otherwise) |
|---|---|---|
| Q-A1 | Should managers be able to build lists and edit contacts, or only look? | Look only (`contacts.view`). The owner can grant `contacts.manage` to a named manager in the admin app |
| Q-A2 | The address: the saved one or the latest delivery? | Saved address first, latest delivery as the fallback, always tagged (4.1). Editing here writes the saved one |
| Q-A3 | Should staff be able to change a phone number here? | No. Matching for messages and orders hangs on it. Add the right number as a new contact and merge |
| Q-A4 | What should a bare "START" from someone who never stopped mean? | Nothing (R27). Meta wants an opt-in to name the business and say what is being agreed to (M2); a one-word message does neither |
| Q-A5 | Is the automatic STOP confirmation allowed under foundation rule 7 with no owner switch? | Yes, on by default, with a switch in Contact settings. It answers the customer's own message inside the window and is not a promotion. If Tes rules otherwise, default `stop_confirmation` to false; the opt-out itself is unaffected |
| Q-A6 | Search scans `contact_summary`. Add the `pg_trgm` extension for an indexed search? | Not now: extensions need database rights the migrations have not used before. Revisit above 100,000 contacts |
| Q-A7 | How long are contact details kept? | No automatic deletion in this version; erase on request. The owner should set a period with legal advice **[legal check]** |
| Q-A8 | `customer_source` has no value for "imported" or "added by hand", and ruling 9.2.7 forbids adding one | The person chooses one of the five shop values; `contact_origin` records the truth and the "Came from" filter reads both |
| Q-A9 | The foundation's D9 menu table and section 6 reservations do not list spec 14 | This spec adds the "Customers" menu group, migrations 0082 and 0083 and the prefixes `contact_` and `broadcast_`, as instructed. The foundation should be updated in the same pull request that merges this spec |

**Phase B: the owner must decide these before broadcasts are used**

| # | Decision | Recommended default |
|---|---|---|
| Q-B1 | Switch broadcasts on at all, and who besides the owner may send | Off until the owner switches it on. Nobody else gets `broadcasts.send` at first |
| Q-B2 | **Existing customers who never said yes to promotions.** May they be sent promotions? | No: `consent_only`. The other rule exists but needs the owner's own legal check **[legal check]**, and it risks blocks and reports, which lower the number's quality (M14) |
| Q-B3 | How will consent be collected from now on? | Three ways, all recordable in Phase A: staff ask at the counter or on the phone and record it; a tick-box on the website checkout (separate small job, section 12); customers reply START to an invitation. Meta wants the wording to name the business (M2) |
| Q-B4 | Sending hours, speed and the gap between broadcasts to the same person | 09:00 to 19:00 Lagos time, 20 a minute, 7 days |
| Q-B5 | Accept Meta's terms for the Marketing Messages route? | Yes, when the real account is live, then set `route` to `mm`. It becomes compulsory on 13 Oct 2027 (M26). Until then `cloud` works |
| Q-B6 | How many days after a broadcast should an order be counted? | 7 |
| Q-B7 | The first real broadcast | Send to a list of at most 50 people who clearly agreed, watch the quality rating for two days, then grow. The account starts at 250 new people a day (M6) |
| Q-B8 | M23 (`biz_opaque_callback_data` on the send request) is unverified | Build it as written. If Meta rejects the field with code 100, send without it for that broadcast and leave timeouts as "Not confirmed"; say so in the pull request |
| Q-B9 | M31 (a header picture by media ID in a template) is unverified, and the worker cannot make short-lived R2 links (only the API can) | Build as written. If Meta refuses the ID form, the fallback is to move `presignInboxGet` into a package the worker can import; raise it with Tes rather than storing a signed link |
| Q-B10 | Should a system stop be lifted automatically when the quality rating recovers? | No. The system only stops (R56); a person decides to resume |

---

## Built differently — Phase A

Departures made while building Phase A on `work/olu/suite-14-contacts` (stacked on `work/olu/suite-06-templates`, 19 Nov 2026). Work-order task 14 (the manual check at desktop and 390 px, and the pull request) was not done: no browser and no WhatsApp account were available. Phase B is not built. Journal entry used: `idx` 74, `when` 1787300000000 (ruling 9.2.1: check both at merge time).

1. **Where the database tests live.** The domain package has no database test set-up, so the tests section 9 lists for `packages/domain/src/contacts/contacts.test.ts` are in `apps/api/test/integration/contacts-domain.test.ts`. The file in `packages/domain` holds the pure tests (the filter as SQL text and parameters). The worker jobs have their own `apps/worker/src/jobs/contacts.test.ts`.
2. **No `match.ts`.** `matchCustomerForPhone` is exported from `packages/domain/src/inbox/core.ts`, as 5.5 says. `findOrCreateCustomer` calls the same private helper, so its queries and their order are unchanged.
3. **`recordConsent` is stricter than R26.** A `granted` is refused over a current `withdrawn` for every method except `staff`, `keyword` and `whatsapp_setting` (the spec names only `import` and `carried_over`). `ConsentChange` also takes `recordedAt`: a STOP or START is recorded at the time of the customer's own message, so the 10-minute rule of R29 counts from when they wrote, not from when a replayed webhook was processed.
4. **A stop follows the contact.** `resolveContactId` follows `contact_alias`, and `applyConsentKeyword`, `applyUserPreference`, `findOrCreateContact` and `isStoppedOnWhatsApp` use it, so a STOP that reaches a merged-away record still stops the kept contact (R28).
5. **A repeat STOP** records and sends nothing (R30) but `applyConsentKeyword` still returns `"stop"`, so the message is marked and the out-of-hours reply is not sent either. The out-of-hours reply is skipped for a STOP or START even when the confirmation switch is off, exactly as 5.5 says; a customer who writes STOP at night with the switch off therefore gets no automatic message at all.
6. **One confirmation of a kind per customer per 24 hours** counts any earlier automatic message of that kind, whatever became of it (sent, failed or unconfirmed). A confirmation Meta refuses is `failed`; one refused before Meta was asked (window closed, line has no WhatsApp) is `skipped`. Neither is retried.
7. **Lifting a stop needs a tick on the server too.** `POST /:id/consent` takes `asked_again: true`; without it a `granted` over a `withdrawn` answers 409. `POST /` (hand-add) never lifts a stop, records consent only when a phone was given, and answers with `consent_recorded` and `stopped`. It writes `contacts.create` only when a contact was really created.
8. **Merge response unchanged.** `moved_labels`, `moved_lists` and `alias: true` are written to the audit row but **not** added to the response, because an existing test (`inbox-identities.test.ts`) asserts the exact response body and existing expectations were not to change. The merge and erase steps live in `apps/api/src/lib/contacts-merge-erase.ts`, called from the two routes in `inbox.ts`.
9. **`findOrCreateContact`** also returns `carriedStop`, and throws `ContactInputError` (`bad_phone`, `bad_email`, `no_contact`) with the screen's wording.
10. **Import reasons** are stored on `contact_import_row.reason` as `<code>` or `<code>:<detail>`, one per line, and turned into the R19 wording by `importReasonText` in `@ms/shared`. `duplicate_in_file` is two codes (`duplicate_phone`, `duplicate_email`); kept rows may carry the notes `matched`, `same_email`, `email_dropped`, `phone_dropped`, `stopped`. `ImportRowView` gains `reason_code`; the preview's `reasons` gain `text`.
11. **Import, filling blanks.** Each fill is written to `audit_log` as `contacts.import_fill` (before and after, in the importer's name), since the worker has no request to hang `writeAudit` on. When an import finishes, `new_count` and `matched_count` become what really happened, and each row's `outcome` is updated when it is applied.
12. **Route details.** `ContactRow.source` is the origin (`manual`, `import`) when there is one, else `customer.source`. `ContactDetail` gains `can_see_conversations`. `GET /export.csv` takes `list_id` for either kind of list; a smart list's ID inside a `filter` is a 422 (R4). `GET /imports/:id` also follows R16. A name, address or notes that is too long, a blank name and a bad email are 422 with a plain sentence; an unknown key (such as `phone`) is the API's usual 400. Addresses are `/v1/contacts` (no trailing slash).
13. **Owner notifications** for a download over 500 rows and for an applied import use `writeAudit(..., notify: true)` as 5.7 says, with entity type `contacts` and a plain `name` so the Telegram line reads sensibly. No new `outbox_event` type was added, so `inbox-alerts.ts` and `outbox.ts` are unchanged.
14. **Drizzle.** `@ms/db` does not depend on `@ms/shared`, so the jsonb columns are typed loosely there and narrowed with `parseContactFilter` where they are read.
15. **Worker.** `contact_summary_rebuild` also runs when the worker starts (as well as every 24 hours). `refreshChangedSummaries` also refreshes both sides of a new alias.
16. **CSV guard.** `csvSafeCell` also guards a cell that starts with a tab or a carriage return.
17. **Screens.** "Change rules" and "See them" open Contacts through the address (`?rules=<list>`, `?list=`, `?label=`, `?sort=added`). The **Label** button works on up to 500 ticked rows (not on "select all that match"). Labels are made and deleted in the Labels dialog; renaming a label has a route but no screen. The Lists page has "Show archived lists" and an archived list has "Bring back". Every browser write is one `fetch` with no retry. "Send a broadcast" (Phase B) is not on the list page.
18. **Preview speed.** Each row's match runs in its own short transaction (it must take the per-number lock `matchCustomerForPhone` takes). A row whose number is new falls to the same full scan of `customer.phone` that the inbox uses on a miss, so a 5,000-row file of new numbers against a very large customer table will make the preview slow. Not measured on production-sized data.
