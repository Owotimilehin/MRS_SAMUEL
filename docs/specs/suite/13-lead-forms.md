# Suite build specs — 13: Lead forms from adverts

Read `00-foundation.md` first. Size M, suggested model Sonnet. Migration `0081_leads.sql`. Permission `leads.view`. Meta facts checked on 19 Nov 2026.

Words used here: a **lead form** (Meta calls it an "instant form") is the short form that opens inside Facebook or Instagram when someone taps a lead advert. A **lead** is one person's filled-in form.

---

## 1. Outcome

When this is finished, shop staff can say:

- "When someone fills in our form on Facebook or Instagram, they appear on the Leads page within a couple of minutes, with their answers, and I get the same sound and pop-up as for a new message."
- "If they gave a phone number, they are a contact in the suite (the same contact as in the shop if we already knew them) and there is a conversation I can open."
- "I can send them our approved WhatsApp follow-up with one button, if the form's wording allows it."
- "Each lead has a status (New, Contacted, Won, Lost) and an owner. I can filter by form, status and person."
- "I can see how many leads each form and advert brought, how fast we answered, and how many we won."
- "When we first connect, I can pull in the leads from the last 90 days so nobody is forgotten."

## 2. Depends on

**Specs.** 01 (`pageAccessToken`, `listChannelAccounts`, `channels.manage`, the Page stored as a channel account with `kind = 'messenger'`) and 02 (the webhook `POST/GET /v1/webhooks/meta`, which stores events in `inbox_webhook_event` with `source = 'meta'` and `kind = 'page.leadgen'`, and the worker retry for them).

**Things a person must do in Meta first.** UI labels are **[unverified]**; Meta renames screens often.

1. **Subscribe the app to the field.** App Dashboard → Webhooks → object **Page** → subscribe to **leadgen** **[verified: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/, 19 Nov 2026]**.
2. **Give the system user the right to advertise on the Page.** Business Settings → Accounts → Pages → "Mrs Samuel fruit juice" → People → system user `NEWUSERSYSTEM` → turn on the advert and leads tasks ("Create ads", "Leads"). Meta requires "A Page access token from a person who can perform the ADVERTISE task on the Page" **[verified: same page]**. Today the Page is assigned with messaging rights only (foundation section 4), which is not enough.
3. **Leads access.** Business Settings → Integrations → **Leads Access** → choose the Page. If access has never been customised, nothing is needed: "If the Page admin did not customize leads and has not granted access permission with the Leads Access Manager, then all Page admins will have leads access permission" **[verified: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/, 19 Nov 2026]**. If it has been customised, add the system user under **People** and the app "Mrs Samuel fruit juice" under **CRMs**, then Save. This setting is the usual reason leads cannot be read.
4. **Put the Meta app in Live mode** (App Dashboard, top bar). "You can't retrieve leads if your app is in Development mode" and the testing tool cannot be used in development mode **[verified: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/ and https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/testing-troubleshooting, 19 Nov 2026]**. See section 14, Q1: this is different from every other spec.
5. **Create at least one lead form** on the Page (Meta Business Suite → All tools → Instant Forms → Create form). Add the consent tick-box in rule R18.
6. **Create the `lead_followup` template** (R20) in WhatsApp Manager or through spec 06, then Settings → Templates → Sync.
7. In the suite: Leads → Forms → **Check connection**, then **Refresh forms**.

## 3. Meta reference

"RET" below means `https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/`.

| Fact | Status |
|---|---|
| Webhook: object `page`, `entry[] = { id, time, changes[] }`, each change `{ field: "leadgen", value: { leadgen_id, page_id, form_id, adgroup_id, ad_id, created_time } }`. One entry can hold several changes. Notifications arrive "with a delay of up to a few minutes" | [verified: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/ and RET, 19 Nov 2026] |
| The Page must have the app installed: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` with a Page access token returns `{ "success": "true" }`; `GET /{page-id}/subscribed_apps` lists installed apps | [verified: same webhooks page, 19 Nov 2026] |
| Posting `subscribed_fields` **replaces** the Page's list for this app (so spec 02's fields must be sent again with `leadgen`) | [unverified]; R2 is written to be safe either way |
| Permissions for webhooks: `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `ads_management` | [verified: same webhooks page, 19 Nov 2026] |
| Permissions to read all lead and advert data: `ads_management`, `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`. "The `leads_retrieval` permission is required to read leads." | [verified: RET, 19 Nov 2026] |
| App review: "You must include the `leads_retrieval` and `pages_manage_ads` permissions in your submission." | [verified: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/, 19 Nov 2026] |
| Read one lead: `GET /{leadgen-id}` returns `created_time`, `id`, `ad_id`, `form_id`, `field_data: [{ name, values: [] }]`. Example names: `full_name`, `email` | [verified: RET, 19 Nov 2026] |
| Tick-box answers are separate: `fields=custom_disclaimer_responses` returns `[{ checkbox_key, is_checked }]` | [verified: RET, 19 Nov 2026] |
| `campaign_id` is readable on a lead (named with `ad_id` as an "ad-specific field") | [verified: RET, 19 Nov 2026] |
| Further lead fields `ad_name`, `adset_id`, `adset_name`, `campaign_name`, `is_organic`, `platform` | [unverified] (the reference page returned "not found" on 19 Nov 2026); fetched in a second, optional call (R6) |
| The `field_data[].name` of a standard question is `full_name`, `first_name`, `last_name`, `email`, `phone_number`; for a custom question it is the question's `key` | `full_name`, `email` [verified: RET, 19 Nov 2026]; the rest [unverified] |
| List a Page's forms: `GET /{page-id}/leadgen_forms?fields=name,id` with a Page access token. Permissions `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list` | [verified: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/create, 19 Nov 2026] |
| Read a form's questions: `GET /{form-id}?fields=questions`. A question has `type`, `key`, `label`, `options: [{ value, key }]`. Types: `FULL_NAME`, `FIRST_NAME`, `LAST_NAME`, `EMAIL`, `PHONE`, `CUSTOM`, `DATE_TIME`, `STORE_LOOKUP` and national-ID types. Forms have a `status` that can be set to `ACTIVE` or `ARCHIVED` | [verified: same page, 19 Nov 2026] |
| Form fields `status`, `locale`, `created_time`, `privacy_policy_url`, and `legal_content` holding `custom_disclaimer.checkboxes: [{ key, text, is_required }]` are readable | [unverified]; read in a second, optional call (R4) |
| Bulk read: `GET /{form-id}/leads?fields=created_time,id,ad_id,form_id,field_data` returns `data[]` and `paging.cursors.after`. Filter: `filtering=[{"field":"time_created","operator":"GREATER_THAN","value":<unix seconds>}]`; operators `LESS_THAN`, `GREATER_THAN`, `GREATER_THAN_OR_EQUAL` | [verified: RET, 19 Nov 2026] |
| Rate limit per Page per 24 hours: "200 multiplied by 24 then multiplied by the number of leads created in the past 90 days" | [verified: RET, 19 Nov 2026] |
| Error `80005`: too many lead calls to this Page, wait and retry. Also 100 invalid parameter, 190 bad token, 200 permissions | [verified: https://developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/, 19 Nov 2026] |
| A lead that cannot be read for lack of access fails with code 100 and a message naming `pages_manage_ads` or `leads_retrieval` | [unverified] (seen only on third-party sites) |
| Meta keeps a lead's answers for 90 days after it is submitted; older leads cannot be downloaded or read | [unverified] (stated by many third-party guides quoting Meta's help centre; Meta's developer pages mention 90 days only in the rate limit) |
| Lead Ads Testing Tool: `https://developers.facebook.com/tools/lead-ads-testing`. Choose Page and form, **Create lead**, **Track status** (shows whether our webhook answered), **Delete lead**. One test lead per form; delete it to make another. Test leads are organic (no advert). "you cannot use the tool in developer mode" | [verified: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/testing-troubleshooting, 19 Nov 2026] |
| Test leads by API: `POST /{form-id}/test_leads` (Page token, Advertiser role or above, no existing test lead), `GET /{form-id}/test_leads`, `DELETE /{lead-id}` | [verified: same page, 19 Nov 2026] |
| WhatsApp: outside the 24-hour window "you can only send pre-approved template messages" | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages.md, 19 Nov 2026] |
| Meta will class `lead_followup` as a Marketing template, which is charged per message | [unverified] |

**Errors (D10 plus this spec).** Temporary: D10's list and `80005`. Configuration: `190`, `10`, `200`, `299`, and `100` when the message contains `permission`, `leads_retrieval` or `pages_manage_ads`. Gone (do not retry): `100` with any other message on `GET /{leadgen-id}` (the lead was deleted or is too old). Everything else: refusal.

**App review items.** Submit `leads_retrieval`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`, `pages_manage_metadata`, `ads_management` for advanced access. Screencast: (1) a person fills in the form from the advert preview or the testing tool; (2) the lead appears on the suite's Leads page with the answers; (3) a staff member opens it, changes the status and sends the follow-up; (4) show the Page being chosen under Channels (spec 01) so the reviewer sees which Page the data belongs to. State in the notes that the data is used only by the business that owns the Page, to contact the person who asked.

## 4. Data

### 4.1 Migration `packages/db/migrations/0081_leads.sql`

```sql
-- Leads from Meta lead forms (spec 13). Additive only: two new lead_* tables.
-- No existing table is altered.
-- Undo: DROP TABLE "lead", "lead_form" (in that order). Nothing else depends on them.

CREATE TABLE IF NOT EXISTS "lead_form" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "form_id" text NOT NULL UNIQUE,
  "page_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text,
  "locale" text,
  "questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "privacy_policy_url" text,
  "disclaimers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "whatsapp_consent_key" text,
  "consent_covers_whatsapp" boolean DEFAULT false NOT NULL,
  "phone_number_id" uuid REFERENCES "inbox_phone_number"("id"),
  "is_enabled" boolean DEFAULT true NOT NULL,
  "backfill_requested_at" timestamptz,
  "backfill_cursor" text,
  "backfill_done_at" timestamptz,
  "backfill_count" integer DEFAULT 0 NOT NULL,
  "synced_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "leadgen_id" text NOT NULL UNIQUE,
  "form_id" text NOT NULL,
  "page_id" text,
  "ad_id" text,
  "ad_name" text,
  "adset_id" text,
  "adset_name" text,
  "campaign_id" text,
  "campaign_name" text,
  "platform" text,
  "is_organic" boolean,
  "is_backfill" boolean DEFAULT false NOT NULL,
  "meta_created_at" timestamptz,
  "fetch_state" text DEFAULT 'pending' NOT NULL CHECK ("fetch_state" IN ('pending','fetched','failed','gone')),
  "fetch_attempts" integer DEFAULT 0 NOT NULL,
  "next_fetch_at" timestamptz DEFAULT now() NOT NULL,
  "fetch_error_code" text,
  "fetch_error" text,
  "answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "full_name" text,
  "phone_raw" text,
  "phone_e164" text,
  "email" text,
  "consent" jsonb,
  "whatsapp_consent" boolean DEFAULT false NOT NULL,
  "customer_id" uuid REFERENCES "customer"("id"),
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'new' NOT NULL CHECK ("status" IN ('new','contacted','won','lost')),
  "lost_reason" text CHECK ("lost_reason" IN ('not_interested','no_answer','wrong_number','duplicate','test','other')),
  "assignee_id" uuid REFERENCES "admin_user"("id"),
  "note" text,
  "followup_sent_at" timestamptz,
  "first_contacted_at" timestamptz,
  "closed_at" timestamptz,
  "erased_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_status_created" ON "lead" ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_form_created" ON "lead" ("form_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_customer" ON "lead" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_fetch" ON "lead" ("fetch_state","next_fetch_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_assignee" ON "lead" ("assignee_id");
```

Journal entry for `packages/db/migrations/meta/_journal.json`: `{ "idx": 80, "version": "7", "when": 1787200000000, "tag": "0081_leads", "breakpoints": true }` (0070 is `1786100000000`; add `100000000` per migration number). Drizzle's migrator runs a file only when its `when` is later than the newest migration already applied, so this value must be the largest on `master` at merge time; if a lower-numbered suite migration is merged later, its `when` must be raised above this one (section 14, Q7).

`lead.form_id` is Meta's form ID (text), not a foreign key, so a lead can be stored before its form is known. `conversation_id` is `ON DELETE SET NULL` because the inbox's erase and merge routes delete conversations.

### 4.2 Column notes

- `lead_form.questions`: `[{ key, label, type, options?: [{ key, value }] }]` as Meta returns it. `disclaimers`: `[{ key, text, is_required }]`, empty when Meta did not return them.
- `lead_form.phone_number_id`: the WhatsApp line used to contact this form's leads. Null = the default line (R11).
- `lead_form.whatsapp_consent_key` and `consent_covers_whatsapp`: the consent rule (R18).
- `lead.answers`: `[{ key, label, values: string[] }]`, in the form's question order, labels taken from the form at the time.
- `lead.consent`: `{ form_name, privacy_policy_url, disclaimers: [{ key, text, is_checked }], captured_at }`: the wording the person saw and what they ticked.
- `lead.fetch_state`: `pending` (we know the ID only), `fetched`, `failed` (configuration problem or out of retries; a person can retry), `gone` (Meta no longer has it).

### 4.3 Drizzle

Add `packages/db/src/schema/lead.ts` exporting `leadForm` and `lead`, mirroring the SQL (camelCase: `formId`, `pageId`, `whatsappConsentKey`, `consentCoversWhatsapp`, `phoneNumberId`, `isEnabled`, `backfillRequestedAt`, `leadgenId`, `metaCreatedAt`, `fetchState`, `nextFetchAt`, `phoneE164`, `whatsappConsent`, `customerId`, `conversationId`, `assigneeId`, `followupSentAt`, `firstContactedAt`, …). Type the jsonb columns with exported interfaces `LeadQuestion`, `LeadDisclaimer`, `LeadAnswer`, `LeadConsent`. Export from `packages/db/src/schema/index.ts`.

## 5. Server

### 5.1 Permission

In `packages/shared/src/permissions.ts` add `"leads.view"` to `CAPABILITIES` (comment: `// Leads from Meta lead forms: see, work and report on them (spec 13).`), to `ADMIN_CAPS` and to `MANAGER_CAPS`. `leads.view` lets a person see every lead, change status, owner and note, and see the report. Form set-up needs `channels.manage` (spec 01). Sending the follow-up also needs `inbox.templates`.

### 5.2 Domain: `packages/domain/src/meta/leads.ts` (new; re-export from `packages/domain/src/index.ts`)

```ts
export interface LeadgenChange { leadgen_id?: string; page_id?: string; form_id?: string; adgroup_id?: string; ad_id?: string; created_time?: number }

/** Called from spec 02's webhook processing for every change with field "leadgen". No Meta call. Idempotent. */
export function ingestLeadgenChange(db: DbExecutor, value: LeadgenChange): Promise<{ created: boolean }>;

export interface MetaLead { id: string; created_time?: string; ad_id?: string; form_id?: string; campaign_id?: string;
  field_data?: { name: string; values: string[] }[]; custom_disclaimer_responses?: { checkbox_key: string; is_checked: boolean | string }[] }
export function fetchLead(cfg: MetaConfig, pageToken: string, leadgenId: string): Promise<MetaLead>;
export function fetchLeadExtras(cfg: MetaConfig, pageToken: string, leadgenId: string):
  Promise<{ ad_name?: string; adset_id?: string; adset_name?: string; campaign_name?: string; is_organic?: boolean; platform?: string }>; // never throws; {} on any error
export function listForms(cfg: MetaConfig, pageToken: string, pageId: string): Promise<{ id: string; name: string }[]>;
export function fetchForm(cfg: MetaConfig, pageToken: string, formId: string):
  Promise<{ id: string; name: string; questions: LeadQuestion[]; status?: string; locale?: string; privacy_policy_url?: string; disclaimers: LeadDisclaimer[] }>;
export function listFormLeads(cfg: MetaConfig, pageToken: string, formId: string, o: { sinceUnix: number; after?: string }):
  Promise<{ leads: MetaLead[]; after: string | null }>;
export function getPageSubscription(cfg: MetaConfig, pageToken: string, pageId: string): Promise<string[]>;          // subscribed_fields for our app
export function ensureLeadgenSubscribed(cfg: MetaConfig, pageToken: string, pageId: string): Promise<{ changed: boolean; fields: string[] }>;

/** Pure. Turn Meta's field_data into answers and contact details, using the form's questions. */
export function mapLeadAnswers(fieldData: { name: string; values: string[] }[], questions: LeadQuestion[]):
  { answers: LeadAnswer[]; fullName: string | null; phoneRaw: string | null; phoneE164: string | null; email: string | null };
/** Pure. */
export function buildConsent(form: { name: string; privacyPolicyUrl: string | null; disclaimers: LeadDisclaimer[]; whatsappConsentKey: string | null; consentCoversWhatsapp: boolean },
  responses: { checkbox_key: string; is_checked: boolean | string }[], now: Date): { consent: LeadConsent; whatsappConsent: boolean };
/** Pure. The text shown in the conversation timeline. */
export function leadTimelineBody(formName: string, platform: string | null, a: { fullName: string | null; phoneRaw: string | null; email: string | null; answers: LeadAnswer[] }): string;
export function classifyLeadError(err: unknown): "config" | "temporary" | "gone" | "refusal";

/** Worker: fetch one pending lead and finish it (R5 to R14). */
export function processLead(db: DbClient, cfg: MetaConfig, leadId: string): Promise<"fetched" | "retry" | "failed" | "gone">;
/** Create or find the conversation for a fetched lead. Runs inside a transaction. Returns null when the lead has no usable phone or there is no WhatsApp line. */
export function linkLeadConversation(db: DbExecutor, leadId: string, o: { announce: boolean }): Promise<string | null>;
```

Graph calls, all with the Page token (`graph(cfg, method, path, body, { token: pageToken })`, D7): `fetchLead` → `GET {leadgenId}?fields=id,created_time,ad_id,form_id,campaign_id,field_data,custom_disclaimer_responses`; `fetchLeadExtras` → `GET {leadgenId}?fields=ad_name,adset_id,adset_name,campaign_name,is_organic,platform`; `listForms` → `GET {pageId}/leadgen_forms?fields=id,name&limit=100`, following `paging.next`, at most 20 pages; `fetchForm` → `GET {formId}?fields=id,name,questions`, then a second call `GET {formId}?fields=status,locale,privacy_policy_url,legal_content` whose failure is ignored; `listFormLeads` → `GET {formId}/leads?fields=id,created_time,ad_id,form_id,campaign_id,field_data,custom_disclaimer_responses&limit=100&filtering=<JSON, URL-encoded>&after=<cursor>`; `getPageSubscription` → `GET {pageId}/subscribed_apps`; `ensureLeadgenSubscribed` → R2.

### 5.3 Changes to existing files

- `packages/domain/src/inbox/core.ts`, `findOrCreateCustomer`: widen `opts` to `{ name?: string | null; email?: string | null; source: "whatsapp" | "phone" | "online" }` and pass `email: opts.email ?? null` in the **insert only**. Existing rows are still never modified. (`customer_source` has no value for adverts and enum types must not be changed, rule 2; leads use `online`, and the `lead` row records the true origin.)
- **Spec 02's webhook processing.** Wherever spec 02 walks `payload.entry[].changes[]` for `object === "page"` (in the route's processing function and therefore in the worker retry, which must call the same function), add: `if (change.field === "leadgen") { await ingestLeadgenChange(tx, change.value as LeadgenChange); continue; }`. Walk **every** entry and change; do not trust the stored `kind`, which is taken from the first change only. If spec 02 dispatches by `kind` instead, register the same call for `page.leadgen` and loop over all changes inside it.
- `apps/api/src/routes/inbox.ts`:
  - erase route (`POST /contacts/:customerId/erase`), inside its transaction: `UPDATE lead SET answers = '[]', full_name = null, phone_raw = null, phone_e164 = null, email = null, consent = null, note = null, erased_at = now(), updated_at = now() WHERE customer_id = <id>`. The row stays so counts in reports stay true.
  - merge route (`POST /contacts/:customerId/merge`), inside its transaction: `UPDATE lead SET customer_id = <intoId> WHERE customer_id = <fromId>`; and in the `if (clash)` branch, before the conversation is deleted, `UPDATE lead SET conversation_id = <clash.id> WHERE conversation_id = <conv.id>`.
  - export `withViewer`, `need`, `visibleConversation` (add `export`; spec 08 asks for the same).

### 5.4 Routes: `apps/api/src/routes/leads.ts` (new)

`export function leadRoutes(db: DbClient)`; register in `apps/api/src/test-app.ts` as `app.route("/v1/leads", leadRoutes(db));` beside the inbox routes. `r.use("*", requireAuth())`, then `r.use("*", withViewer(db))`. Declare the fixed paths (`/forms…`, `/report`, `/health`, `/retry-failed`, `/export.csv`) **before** `/:id`. Audit with `writeAudit(db, c, { …, notify: false })`.

| Method and path | Capability | Request | Response `data` / behaviour | Audit |
|---|---|---|---|---|
| `GET /` | `leads.view` | query: `status?` (one of the four, or `open` = new + contacted), `form_id?`, `assignee?` (`me`, `none`, or a user id), `customer_id?`, `q?` (matches name, phone, email; `ilike`), `from?`, `to?` (`YYYY-MM-DD`, Lagos days), `include_tests?` (default false: hides `lost_reason = 'test'`), `limit` (default 50, max 200), `before?` (ISO time of the last row seen) | `{ leads: [LeadRow], counts: { new, contacted, won, lost }, problems: { pending: n, failed: n } }` newest first by `coalesce(meta_created_at, created_at)`. Rows with `fetch_state` other than `fetched` are not listed, only counted | — |
| `GET /:id` | `leads.view` | — | `LeadRow` plus `answers`, `consent`, `note`, `can_open_conversation` (the conversation exists and `canSeeConversation` allows this viewer), `can_follow_up` and `follow_up_blocked_reason` (R19) | — |
| `PATCH /:id` | `leads.view` | any of `{ status, lost_reason, assignee_id: uuid \| null, note: string (max 2000) }` | the updated `LeadRow`. Rules R15 to R17 | `lead.update` with before and after |
| `POST /:id/conversation` | `leads.view` and `inbox.view` | — | `{ conversation_id }`. Calls `linkLeadConversation(tx, id, { announce: false })`; 409 `no_phone` (`This lead has no phone number we can message.`) or `no_line` (`No WhatsApp number is set up.`). The viewer must be allowed to use the line (`canUseNumber`), else 403 | `lead.open_conversation` |
| `POST /:id/follow-up` | `leads.view` and `inbox.templates` | `{ again?: boolean }` | `{ message_id, status }`. R19 and R20 | `lead.follow_up` |
| `GET /forms` | `leads.view` | — | `[{ id, form_id, name, status, is_enabled, questions_count, disclaimers, whatsapp_consent_key, consent_covers_whatsapp, phone_number_id, leads_total, leads_30d, backfill: { requested_at, done_at, count }, synced_at }]` | — |
| `POST /forms/sync` | `channels.manage` | — | `{ forms: n }`. For each Page account: `listForms`, upsert `lead_form` by `form_id`, `fetchForm` for new forms and forms synced more than 24 hours ago | `lead_form.sync` |
| `PATCH /forms/:id` | `channels.manage` | any of `{ is_enabled, whatsapp_consent_key: string \| null, consent_covers_whatsapp, phone_number_id: uuid \| null }` | the form. `whatsapp_consent_key` must be one of the form's disclaimer keys, else 422 | `lead_form.update` |
| `POST /forms/:id/backfill` | `channels.manage` | `{ confirm: true }` | `{ queued: true }` (202). Sets `backfill_requested_at = now()`, `backfill_cursor = null`, `backfill_done_at = null`, `backfill_count = 0`. 409 `backfill_running` if one is in progress | `lead_form.backfill` |
| `GET /health` | `channels.manage` | — | `{ page: { id, name } \| null, token_ok, subscribed, can_list_forms, problems: [{ code, plain }] }`: runs `pageAccessToken`, `getPageSubscription`, `listForms`. Never throws; each failure becomes a problem line (7.4) | — |
| `POST /health/subscribe` | `channels.manage` | `{ confirm: true }` | `{ subscribed: true, fields }`. Calls `ensureLeadgenSubscribed` (R2) | `lead.subscribe_page` |
| `POST /retry-failed` | `channels.manage` | — | `{ requeued: n }`. `UPDATE lead SET fetch_state = 'pending', fetch_attempts = 0, next_fetch_at = now() WHERE fetch_state = 'failed'` | `lead.retry_failed` |
| `GET /report` | `leads.view` | `from?`, `to?` (Lagos days; default the last 30 days) | R23 | — |
| `GET /export.csv` | `leads.view` and `inbox.export` | same filters as `GET /` | CSV (use `toCsv` from `apps/api/src/lib/csv.ts`): columns Received, Name, Phone, Email, Form, Advert, Campaign, Status, Lost reason, Owner, First contacted | `lead.export` with the row count |

`LeadRow` = `{ id, received_at, full_name, phone, email, form_id, form_name, ad_name, campaign_name, platform, is_organic, is_backfill, status, lost_reason, assignee: null | { id, name }, customer_id, conversation_id: string | null /* null unless the viewer can see it */, whatsapp_consent, followup_sent_at, first_contacted_at }`.

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts`; new file `apps/worker/src/jobs/leads.ts`. Every job returns at once when `metaConfigFromEnv()` is null.

| Job name | Every | What it does |
|---|---|---|
| `lead_fetch` | 15 s | Up to 10 leads with `fetch_state = 'pending'` and `next_fetch_at <= now()`, oldest first; `processLead` for each. Stops the tick on the first `temporary` error |
| `lead_backfill` | 60 s | One page (100 leads) for one form that has `backfill_requested_at` set and `backfill_done_at` null (R21) |
| `lead_forms_sync` | 6 h | The same work as `POST /forms/sync` |

`processLead(db, cfg, leadId)`:

1. Load the lead; return if not `pending`. Get `pageToken = await pageAccessToken(cfg, lead.page_id ?? <first active Page account's externalId>)`.
2. `fetchLead`. On error, `classifyLeadError`: `temporary` → `fetch_attempts + 1`, `next_fetch_at = now() + min(30 s × 2^attempts, 1 h)`; after 8 attempts → `failed`; return `retry`. `config` → `failed` with code and message, raise the owner alert (below), return `failed`. `gone` → `gone`, return. `refusal` → `failed`.
3. Make sure the form is known: if there is no `lead_form` row for `form_id`, or its `questions` is empty, `fetchForm` and upsert it (`page_id` from the lead). A failure here does not stop the lead: continue with `questions = []` and the name `Lead form`.
4. `fetchLeadExtras` (best effort).
5. `mapLeadAnswers`, `buildConsent`.
6. One transaction: lock the lead row `FOR UPDATE`; if it is no longer `pending`, stop. Write `answers`, contact fields, `consent`, `whatsapp_consent`, advert fields, `meta_created_at`, `fetch_state = 'fetched'`. Resolve the customer (R9, R10). If `is_backfill` is false and the form `is_enabled`: `linkLeadConversation(tx, id, { announce: true })` (R11 to R13).

**Owner alert.** On a `config` error insert `outbox_event` `{ eventType: "lead.fetch_blocked", payload: { code, message } }` unless one exists from the last 24 hours (copy `alertUnknownNumbers` in `apps/api/src/routes/webhooks-whatsapp.ts`). Add to `format()` in `apps/worker/src/outbox.ts`: `case "lead.fetch_blocked": return { chatIds: [owner], text: \`📋 *Leads cannot be read*\nMeta refused (${p["code"]}): ${p["message"]}\nCheck Leads Access in Business Settings.\n👉 ${ADMIN_URL.replace("admin.", "suite.")}/leads\` };`.

## 7. Screens

### 7.1 Menu and route

`apps/suite/src/SuiteShell.tsx`: widen `NavItem["to"]` with `"/leads"`; add `{ heading: "Marketing", items: [{ to: "/leads", label: "Leads", Icon: ClipboardList, cap: "leads.view" }] }` after "Conversations" (and after spec 08's "Selling" if present). `apps/suite/src/router.tsx`: `const LeadsPage = lazyNamed<{ leadId?: string }>(() => import("./features/leads/LeadsPage.js"), "LeadsPage");`, routes `/leads` and `/leads/$leadId`, both through `page(...)`, both added to `routeTree`.

Files in `apps/suite/src/features/leads/`: `LeadsPage.tsx`, `LeadDrawer.tsx`, `LeadFormsDialog.tsx`, `LeadsReport.tsx`, `leads-api.ts` (calls and `leadKeys`), `leads-logic.ts`, `leads-logic.test.ts`. Shared inbox addition: `apps/admin/src/components/inbox/LeadCard.tsx`.

### 7.2 Leads page (`/leads`)

Title **Leads**. Sub-line: `People who filled in a form on one of our Facebook or Instagram adverts.`

- **No permission:** `You don't have access to leads. Ask the owner.` **Loading:** `DataState` loading. **Error:** `We couldn't load the leads. Check your connection and try again.` + **Try again**.
- **Tabs with counts:** `New`, `Contacted`, `Won`, `Lost`, `All`. Filters: **Form** (All forms…), **Owner** (Anyone, Me, No one, each staff member), date range, search `Search name, phone or email`, tick-box `Show test leads`.
- **Banners:** `problems.failed > 0` → red: `<n> leads arrived but Meta would not let us read them. This is usually the “Leads Access” setting in Meta Business Settings.` + **How to fix** (opens the Forms dialog on its connection section) + **Try again** (with `channels.manage`). `problems.pending > 0` and oldest older than 10 minutes → amber: `<n> new leads are still being fetched from Meta.`
- **Row** (card at 390 px): name (or `No name given`), phone, form name, `from <advert name>` (or `Not from an advert` when `is_organic`), received time (Lagos, `dayLabel`), status chip, owner initials, and a small `Earlier lead` tag when `is_backfill`. Tapping opens the drawer at `/leads/<id>`.
- **Buttons:** **Forms** (opens `LeadFormsDialog`), **Report**, **Download** (with `inbox.export`).
- **Empty, no forms yet:** `No lead forms found yet. Create a form for your Page in Meta, then press Forms → Refresh forms.` **Empty, forms but no leads:** `No leads yet. When someone fills in a form you'll see them here and hear the new-message sound.` **Empty after filters:** `Nothing matches these filters.`
- Refresh the list when the inbox stream delivers `message.created` (a new lead announces itself that way, R12), and every 60 seconds.

### 7.3 Lead drawer (`LeadDrawer.tsx`)

- Header: name, status chip, received time, `Form: <name>`, `Advert: <ad name> · <campaign name>` or `Not from an advert`.
- **Their answers:** each `label` with its value(s). Erased lead: `This person asked us to delete their details.`
- **Contact:** phone, email. If the shop already knew this customer under another name: `Already a customer: <customer name>. The form says “<full_name>”.`
- **What they agreed to:** each disclaimer text with `Ticked` or `Not ticked`; the privacy link. No wording available: `We could not read the form's wording from Meta. Open the form in Meta to see it.`
- **Status** buttons `New` `Contacted` `Won` `Lost`. Choosing Lost asks **Why?**: `Not interested`, `No answer`, `Wrong number`, `Already a lead`, `Test lead`, `Other`.
- **Owner** picker (staff list from `GET /v1/inbox/staff`), with `No one`.
- **Note** (textarea, saved on blur; toast `Saved`).
- **Actions:**
  - **Open conversation** → `POST /:id/conversation`, then go to `/inbox/<conversation_id>`. Hidden without `inbox.view`.
  - **Send WhatsApp follow-up** → confirm dialog (rule 7): title `Send the follow-up on WhatsApp?`, body `<Name> will receive this message on <phone> from <line label>:` then the rendered template text, then `WhatsApp may charge for this message.`, buttons **Send** / **Cancel**. Success toast `Follow-up sent.` Already sent: the button reads `Send again` and the dialog starts `You already sent this on <date>.`
  - Disabled reasons shown under the button (from `follow_up_blocked_reason`): `no_phone` → `No phone number was given.`; `no_consent` → `This form did not ask permission to message on WhatsApp. Call or email instead, or ask the owner to update the form's settings.`; `no_template` → `The “lead_followup” template is not approved yet. See Templates.`; `no_line` → `No WhatsApp number is set up.`; `no_permission` → `You need permission to send templates.`

### 7.4 Forms dialog (`LeadFormsDialog.tsx`)

Title `Lead forms`. Without `channels.manage` the dialog is read-only and shows `Only people who manage channels can change these settings.`

- **Connection** section, from `GET /health`, with **Check connection**. Lines: `Page: <name>` / `No Facebook Page is connected. Connect one under Channels.`; `Meta is sending us new leads: Yes` / `No` + **Turn on** (confirm `Ask Meta to send this Page's new leads to the suite?`); `We can read this Page's forms: Yes` / `No`. Problem lines by code: 190 → `Our connection to Meta has expired. Tell the owner.`; 10, 200, 299 or 100-with-permission → `Meta says we are not allowed to read leads for this Page. In Meta Business Settings open Integrations → Leads Access, choose the Page, and add the suite's system user and app. Also check the system user can create adverts for the Page.`; 80005 → `Meta is busy. Try again in a few minutes.`; other → `Meta refused: “<message>” (code <code>).`
- **Refresh forms** button (toast `Found <n> forms.`).
- One card per form: name, Meta status (`Active` / `Archived`), `<leads_30d> leads in the last 30 days`. Controls:
  - Switch **Bring this form's leads into the suite** (`is_enabled`). Off text: `Leads from this form are saved but no conversation is opened and nobody is alerted.`
  - **WhatsApp number to use** (the WhatsApp lines; first option `Default`).
  - **Permission to message on WhatsApp**: a select listing the form's tick-boxes by their text, plus `None of these`. Help: `Choose the tick-box where the person agrees to be contacted on WhatsApp. Leads who ticked it can be sent the follow-up.` Below it a tick-box **This form's own wording already says we will contact them on WhatsApp** (`consent_covers_whatsapp`), help `Only tick this if the form says so in its introduction or privacy text.`
  - **Fetch earlier leads**: confirm `Bring in leads from the last 90 days for “<name>”? They will be marked “Earlier lead”. Nobody is alerted and no messages are sent.` While running: `Fetching… <count> so far.` Done: `Fetched <count> earlier leads on <date>.`
- Empty: `No forms yet. Create one for your Page in Meta Business Suite (All tools → Instant Forms), then press Refresh forms.`

### 7.5 Report (`LeadsReport.tsx`, opened from the page)

Date range (default last 30 days). Tiles: `Leads`, `Contacted`, `Won`, `Lost`, `Win rate`, `Typical time to first contact`. A table **By form** and a table **By advert** (columns Leads, Contacted, Won, Lost, Win rate). A bar per day (plain CSS bars; no chart library). Footnote: `Test leads are left out. Advert spend is on the Ads page.` Empty: `No leads in these dates.`

### 7.6 In the inbox (`apps/admin/src/components/inbox/LeadCard.tsx`)

In `ContactPanel.tsx`, when the viewer has `leads.view`, call `GET /v1/leads?customer_id=<id>&include_tests=true&limit=3`. For each: `Lead form: <form name>` · received date · status chip · the first three answers · link **Open lead** (`/leads/<id>` in the suite; in the admin app link to the suite's address from the host seam `app-frame.tsx`). Nothing is shown when there are none. The announcing message (R12) appears in the timeline as a normal incoming bubble with a clipboard icon; if `Timeline.tsx` switches on `type`, add `lead` to the plain-text case.

## 8. Rules and edge cases

**Arrival**

- R1. `ingestLeadgenChange` inserts `lead (leadgen_id, form_id, page_id, ad_id, meta_created_at, fetch_state 'pending')` with `ON CONFLICT (leadgen_id) DO NOTHING`. It ignores a change with no `leadgen_id` or no `form_id`. It makes no Meta call, so the webhook answers fast and can be processed twice safely (rule 5).
- R2. `ensureLeadgenSubscribed`: read the current `subscribed_fields` for our app; if `leadgen` is there, do nothing; otherwise POST the **union** of the current fields and `leadgen` as a comma-separated `subscribed_fields`. This never drops spec 02's fields, whichever way Meta treats the list.
- R3. A lead for a form with `is_enabled = false` is still fetched and stored (so reports and a later switch-on work), but no conversation is opened and nobody is alerted.
- R4. A form's wording is re-read at most once every 24 hours. The lead stores its own copy of the wording (`consent`), so later edits to the form do not change what an old lead agreed to.

**Reading**

- R5. Leads are fetched by the worker, never in the webhook request.
- R6. The second call for advert names (`fetchLeadExtras`) may fail completely without affecting the lead.
- R7. `mapLeadAnswers`: for each question of the form, in order, find the `field_data` entry whose `name` equals the question's `key` (fall back to the lower-cased `type`: `full_name`, `first_name`, `last_name`, `email`, `phone_number` for `PHONE`). `fullName` = the `FULL_NAME` answer, else `FIRST_NAME + " " + LAST_NAME`, trimmed, cut to 120. `email` = the `EMAIL` answer, trimmed and lower-cased, kept only if it matches `^[^@\s]+@[^@\s]+\.[^@\s]+$`. `phoneRaw` = the `PHONE` answer; `phoneE164 = toE164(phoneRaw)` (`packages/shared/src/inbox.ts`; handles `0803…`, `803…`, `+234…`). `field_data` entries with no matching question are appended with `label = name`. When the form's questions are unknown, use the name fallbacks above for all entries.
- R8. De-duplication: one row per `leadgen_id`, from the webhook or from back-fill, whichever comes first; the other is a no-op. The same person filling in two forms is two leads and one customer.

**Customer**

- R9. With a usable phone: `findOrCreateCustomer(tx, phoneE164, { name: fullName, email, source: "online" })`. This is the inbox's existing matching rule (digits-only match, oldest live record wins, per-number advisory lock). **An existing customer is never changed**: not name, not email, not address. The form's own values stay on the `lead` row and the drawer shows both when they differ.
- R10. With no usable phone but an email: use the oldest live customer where `lower(email) = <email>`; if none, insert `customer { name: fullName, email, phone: null, source: 'online' }`. With neither phone nor email: `customer_id` stays null and the lead lives only on the Leads page.

**Conversation**

- R11. Line = `lead_form.phone_number_id`, else the oldest active `inbox_phone_number` with `wa_phone_number_id` not null and (once spec 01 is in) `kind = 'phone'`. None → no conversation. A lead with no `phone_e164` gets no conversation.
- R12. `linkLeadConversation(…, { announce: true })`: `findOrOpenConversation(tx, customerId, lineId)`; insert an `inbox_message` `{ direction: "in", type: "lead", status: "received", body: leadTimelineBody(…), wa_message_id: null, payload: { lead_id }, createdAt: now }`; `touchConversation(tx, id, { preview: "New lead: <form name>", unreadIncrement: true })` **without** `inboundWa`; add the label `lead` if missing; `publishInboxEvent` for `message.created` with `direction: "in"` and for `conversation.updated`; set `lead.conversation_id`. Because the message is inbound and unread, the existing sound, pop-up and phone push all fire with no new code. With `announce: false` (the "Open conversation" button on a back-filled or disabled-form lead) do the same but with `unreadIncrement: false` and no `message.created` signal.
- R13. A lead is **not** a WhatsApp message from the customer: `last_inbound_wa_at` is not touched, so the 24-hour window stays closed until they actually write (D4).
- R14. `leadTimelineBody`: first line `Filled in the form “<form name>” on <Facebook | Instagram | a Meta advert>.` (`platform` `fb` → Facebook, `ig` → Instagram, else the last), then `Name: …`, `Phone: …`, `Email: …` (only those present), then up to 10 other answers as `<label>: <values joined by ", ">`, each cut to 200 characters; `…and <n> more answers` if there are more.

**Working a lead**

- R15. Status may move between any two values. Moving to `lost` requires `lost_reason` (422 `reason_required` otherwise); any other status clears it. Moving to `won` or `lost` sets `closed_at`; moving back clears it. The first move away from `new` sets `first_contacted_at` if empty.
- R16. `assignee_id` must be an active staff member with `leads.view` (422 otherwise). When a lead with a conversation is assigned and that conversation has no assignee, assign the conversation too and publish `conversation.updated`.
- R17. Leads are visible to everyone with `leads.view`. The **conversation** behind a lead is still governed only by `canSeeConversation` (rule 6): `conversation_id` is returned as null to a viewer who may not see it, and "Open conversation" answers 403.

**Consent and follow-up**

- R18. Recommended wording for the form's optional tick-box (owner's step 5): `I agree that Mrs. Samuel Fruit Juice may contact me on WhatsApp and by phone about my enquiry.` `whatsapp_consent` on a lead is true when the form has `consent_covers_whatsapp`, or when `whatsapp_consent_key` is set and that tick-box came back with `is_checked` true (Meta may send the boolean or the string `"true"`; accept both).
- R19. `POST /:id/follow-up` checks, in this order, and answers 409 with the code: `no_phone`; `no_line`; `no_consent` (`whatsapp_consent` false); `no_template` (no `inbox_template` named `lead_followup` with status `APPROVED` for the line's WABA and language `process.env.INBOX_TEMPLATE_LANGUAGE || "en"`); `already_sent` (`followup_sent_at` is set and `again` is not true). Then: make sure the conversation exists (`linkLeadConversation` with `announce: false`), call `sendFromConversation(db, cfg, { conversationId, userId, content: { type: "template", name: "lead_followup", language, bodyParams: [firstName] } })` where `firstName` is the first word of `full_name` or `there`. If the returned message is not `failed`: set `followup_sent_at = now()` and, when the status is `new`, move it to `contacted` (R15). If it failed, answer 422 `send_failed` with the message's error text; change nothing on the lead. `sendFromConversation` already writes the queued row before calling Meta (rule 9).
- R20. Template `lead_followup`, language `en`, category as Meta assigns it (expect Marketing), body: `Hello {{1}}, this is Mrs. Samuel Fruit Juice. Thank you for filling in our form. How can we help you today?` Sample value for `{{1}}`: `Ada`. No header, no buttons.

**Back-fill**

- R21. Per form, on request only. `sinceUnix = now − 90 days`. Each tick reads one page with `listFormLeads` (`GREATER_THAN sinceUnix`, `after = backfill_cursor`). For each lead not already stored: insert with `is_backfill = true`, `fetch_state = 'pending'` and then finish it **from the page's own data** (the bulk read already returns `field_data`): run steps 3, 5 and 6 of `processLead` without calling `fetchLead`. No conversation, no alert, no message (R3's behaviour). Save the new cursor and add to `backfill_count`; when `after` is null set `backfill_done_at`. A temporary error leaves the cursor for the next tick; a config error stops the back-fill (`backfill_done_at = now()`), raises the alert and shows in the Forms dialog as `Stopped: Meta would not let us read this form's leads.`
- R22. The 90-day reach is Meta's (unverified, section 3). Asking for more returns nothing extra, so the window is fixed.

**Reporting, testing, keeping**

- R23. `GET /report` returns `{ range: { from, to }, totals: { leads, new, contacted, won, lost, win_rate, median_minutes_to_first_contact }, by_form: [{ form_id, form_name, leads, contacted, won, lost, win_rate }], by_ad: [{ ad_id, ad_name, campaign_name, leads, contacted, won, lost, win_rate }], by_day: [{ day, leads }] }`. Days are Lagos days of `coalesce(meta_created_at, created_at)`. Leads with `lost_reason = 'test'` and leads not `fetched` are left out. `contacted` counts leads whose status is contacted, won or lost-after-contact (`first_contacted_at` not null). `win_rate = won / (won + lost)`, null when the divisor is 0. The median uses `first_contacted_at − coalesce(meta_created_at, created_at)` over leads that have it.
- R24. Test leads from Meta's tool cannot be told apart from real ones by the API. Staff mark them `Lost → Test lead`; they then vanish from the default list and from reports.
- R25. Keeping data. Meta's copy expires (about 90 days, unverified), so the suite's copy is the lasting one. It is kept until the customer's history is erased (5.3), which blanks the answers and contact fields but keeps the row. No automatic deletion in this version (section 14, Q5).
- R26. A lead whose fetch ends as `gone` is never shown; it is counted nowhere.

## 9. Tests

**`packages/domain/src/meta/leads.test.ts`** (unit)

- `mapLeadAnswers maps full name, email and phone by question type`
- `mapLeadAnswers joins first and last name when there is no full name`
- `mapLeadAnswers normalises 0803…, 803… and +234… to the same E.164 number`
- `mapLeadAnswers keeps a custom question's label and multiple values`
- `mapLeadAnswers falls back to field names when the form's questions are unknown`
- `mapLeadAnswers drops an invalid email and an unusable phone but keeps the raw phone`
- `buildConsent: ticked consent key gives whatsappConsent true; unticked gives false; the string "true" counts as ticked`
- `buildConsent: consent_covers_whatsapp gives true with no tick-boxes`
- `leadTimelineBody lists name, phone, email, then at most 10 answers`
- `classifyLeadError: 190/10/200/299 and 100-with-permission are config; 80005/4/17/429/5xx temporary; other 100 gone`

**`apps/api/test/integration/leads.test.ts`** (testcontainers; stub `globalThis.fetch` for `https://graph.facebook.com/`, answering by URL: `?fields=access_token` → a fake Page token; `/{leadgen-id}` → a lead; `/{form-id}?fields=id,name,questions` → a form; `/{form-id}/leads` → pages; `/subscribed_apps` → `{ data: [{ subscribed_fields: ["messages"] }] }`. Seed a Page account and a WhatsApp line as spec 01's tests do. Post webhooks to `/v1/webhooks/meta` signed like `sign()` in `inbox-whatsapp.test.ts`.)

- `a leadgen webhook stores one pending lead; replaying it stores nothing more`
- `one webhook with two leadgen changes stores two leads`
- `processLead fetches the lead with the Page token, stores answers and marks it fetched`
- `processLead creates a customer with phone, name and email when none matches`
- `processLead links an existing customer matched by phone and changes none of their fields`
- `processLead with only an email links the customer with that email, or creates one with no phone`
- `processLead opens a conversation, adds an inbound lead message, raises unread, adds the label lead, and does not set last_inbound_wa_at`
- `processLead for a form that is switched off stores the lead but opens no conversation`
- `a temporary Meta error schedules a retry with backoff; the eighth failure marks the lead failed`
- `error 200 marks the lead failed and queues one lead.fetch_blocked alert per day`
- `error 100 "does not exist" marks the lead gone and it is not listed`
- `GET /v1/leads needs leads.view; filters by status, form, owner and search; hides test leads by default`
- `GET /v1/leads returns conversation_id null to a viewer who cannot see that conversation`
- `PATCH status to lost without a reason is refused; with a reason sets closed_at; back to new clears both`
- `PATCH assignee also assigns an unassigned conversation`
- `POST follow-up is refused with no_consent, no_template and no_phone in turn`
- `POST follow-up sends the lead_followup template, sets followup_sent_at and moves new to contacted`
- `POST follow-up twice is refused with already_sent unless again is true`
- `POST forms/sync upserts forms and reads their questions`
- `PATCH forms/:id refuses a consent key the form does not have`
- `back-fill stores earlier leads as is_backfill with no conversation and no unread, follows the cursor and finishes`
- `back-fill skips a lead already stored from the webhook`
- `health/subscribe posts the union of existing fields and leadgen, and does nothing when leadgen is already there`
- `erasing a customer blanks their leads' answers and contact fields and keeps the rows`
- `merging contacts moves leads to the kept customer`
- `GET /report counts by form and advert, leaves out test leads, and computes win rate and the median`

**`apps/suite/src/features/leads/leads-logic.test.ts`**: `status chip label and colour for each status`; `follow-up blocked reason text for each code`; `row sub-line says “Not from an advert” for organic leads`; `win rate shows “–” when nothing is closed`.

No test calls the real Meta API (rule 3).

## 10. Manual check

Needs section 2 done, **including Live mode** (Q1). Use a Page admin's own account.

1. Suite → Leads → Forms → Check connection. All three lines say Yes. If "Meta is sending us new leads" says No, press Turn on.
2. Refresh forms. The Page's forms appear. On one form choose the WhatsApp permission tick-box and a WhatsApp number.
3. Open `https://developers.facebook.com/tools/lead-ads-testing`, choose the Page and that form, press **Preview form**, enter your own name, your own phone number and email, tick the consent box, submit. Press **Track status**: it should read success.
4. Within two minutes: the suite plays the new-message sound; Leads shows the lead under New with your answers; the inbox has a conversation with the bubble "Filled in the form …" and the label `lead`.
5. Open the lead. "What they agreed to" shows the tick-box wording and "Ticked". Assign it to yourself. Press Send WhatsApp follow-up → Send. Your phone receives the template; the status becomes Contacted.
6. Reply from your phone. The reply lands in the same conversation and the 24-hour window opens.
7. Mark the lead Lost → Test lead. It disappears from the list; tick "Show test leads" and it returns.
8. In the testing tool press **Delete lead**, then create another with a phone number of a customer who already exists in the shop under a different name. The lead links to that customer; the customer's name in the shop admin is unchanged; the drawer shows both names.
9. Forms → Fetch earlier leads on a form with history. Earlier leads appear tagged "Earlier lead"; no sound, no new conversations.
10. In Business Settings remove the system user from Leads Access, create another test lead. Within a few minutes the red banner appears and the owner gets one Telegram alert. Restore access, press Try again: the lead appears.
11. Open the report for the last 30 days and compare the counts with the list.
12. Repeat steps 4, 5 and 7 at 390 px wide.

## 11. Done when

- [ ] Migration 0081, journal entry and Drizzle schema are in; lint and type-check pass.
- [ ] `leads.view` exists and is granted to owner, admin and manager.
- [ ] A `page.leadgen` webhook is stored first, answered at once, and safe to process twice.
- [ ] A fetched lead has answers, consent, a customer (when there is a phone or email) and, for enabled forms, a conversation with an announcing message.
- [ ] No existing customer field is ever changed by a lead (test proves it).
- [ ] The follow-up can only be sent with consent, an approved template and a named person's click; it is audited.
- [ ] `/leads` works at desktop and 390 px in every state listed in section 7.
- [ ] All tests in section 9 exist and pass; no real Meta call in any test.
- [ ] No Page token or system token is logged, stored or returned.
- [ ] The pull request lists each **[unverified]** fact with what Meta actually returned, and whether Live mode was needed.

## 12. Out of scope

Creating or editing lead forms from the suite; advert spend and cost per lead (spec 12; this spec only stores `ad_id` and `campaign_id` so spec 12 can join); sending lead outcomes back to Meta (Conversions API); Messenger "in-thread" lead forms; appointment (`DATE_TIME`) and store-locator questions beyond showing their raw answers; automatic follow-up without a person (rule 7); automatic assignment rules; follow-up by SMS or email; deleting leads on a timer.

## 13. Work order

1. Permission `leads.view` (5.1). Build packages.
2. Migration 0081, journal, Drizzle schema, index export.
3. `leads.ts` pure functions (`mapLeadAnswers`, `buildConsent`, `leadTimelineBody`, `classifyLeadError`) with unit tests.
4. `findOrCreateCustomer` widening (5.3); run `packages/domain` tests and `inbox-whatsapp.test.ts`.
5. `ingestLeadgenChange` and the hook in spec 02's processing; first two integration tests.
6. Graph calls, `processLead`, `linkLeadConversation`; worker job `lead_fetch`; owner alert and its `format()` case; tests.
7. Routes `GET /`, `GET /:id`, `PATCH /:id`, `POST /:id/conversation`; register in `test-app.ts`; tests.
8. Forms: `POST /forms/sync`, `GET /forms`, `PATCH /forms/:id`, `GET /health`, `POST /health/subscribe`, job `lead_forms_sync`; tests.
9. Follow-up route; tests.
10. Back-fill route and job `lead_backfill`; tests.
11. Erase and merge changes in `inbox.ts`; tests.
12. Report and CSV export; tests.
13. Suite: nav, routes, `features/leads/*`, logic tests; `LeadCard.tsx` in the inbox contact panel; check at 390 px.
14. Manual check (section 10); record the result of every [unverified] fact in the pull request.

## 14. Open questions

| # | Question | Recommended default (use this unless told otherwise) |
|---|---|---|
| Q1 | **Contradiction with the foundation.** Foundation section 4 says every spec must work end to end with app-role accounts in development mode. Meta's lead documentation says "You can't retrieve leads if your app is in Development mode" and that the testing tool cannot be used in development mode. Whether a Live-mode app with only *standard* access can read leads for a Page its own business owns is [unverified] | Build and test everything against the Graph stub. For the manual check, ask the owner to switch the app to Live mode (a Meta-side step Tes should approve, since it affects the other products on the app). If leads still cannot be read, this spec's live test waits for app review of `leads_retrieval`; say so in the pull request rather than weakening the code |
| Q2 | Does the system user's Page token count as "a person who can perform the ADVERTISE task"? The Page is assigned with messaging rights only today | Section 2, step 2 adds the task. If Meta still refuses, the fallback is a Page token from the owner's own login, which the foundation does not allow to be stored; raise it with Tes instead of working around it |
| Q3 | Does posting `subscribed_fields=leadgen` replace the Page's other fields? [unverified] | R2 always posts the union, so the answer does not matter |
| Q4 | Which `customer.source` for a brand-new lead? The enum has no advert value and rule 2 forbids changing a type | `online`. The `lead` row is the record of where they came from |
| Q5 | Should the suite delete lead answers after a fixed time? | No automatic deletion now; erase on request through the existing route. Ask the owner for a retention period before real adverts run, and add a nightly job then |
| Q6 | Is a filled-in lead form enough permission to send a WhatsApp template? | Only with the explicit tick-box, or the owner's statement that the form's wording covers it (R18). This is stricter than Meta requires in most cases and protects the number's quality rating |
| Q7 | Drizzle runs a migration only if its journal `when` is later than the newest applied one. Suite migrations 0071 to 0081 will be merged out of order | Give each suite migration a `when` that grows with its number (as here), **and** at merge time make sure the file being merged has the largest `when` on `master`; otherwise it is skipped silently in production. Tes should check this on every merge |
| Q8 | Spec 02's exact processing function is not fixed in the foundation, so the hook in 5.3 is described by behaviour, not by name | Add the `leadgen` branch wherever spec 02 loops over `entry[].changes[]`; if it stored only the first change's field as `kind`, still loop over all changes |
| Q9 | Should an unassigned new lead be given to someone automatically? | No. It lands unassigned in the line's default team, like any new conversation |
| Q10 | The lead reference page (`…/reference/user-lead-gen-info/`) and the form reference page returned "not found" on 19 Nov 2026, so several field names are [unverified] | The code reads those fields in separate, optional calls that may fail without harm (R4, R6). Check them in the Graph API Explorer before relying on advert names in the report |
