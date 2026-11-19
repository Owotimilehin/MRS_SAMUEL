# Suite build spec 06: WhatsApp template authoring

Read `00-foundation.md` first. Size M. Suggested model: Sonnet. Permission: `templates.manage`. Migration: `0075_template_authoring.sql`.

Every Meta fact is tagged **[verified: URL, 19 Nov 2026]** or **[unverified]**. Before coding against an unverified fact, read the page.

---

## 1. Outcome

A staff member with the right permission can say:

- "Under **Templates and forms** I see every WhatsApp template we have, whether WhatsApp has approved it, how customers are reacting to it, and why any were refused."
- "I write a new template in the suite: I pick a name, a language and a type, write the message with blanks like `{{1}}`, give an example for each blank, add a heading, small print and buttons if I want, and see a phone preview as I type."
- "The page warns me, in plain words, about things that get templates refused before I send it to WhatsApp."
- "I can save a draft and come back. When I am ready I press **Send to WhatsApp for approval**, see exactly what will be sent, and confirm."
- "I can change an approved or refused template, and delete one."
- "When WhatsApp approves, refuses, pauses or re-files a template, the list updates by itself within a minute, and the owner is told about the bad ones."
- "A starter set for our shop (order confirmed, out for delivery, delivered, missed call, payment reminder, pre-order ready, re-open a chat) is one click away, as drafts I can read and then submit."

## 2. Depends on

- **Branch `work/olu/inbox-gaps` merged.** It already provides (do not rebuild):
  - `packages/shared/src/inbox-templates.ts`: `templateNeeds(components, category)` returns what a template needs to be sent (`bodyParams`, `headerText`, `headerParams`, `headerMedia`, `urlButtons`, `footerText`, `buttonLabels`) and `sendable` / `reason`. It marks as **not sendable**: `AUTHENTICATION` category, named blanks, more than one heading blank, a `LOCATION` heading, buttons `COPY_CODE`, `OTP`, `FLOW`, `CATALOG`, `MPM`, `SPM`, `VOICE_CALL`, `APP`, carousels, limited-time offers, and anything it does not recognise.
  - `buildTemplateComponents()` in `meta.ts` and `prepareTemplateContent()` in `send.ts`: sending with a heading blank, a picture / video / document heading (by link), and one blank at the end of a link button. New send errors `template_unsupported` and `template_incomplete`.
  - `POST /v1/inbox/conversations/:id/messages` accepts `header_param`, `header_media`, `button_params`; `GET /v1/inbox/templates` returns `sendable`, `unsendable_reason`, `header_media`, `header_param_count`, `url_buttons`.
  - The template picker in `Composer.tsx` shows what each template needs; the out-of-hours auto-reply (`packages/domain/src/inbox/auto-reply.ts`, job `inbox_auto_reply`).
- **What this spec adds:** writing, previewing, submitting, editing, deleting and tracking templates; drafts; review and quality tracking by webhook; the starter set. **The editor only offers parts the inbox can send** (see section 12).
- **From spec 05 (build here if 05 is not merged, from its section 5.2):** `graphRaw()`, `uploadFileToMeta()`, env `META_APP_ID`, exported `graph()`.
- **A person must do in Meta first (Tes or the owner, once):** App Dashboard → the app "Mrs Samuel fruit juice" → WhatsApp → Configuration → Webhooks → Manage → subscribe the fields `message_template_status_update`, `message_template_quality_update` and `template_category_update`. The WhatsApp account is already subscribed to the app (messages arrive), so nothing else is needed. Until this is done the suite still works: a job checks waiting templates every 5 minutes.
- **Meta-side blockers for real sending (not for building):** payment method, business verification (blueprint section 8).

## 3. Meta reference

### 3.1 Endpoints

| Fact | Status |
|---|---|
| Create: `POST /{waba-id}/message_templates`, JSON `{ name, language, category, parameter_format?, components: [...] }`. Returns `{ id, status, category }` | [verified: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/, 19 Nov 2026] |
| List: `GET /{waba-id}/message_templates?fields=…&limit=…`; paging with `paging.next`; can filter `status`, `name`, `language`, `category`, `quality_score` | [verified: same page, 19 Nov 2026] |
| Template node fields include `id`, `name`, `language`, `status`, `category`, `sub_category`, `components`, `quality_score`, `rejected_reason`, `parameter_format`, `correct_category`, `previous_category`, `last_updated_time`, `message_send_ttl_seconds` | [verified: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-hsm/, 19 Nov 2026] |
| `quality_score` is an object `{ "score": "GREEN"|"YELLOW"|"RED"|"UNKNOWN", "date": <unix seconds> }` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality.md, 19 Nov 2026] |
| Read one: `GET /{template-id}?fields=…` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview.md, 19 Nov 2026] |
| Edit: `POST /{template-id}` with `components` (replaced whole, not patched), `category`, `message_send_ttl_seconds`. Returns `{ success, id, name, category }` | [verified: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-hsm/, 19 Nov 2026] |
| Only `APPROVED`, `REJECTED` or `PAUSED` templates can be edited. An approved template: "up to 10 times in a 30-day window, or 1 time in a 24-hour window". Rejected or paused: no limit. The category of an approved template cannot be edited. After editing an approved or paused template it is re-approved automatically unless it fails review | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management.md, 19 Nov 2026] |
| Delete one language: `DELETE /{waba-id}/message_templates?hsm_id={template-id}&name={name}`. Delete every language of a name: `?name={name}`. Returns `{ success: true }`. Needs `whatsapp_business_management` (error `200` without it) | [verified: same page, 19 Nov 2026] |
| After deleting an approved template its name cannot be reused for 30 days. Messages already sent but not delivered keep trying for 30 days (`PENDING_DELETION`). A disabled template cannot be deleted | [verified: same page, 19 Nov 2026] |
| Unpause: `POST /{template-id}/unpause` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing.md, 19 Nov 2026] |
| Limits: 100 templates created per hour; 250 templates per account while the business is unverified, 6,000 once verified with an approved display name | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview.md, 19 Nov 2026] |
| Review can take up to 24 hours | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review.md, 19 Nov 2026] |
| Unused templates are archived after 12 months and deleted 28 days later unless unarchived | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management.md, 19 Nov 2026] |
| Header sample media: upload with the Resumable Upload API (`POST /{app-id}/uploads`, then `POST /upload:<session>`), put the returned handle in `example.header_handle` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md and https://developers.facebook.com/docs/graph-api/guides/upload, 19 Nov 2026] |
| The upload API accepts only `application/pdf`, `image/jpeg`, `image/jpg`, `image/png`, `video/mp4` | [verified: https://developers.facebook.com/docs/graph-api/guides/upload, 19 Nov 2026] |
| When editing a template that has a media heading, a fresh `header_handle` must be sent | [unverified] This spec always uploads the sample again on every submit |
| Graph errors for templates carry `error_subcode`, `error_user_title`, `error_user_msg` | [unverified] Captured when present (section 5.2) |

### 3.2 Names, languages, categories

| Fact | Status |
|---|---|
| Name: lowercase letters, digits and underscores only; max 512 characters; unique per language. A duplicate returns error `100` with subcode `2388024` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management.md, 19 Nov 2026] |
| Languages offered here, all in Meta's list: `en` English, `en_GB` English (UK), `en_US` English (US), `ha` Hausa, `fr` French. **Yoruba, Igbo and Pidgin are not in Meta's list** | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages, 19 Nov 2026] |
| Categories: `MARKETING`, `UTILITY`, `AUTHENTICATION` | [verified: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/, 19 Nov 2026] |
| **Utility** must be non-promotional and either specific to the customer or asked for by them, or essential. Covers order updates, account alerts, opt-in, feedback about a specific order, continuing a conversation. No promotion, upsell, offers or renewals | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization.md, 19 Nov 2026] |
| **Marketing** is the catch-all: anything promotional, anything mixed (an order update with an offer), anything unclear (a body that is only `{{1}}`) | [verified: same page, 19 Nov 2026] |
| **Authentication** is only for one-time passcodes; fixed wording from Meta, an OTP button, no links, media or emoji; created through `POST /{waba-id}/upsert_message_templates` | [verified: same page and https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates.md, 19 Nov 2026] |
| Since 9 April 2025 a template submitted as Utility that Meta judges to be Marketing is **approved as Marketing**; the create response carries the category Meta chose | [verified: template-categorization.md above, 19 Nov 2026] |
| After approval Meta can re-file Utility as Marketing with one day's notice (none for businesses already warned). Check by comparing `category` with `correct_category` | [verified: same page, 19 Nov 2026] |
| A category review can be asked for only in WhatsApp Manager (Business Support → Template Category Updates → Request Review), within 60 days | [verified: same page, 19 Nov 2026] |
| Repeatedly filing marketing as utility brings a warning, then a cap on utility messages, then all utility templates turned into marketing for 7 or 30 days | [verified: same page, 19 Nov 2026] |

### 3.3 Components and limits

| Part | Rule | Status |
|---|---|---|
| Header | Optional, one. Formats `TEXT`, `IMAGE`, `VIDEO`, `DOCUMENT`, `LOCATION` (`GIF` only for the Marketing Messages API). Text: max 60 characters, at most 1 blank, no formatting characters. Location only in Utility or Marketing | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md, 19 Nov 2026] |
| Body | Required, one. Max 1024 characters. Any number of blanks; **an example value is required for every blank** | [verified: same page, 19 Nov 2026] |
| Footer | Optional, one. Max 60 characters | [verified: same page, 19 Nov 2026] |
| Footer blanks | Meta's pages disagree (components page shows text only; the utility page says "Variables are supported"). This spec allows **no** blanks in the footer | [unverified] |
| Buttons | Up to 10 in one `buttons` array. With more than 3, two show and the rest sit behind "See all options" | [verified: same page, 19 Nov 2026] |
| `QUICK_REPLY` | Up to 10; text max 25 | [verified: same page, 19 Nov 2026] |
| `URL` | Up to 2; text max 25; `url` max 2000; **one** blank, only at the end of the URL; `example` required when there is a blank | [verified: same page, 19 Nov 2026] |
| `URL` example | The example is the full link with the blank filled in | [unverified] |
| `PHONE_NUMBER` | Up to 1; text max 25; number max 20 characters | [verified: same page, 19 Nov 2026] |
| `COPY_CODE` | Up to 1; `example` max 20 characters | [verified: same page, 19 Nov 2026] |
| Button text | "alphanumeric characters only" | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates.md, 19 Nov 2026] |
| Button order | Quick-reply buttons and other buttons must each sit together (QR, QR, URL is fine; QR, URL, QR is refused) | [verified: components.md above, 19 Nov 2026] |
| Blanks | Positional `{{1}}`, `{{2}}` (default) or named `{{first_name}}` (lowercase and underscores), chosen with `parameter_format`. Positional blanks must be in order with no gaps | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview.md and template-review.md, 19 Nov 2026] |
| Common refusals | Missing or mismatched braces; `#`, `$` or `%` inside a blank; blanks out of order; too many blanks for the length (subcode `2388293`); a blank at the very start or end (subcode `2388299`); a body and footer identical to an existing template (duplicate); policy breaches | [verified: template-review.md above and https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes, 19 Nov 2026] |
| Two blanks side by side | Refused as `INVALID_FORMAT` ("parameters placed next to each other without separating text") | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update.md, 19 Nov 2026] |
| Other subcodes | `2388019` template limit reached; `2388039` template is in review or locked and cannot change; `2388040` a field is too long; `2388047` / `2388072` / `2388073` heading / body / footer badly formed | [verified: error-codes page above, 19 Nov 2026] |
| Body line breaks, emoji counts | No more than two line breaks in a row; emoji allowed in the body | [unverified] Treated as warnings only |
| Sample media size | Image up to 5 MB, video up to 16 MB, PDF up to 16 MB | [unverified] Our limits, matching `INBOX_UPLOAD_TYPES` |

Creation JSON for each part (lower- or upper-case `type` both appear in Meta's examples; send upper-case):

```json
{ "type": "HEADER", "format": "TEXT", "text": "Order {{1}}", "example": { "header_text": ["MS-10482"] } }
{ "type": "HEADER", "format": "IMAGE", "example": { "header_handle": ["<HANDLE>"] } }
{ "type": "BODY", "text": "Hello {{1}}, …", "example": { "body_text": [["Ada", "MS-10482"]] } }
{ "type": "FOOTER", "text": "Mrs. Samuel Fruit Juice" }
{ "type": "BUTTONS", "buttons": [
  { "type": "QUICK_REPLY", "text": "Call me back" },
  { "type": "URL", "text": "View order", "url": "https://www.mrssamuel.com/order/{{1}}", "example": ["https://www.mrssamuel.com/order/MS-10482"] },
  { "type": "PHONE_NUMBER", "text": "Call us", "phone_number": "+2348000000000" } ] }
```

[verified: components.md above, 19 Nov 2026] for every shape except the nesting of `body_text`: Meta's page shows `"body_text": ["<VALUE>", …]`; older examples use an array inside an array. **[unverified]** which Meta accepts today. Send the nested form `[[…]]` first; if Meta answers code `100`, retry once with the flat form and record which worked in the pull request.

### 3.4 Statuses, quality, pausing

| Fact | Status |
|---|---|
| Status values on the list filter: `APPROVED`, `IN_APPEAL`, `PENDING`, `REJECTED`, `PENDING_DELETION`, `DELETED`, `DISABLED`, `PAUSED`, `LIMIT_EXCEEDED`, `ARCHIVED` | [verified: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/, 19 Nov 2026] |
| Only `APPROVED` can be sent | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality.md, 19 Nov 2026] |
| Quality: `GREEN` high, `YELLOW` medium, `RED` low, `UNKNOWN` not rated yet. All can still be sent | [verified: same page, 19 Nov 2026] |
| Pausing for low quality: first time 3 hours, second time 6 hours, third time disabled. A paused template un-pauses by itself. Sends while paused are refused and not billed | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing.md, 19 Nov 2026] |
| Send errors: `132015` paused, `132016` disabled for good, `132001` not found or not approved in that language, `132000` wrong number of blanks, `132012` a blank in the wrong format | [verified: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes, 19 Nov 2026] |

### 3.5 Webhooks (all arrive at the existing `POST /v1/webhooks/whatsapp`)

Subscribe in App Dashboard → WhatsApp → Configuration. All three need `whatsapp_business_management`. [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview.md, 19 Nov 2026]

Common envelope: `{ object: "whatsapp_business_account", entry: [{ id: "<WABA_ID>", time: <unix>, changes: [{ field, value }] }] }`.

| Field | `value` | Status |
|---|---|---|
| `message_template_status_update` | `event`, `message_template_id` (number), `message_template_name`, `message_template_language` (for example `en-US` or `en`), `reason`, `message_template_category`, and sometimes `disable_info.disable_date`, `other_info.title` (`FIRST_PAUSE`, `SECOND_PAUSE`, `RATE_LIMITING_PAUSE`, `UNPAUSE`, `DISABLED`) + `other_info.description`, `rejection_info.reason` + `rejection_info.recommendation` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update.md, 19 Nov 2026] |
| … `event` values | `APPROVED`, `REJECTED`, `DISABLED`, `FLAGGED`, `PAUSED`, `LOCKED`, `PENDING`, `IN_APPEAL`, `LIMIT_EXCEEDED`, `REINSTATED`, `ARCHIVED`, `UNARCHIVED`, `DELETED`, `PENDING_DELETION` | [verified: same page, 19 Nov 2026] |
| … `reason` values | `NONE`, `INVALID_FORMAT`, `ABUSIVE_CONTENT`, `PROMOTIONAL`, `SCAM`, `INCORRECT_CATEGORY`, `TAG_CONTENT_MISMATCH`, `CATEGORY_NOT_AVAILABLE` (retired), or null | [verified: same page, 19 Nov 2026] |
| `message_template_quality_update` | `previous_quality_score`, `new_quality_score` (`GREEN`, `YELLOW`, `RED`, `UNKNOWN`), `message_template_id`, `message_template_name`, `message_template_language` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_quality_update.md, 19 Nov 2026] |
| `template_category_update` | Always `message_template_id`, `message_template_name`, `message_template_language`. **Notice of a coming change:** `new_category` (the current one), `correct_category` (what it will become), `category_update_timestamp` (unix seconds, 24 hours ahead). **Change done:** `previous_category`, `new_category` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/template_category_update.md, 19 Nov 2026] |
| `message_template_components_update` | Sent when a template is edited. Not used here (the hourly sync covers edits made in WhatsApp Manager) | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_components_update.md, 19 Nov 2026] |

**App review:** none; the business's own account works with standard access.

## 4. Data

### 4.1 Migration `packages/db/migrations/0075_template_authoring.sql`

```sql
-- Template authoring: drafts and Meta review tracking on inbox_template.
-- Additive only: new nullable columns and two indexes. No existing column changes.
-- The unique index uq_inbox_template (waba_id, name, language) is untouched and
-- still holds: a draft is a row with status 'DRAFT' under the same key.
-- Undo: DROP INDEX uq_inbox_template_meta_id, idx_inbox_template_status;
--       ALTER TABLE inbox_template DROP COLUMN for each column below.

ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "meta_template_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "parameter_format" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "quality_score" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "rejected_reason" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "review_info" jsonb;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "correct_category" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "previous_category" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "category_change_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "draft" jsonb;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "draft_updated_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "draft_updated_by" uuid REFERENCES "admin_user"("id");
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "admin_user"("id");
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "submitted_by" uuid REFERENCES "admin_user"("id");
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "meta_edit_times" jsonb;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "starter_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_template_meta_id" ON "inbox_template" ("meta_template_id") WHERE "meta_template_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_template_status" ON "inbox_template" ("status");
```

Journal entry in `packages/db/migrations/meta/_journal.json`, appended last: `{ "idx": <previous idx + 1>, "version": "7", "when": 1786600000000, "tag": "0075_template_authoring", "breakpoints": true }`. `when` must be larger than every entry before it; if an earlier suite migration used a larger value, use that value plus 100000000.

### 4.2 Drizzle (`packages/db/src/schema/inbox.ts`, inside `inboxTemplate`)

```ts
metaTemplateId: text("meta_template_id"),
parameterFormat: text("parameter_format"),
qualityScore: text("quality_score"),
rejectedReason: text("rejected_reason"),
reviewInfo: jsonb("review_info").$type<TemplateReviewInfo>(),
correctCategory: text("correct_category"),
previousCategory: text("previous_category"),
categoryChangeAt: timestamp("category_change_at", { withTimezone: true }),
statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
draft: jsonb("draft").$type<Record<string, unknown>>(),
draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }),
draftUpdatedBy: uuid("draft_updated_by").references(() => adminUser.id),
createdBy: uuid("created_by").references(() => adminUser.id),
submittedBy: uuid("submitted_by").references(() => adminUser.id),
submittedAt: timestamp("submitted_at", { withTimezone: true }),
metaEditTimes: jsonb("meta_edit_times").$type<string[]>(),
lastError: text("last_error"),
starterKey: text("starter_key"),
```
Add `uqMetaId: uniqueIndex("uq_inbox_template_meta_id").on(t.metaTemplateId).where(sql\`meta_template_id is not null\`)` and `idxStatus: index("idx_inbox_template_status").on(t.status)`. Export `interface TemplateReviewInfo { rejection?: { reason?: string; recommendation?: string }; pause?: { title?: string; description?: string }; disableDate?: string; flagged?: boolean; locked?: boolean }`.

### 4.3 What the columns mean

- **`status`** keeps Meta's values and gains one local value, **`DRAFT`**: written here, never sent to Meta. A `DRAFT` row has `meta_template_id` null and `components = []`.
- **`draft`** holds the editable copy (`TemplateDraft`, section 5.1). On a `DRAFT` row it is the template. On a row Meta knows, a non-null `draft` means "changes not yet sent to WhatsApp"; `components` stays what Meta holds.
- **`meta_edit_times`**: ISO times of our successful edits of an approved template, newest last, trimmed to the last 30 days. Drives the edit-limit display.
- **`last_error`**: plain-English result of the last failed submit or delete; cleared on success.
- **`starter_key`**: which starter template the row came from, so the starter dialog can show "already added".

## 5. Server

### 5.1 Shared (browser-safe) — `packages/shared/src/template-draft.ts`, `template-starter.ts`

```ts
export type DraftCategory = "MARKETING" | "UTILITY";
export type DraftHeader =
  | { format: "TEXT"; text: string; example: string }                         // example "" when no blank
  | { format: "IMAGE" | "VIDEO" | "DOCUMENT"; sampleKey: string; sampleMime: string; sampleName: string };
export type DraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example: string }               // example = the end of the link; "" when no blank
  | { type: "PHONE_NUMBER"; text: string; phone: string };
export interface TemplateDraft {
  category: DraftCategory;
  header: DraftHeader | null;
  body: { text: string; examples: string[] };                                 // examples[i] is for {{i+1}}
  footer: string;                                                             // "" = none
  buttons: DraftButton[];
}
export const TEMPLATE_LIMITS = { name: 512, nameUi: 60, headerText: 60, body: 1024, footer: 60, buttonText: 25, url: 2000, phone: 20,
  buttons: 10, urlButtons: 2, phoneButtons: 1, quickReplies: 10 } as const;
export const TEMPLATE_LANGUAGES = [
  { code: "en", label: "English" }, { code: "en_GB", label: "English (UK)" }, { code: "en_US", label: "English (US)" },
  { code: "ha", label: "Hausa" }, { code: "fr", label: "French" } ] as const;
export const EMPTY_DRAFT: TemplateDraft;                                      // UTILITY, no header, empty body, no footer, no buttons
export interface DraftProblem { field: string; level: "error" | "warning"; code: string; message: string }
export function validateTemplateName(name: string): string | null;
export function validateDraft(d: TemplateDraft, ctx: { name: string; others: { name: string; body: string; footer: string }[] }): DraftProblem[];
export function blanksIn(text: string): number[];                             // numbers found, in order of appearance
export function draftToComponents(d: TemplateDraft, headerHandle: string | null): Record<string, unknown>[];
export function componentsToDraft(components: readonly unknown[], category: string | null): TemplateDraft | null;
export function draftPreview(d: TemplateDraft): { header: string | null; headerMedia: "image" | "video" | "document" | null; body: string; footer: string | null; buttons: string[] };
export function editsLeft(times: readonly string[], now: Date): { today: number; month: number };   // today 0|1, month 0..10
export function normaliseTemplateLanguage(code: string): string;              // "en-US" -> "en_US"
```

- `draftToComponents` produces the shapes in section 3.3, in the order header, body, footer, buttons; leaves out empty parts; leaves out `example` when a part has no blank; the URL example is `url` with `{{1}}` replaced by `example`.
- `componentsToDraft` is the reverse, for editing a template Meta already holds. It returns **null** when `templateNeeds(components, category).sendable` is false or the category is `AUTHENTICATION` (the editor cannot open it; the screen says so). A media header comes back with `sampleKey: ""` (staff must choose a sample again before submitting).
- `draftPreview` fills blanks with the examples (a missing example shows as `{{n}}`).

`validateDraft` rules. `error` blocks submitting; `warning` needs a tick. Messages are exact.

| code | level | When | Message |
|---|---|---|---|
| `name_format` | error | name not `^[a-z0-9_]{1,60}$` | "Use lowercase letters, numbers and underscores only, for example order_confirmed." |
| `body_empty` | error | body blank | "Write the message." |
| `body_long` | error | over 1024 | "The message is too long. WhatsApp allows 1,024 characters." |
| `blank_order` | error | blanks are not exactly 1..n, each at least once | "Number the blanks in order: {{1}}, then {{2}}, with none missing." |
| `blank_edge` | error | body (trimmed) starts with `{{` or ends with `}}` or `}}` + one punctuation mark | "Do not start or end the message with a blank. Put words before and after it." |
| `blank_adjacent` | error | two blanks with only spaces between | "Put some words between two blanks." |
| `blank_named` | error | `{{` + anything not digits + `}}` | "Use numbered blanks like {{1}}. Named blanks cannot be sent from the inbox yet." |
| `brace_mismatch` | error | counts of `{{` and `}}` differ, or a single `{`/`}` | "A blank looks broken. Write it exactly like {{1}}." |
| `example_missing` | error | a blank has no example | "Give an example for blank {{n}}. WhatsApp will not review the template without one." |
| `header_long` / `header_blanks` | error | heading over 60 / more than one blank or blank not `{{1}}` | "Keep the heading to 60 characters." / "A heading can have one blank at most: {{1}}." |
| `header_sample` | error | media heading with empty `sampleKey` | "Add a sample picture, video or PDF for the heading. WhatsApp needs one to review." |
| `footer_long` / `footer_blank` | error | over 60 / contains `{{` | "Keep the small print to 60 characters." / "The small print cannot have blanks." |
| `button_text` | error | empty or over 25 | "Give each button a label of 25 characters or fewer." |
| `button_counts` | error | over 10 total, 2 links, 1 phone | "Too many buttons. WhatsApp allows 10 in all, with at most 2 links and 1 phone number." |
| `button_group` | error | quick replies not contiguous | "Keep the reply buttons together, either all first or all last." |
| `url_format` | error | not `https://…`, over 2000, more than one blank, or a blank not at the very end | "A link must start with https:// and can have one blank, {{1}}, at the very end." |
| `phone_format` | error | not `^\+[1-9]\d{7,14}$` | "Write the phone number with its country code, for example +2348012345678." |
| `button_label_chars` | warning | label has characters other than letters, digits, spaces | "WhatsApp asks for letters and numbers only on buttons. Remove symbols or emoji to be safe." |
| `blank_ratio` | warning | words outside blanks < 4 × number of blanks | "This has a lot of blanks for a short message. WhatsApp often refuses that. Add more fixed words." (our rule of thumb, not Meta's number) |
| `blank_symbols` | warning | an example contains a line break, a tab or 4+ spaces in a row | "Keep each example on one line without long gaps." |
| `newlines` | warning | three or more line breaks in a row | "Remove extra empty lines." |
| `utility_promo` | warning | category UTILITY and body, header or footer contains, case-insensitive and as whole words (so "wholesale" does not match "sale"), any of: `discount`, `% off`, `promo`, `offer`, `sale`, `deal`, `free`, `buy now`, `order now`, `shop now`, `limited time`, `don't miss`, `new flavour`, `try our`, `coupon` | "This reads like a promotion. WhatsApp will file it under Marketing instead of Order and account updates. Remove the selling words, or change the type to Marketing." |
| `duplicate` | warning | another template (not DELETED) has the same body and footer after trimming | "This says the same as “{name}”. WhatsApp refuses copies. Change the wording or use that one." |
| `shortener` | warning | a URL host is one of `bit.ly`, `tinyurl.com`, `t.co`, `goo.gl`, `wa.me` | "Use your own website address, not a short link." (our advice) |

### 5.2 Domain — `packages/domain/src/meta/templates.ts` (re-exported from the package index)

Extend `MetaApiError` with an optional sixth constructor argument `details?: { subcode?: string; userTitle?: string; userMessage?: string }`, filled by `graph()` from `error.error_subcode`, `error.error_user_title`, `error.error_user_msg` when present. Existing callers are unaffected.

```ts
export const TEMPLATE_FIELDS = "id,name,language,status,category,components,quality_score,rejected_reason,parameter_format,correct_category,previous_category";
export interface MetaTemplateFull { id: string; name: string; language: string; status: string; category?: string; components?: unknown[];
  quality_score?: { score?: string; date?: number }; rejected_reason?: string; parameter_format?: string; correct_category?: string; previous_category?: string }

export function listTemplatesFull(cfg: MetaConfig, wabaId: string): Promise<MetaTemplateFull[]>;       // paged like listTemplates
export function getTemplate(cfg: MetaConfig, templateId: string): Promise<MetaTemplateFull>;
export function findTemplateByName(cfg: MetaConfig, wabaId: string, name: string, language: string): Promise<MetaTemplateFull | null>;
export function createTemplate(cfg: MetaConfig, wabaId: string, t: { name: string; language: string; category: DraftCategory; components: unknown[] }): Promise<{ id: string; status: string; category: string }>;
export function editTemplate(cfg: MetaConfig, templateId: string, t: { components: unknown[]; category?: DraftCategory }): Promise<void>;
export function deleteTemplate(cfg: MetaConfig, wabaId: string, t: { id: string; name: string }): Promise<void>;

/** Upsert Meta's templates into inbox_template. Replaces the two copies in inbox.ts and the worker. */
export function syncTemplatesForWaba(db: DbExecutor, cfg: MetaConfig, wabaId: string, now?: Date): Promise<number>;
/** Write one Meta template onto its row (used by sync, refresh, submit read-back). */
export function applyMetaTemplate(db: DbExecutor, wabaId: string, t: MetaTemplateFull, now: Date): Promise<void>;
/** Apply one template webhook change. Runs inside the webhook transaction. */
export function applyTemplateWebhook(db: DbExecutor, wabaId: string, field: string, value: Record<string, unknown>, eventTime: Date): Promise<{ applied: boolean; resync: boolean }>;
/** Plain-English explanation of a create/edit/delete refusal. */
export function explainTemplateError(err: unknown): string;
```

`createTemplate` sends `parameter_format: "POSITIONAL"` and upper-case category. `listTemplatesFull` requests `TEMPLATE_FIELDS`; if Meta answers code `100` (a field it does not know), it retries the whole listing once with the old field list `name,language,status,category,components` plus `id`.

**`applyMetaTemplate` / `syncTemplatesForWaba` rules**
1. Match a row by `meta_template_id = t.id`; else by `(waba_id, name, language)`.
2. Insert or update: `status`, `category`, `components`, `meta_template_id`, `parameter_format`, `quality_score` (= `quality_score.score`), `rejected_reason` (null when `NONE` or empty), `correct_category`, `previous_category`, `synced_at = now`. Set `status_changed_at = now` only when `status` changed.
3. A local `DRAFT` row whose key Meta now has (someone made it in WhatsApp Manager) takes Meta's values; its `draft` is **kept** as unsent changes.
4. `draft` is never touched by sync.
5. After the loop: rows of this WABA that Meta did not return **and whose status is not `DRAFT` and not `DELETED`** get `status = 'DELETED'`. (Today's code would wrongly mark drafts deleted; this is the fix.)
6. Returns the number of templates Meta returned. `listTemplates` and `MetaTemplate` stay exported for older callers.

**`applyTemplateWebhook` rules.** Find the row by `meta_template_id = String(value.message_template_id)`, else by `(waba_id, message_template_name, normaliseTemplateLanguage(message_template_language))`. No row → `{ applied: false, resync: true }` (the template was made elsewhere; a sync will bring it). If `status_changed_at` is later than `eventTime`, ignore status changes (an old event replayed) but still return `applied: true`.

| Field / event | Row change | Owner alert `kind` |
|---|---|---|
| status `APPROVED` | `status = 'APPROVED'`, clear `rejected_reason`, `review_info.rejection`, `review_info.pause`, `review_info.flagged`; if `message_template_category` is present and differs from `category`, set `previous_category = category`, `category = it` | `approved_as_marketing` only when the category changed to MARKETING |
| `REJECTED` | `status = 'REJECTED'`, `rejected_reason = reason`, `review_info.rejection = rejection_info` | `rejected` |
| `PENDING` | `status = 'PENDING'` | — |
| `PAUSED` | `status = 'PAUSED'`, `review_info.pause = other_info` | `paused` |
| `DISABLED` | `status = 'DISABLED'`, `review_info.disableDate` from `disable_info.disable_date` | `disabled` |
| `FLAGGED` | status unchanged, `review_info.flagged = true` | `flagged` |
| `REINSTATED` | `status = 'APPROVED'`, clear `flagged`, `pause` | — |
| `LOCKED` | status unchanged, `review_info.locked = true` | — |
| `IN_APPEAL`, `LIMIT_EXCEEDED`, `ARCHIVED`, `DELETED`, `PENDING_DELETION` | `status =` the event name | `archived` for ARCHIVED only |
| `UNARCHIVED` or any unknown event | no change; return `resync: true` | — |
| quality update | `quality_score = new_quality_score` | `quality_red` only when new is `RED` |
| category notice (has `correct_category`) | `correct_category`, `category_change_at = category_update_timestamp` | `category_notice` |
| category done (has `previous_category`) | `category = new_category`, `previous_category`, clear `correct_category`, `category_change_at` | `category_changed` |

Every change sets `synced_at = eventTime`; status changes set `status_changed_at = eventTime`. An alert is one `outbox_event` row, `eventType: "inbox.template_alert"`, `payload: { template_id, name, language, kind, detail }`, inserted in the same transaction, skipped when the same `template_id` + `kind` was alerted in the last 24 hours (same select-then-insert as `alertUnknownNumbers`). Add `case "inbox.template_alert"` to `apps/worker/src/outbox.ts`, to the owner chat: "📝 *WhatsApp template: {title}*\n“{name}” ({language}). {sentence}\n👉 {SUITE_URL or ADMIN_URL}/templates" where title / sentence are: `rejected` "refused" / "WhatsApp refused it: {reason wording from 7.2}."; `paused` "paused" / "Customers reacted badly, so WhatsApp paused it for a few hours. It cannot be sent until then."; `disabled` "switched off" / "WhatsApp has switched it off for good. Write a new one with different wording."; `flagged` "at risk" / "Customers are reacting badly. It may be paused soon."; `quality_red` "low quality" / "Its quality is now low."; `category_notice` "will be re-filed" / "WhatsApp will move it from {category} to {correct_category} on {date, Lagos}."; `category_changed` and `approved_as_marketing` "re-filed" / "WhatsApp now files it under {new category}."; `archived` "archived" / "Not used for a year. WhatsApp will delete it in 28 days unless it is restored in WhatsApp Manager."

**`explainTemplateError`** returns, by `MetaApiError` code / subcode: subcode `2388024` → "A template with this name and language already exists at WhatsApp. Press Sync to bring it in, or choose another name."; `2388019` → "You have reached WhatsApp's limit on the number of templates. Delete ones you do not use."; `2388039` → "WhatsApp is reviewing this template and will not accept changes until it has decided."; `2388040` → "One part is too long for WhatsApp."; `2388047`, `2388072`, `2388073` → "WhatsApp did not accept the layout of the heading / message / small print."; `2388293` → "Too many blanks for the length of the message. Add more fixed words."; `2388299` → "The message cannot start or end with a blank."; code `80008` or retryable → "WhatsApp is busy. Wait a few minutes and try again."; `delivery === "unknown"` → "WhatsApp did not answer. Nothing was lost. Check the list in a minute before trying again."; codes `190`, `10`, `200`, `299` → "WhatsApp would not let us in. The connection needs fixing by the technical lead."; otherwise `details.userMessage ?? message`, prefixed "WhatsApp refused this: ". Always keep Meta's code and message in `last_error` after the sentence, in brackets: "… (Meta 100/2388299)".

### 5.3 Webhook wiring — `packages/domain/src/inbox/whatsapp-ingest.ts`

In `ingestWhatsAppPayload`, before `if (change.field !== "messages") continue;` add:
```ts
if (TEMPLATE_WEBHOOK_FIELDS.includes(change.field ?? "")) {      // the three fields in 3.5
  const known = entry.id ? await wabaIsOurs(db, entry.id) : false;   // any inbox_phone_number.waba_id = entry.id
  if (known) {
    const r = await applyTemplateWebhook(db, entry.id!, change.field!, (change.value ?? {}) as Record<string, unknown>, entryTime(entry));
    if (r.applied) result.templatesUpdated++;
    if (r.resync) result.templateResyncWabas.push(entry.id!);
  }
  continue;
}
```
Add `time?: number` to the entry type, `templatesUpdated: number` and `templateResyncWabas: string[]` to `IngestResult` (initial `0`, `[]`). `entryTime` = `new Date(entry.time * 1000)` or now. Events for a WABA we do not hold are marked processed and ignored.

In `processStoredWhatsAppEvent` (API) and `retryWebhookEvents` (worker), after the transaction commits: for each distinct WABA in `templateResyncWabas`, call `syncTemplatesForWaba(db, cfg, waba)` inside try/catch (log on failure; the hourly sync will catch up). The webhook still answers 200 first-time: do the resync without awaiting it in the API route (`void … .catch(log)`).

### 5.4 Routes — `apps/api/src/routes/templates.ts`, mounted in `test-app.ts` as `app.route("/v1/templates", templateRoutes(db))`

Every route: `requireAuth()`, `requireCapability("templates.manage")`. `:id` is `inbox_template.id` (bad uuid or unknown → 404). Meta errors map as: `explainTemplateError(err)` in `error.message`; HTTP 502 when `delivery === "unknown"` or retryable, 409 otherwise, with `details.meta_code`, `details.meta_subcode`. Configuration errors (`190`, `10`, `200`, `299`) also raise the `inbox.meta_config` owner alert defined in spec 05 section 5.3 (create it here if 05 is not merged).

Row → JSON (`TemplateDto`), used by every route:
```json
{ "id": "", "waba_id": "", "name": "", "language": "en", "category": "UTILITY", "status": "DRAFT",
  "components": [], "meta_template_id": null, "quality_score": null, "rejected_reason": null, "review_info": null,
  "correct_category": null, "previous_category": null, "category_change_at": null, "status_changed_at": null,
  "draft": null, "draft_updated_at": null, "draft_updated_by_name": null, "submitted_at": null, "last_error": null,
  "edits_left": null, "editable": true, "not_editable_reason": null, "system_use": null, "starter_key": null, "synced_at": "" }
```
`edits_left` = `editsLeft(meta_edit_times, now)` when status is APPROVED, else null. `editable` is false when: status is `PENDING`, `IN_APPEAL`, `DISABLED`, `PENDING_DELETION`, `DELETED`, `ARCHIVED`, `LIMIT_EXCEEDED`; or `review_info.locked`; or status is not `DRAFT` and `componentsToDraft(components, category)` is null. `not_editable_reason` wording in 7.2. `system_use` is `"missed_call"` when `name === "missed_call_followup"` (constant `SYSTEM_TEMPLATES` in the route file), else null.

| Route | Request | Does | Audit |
|---|---|---|---|
| `GET /` | — | All rows except `DELETED`, ordered by name then language. `{ data: TemplateDto[] }` | — |
| `GET /options` | — | `{ data: { accounts: [{ waba_id, label }], languages: TEMPLATE_LANGUAGES, limits: TEMPLATE_LIMITS, sample_upload_ready: !!env.META_APP_ID, starter: [{ key, name, title, category, exists }] } }`. `accounts` = distinct `waba_id` of active WhatsApp numbers, label = the numbers' labels joined with ", " | — |
| `GET /:id` | — | One `TemplateDto` | — |
| `POST /` | `{ waba_id, name, language, draft }` | Validate `waba_id` is ours, `validateTemplateName`, language in `TEMPLATE_LANGUAGES`, `draft` parses (zod schema mirroring `TemplateDraft`; **problems from `validateDraft` do not block saving a draft**). If a row with that key exists and is not `DELETED` → 409 "A template with this name and language already exists." If it exists and is `DELETED`, reuse the row. Insert `status: 'DRAFT'`, `components: []`, `category: draft.category`, `created_by`, `draft_updated_*`. 201 | `template.draft_create` |
| `PUT /:id/draft` | `{ draft, draft_updated_at }` | Refuse (409, the reason) when not `editable`. If the row's `draft_updated_at` is not null and differs from the one sent → 409 `details.reason: "changed_elsewhere"`, "Someone else changed this draft. Reload to see their version." Save `draft`, `draft_updated_at = now`, `draft_updated_by`; on a `DRAFT` row also `category = draft.category`. Name and language cannot change after creation | `template.draft_save` (`notify: false`) |
| `DELETE /:id/draft` | — | On a Meta-known row: set `draft`, `draft_updated_*` to null. On a `DRAFT` row: 400 "Delete the draft instead." | `template.draft_discard` |
| `POST /:id/sample` | `{ filename, content_type, size_bytes }` | Presign an R2 PUT under `inbox/template-samples/YYYY/MM/<uuid>.<ext>` (new `presignTemplateSamplePut` in `apps/api/src/lib/r2.ts`; allowed: `image/jpeg`, `image/png` ≤ 5 MB; `video/mp4`, `application/pdf` ≤ 16 MB; other types → 400 "Use a JPG or PNG picture, an MP4 video or a PDF."). `{ data: { upload_url, object_key } }` 201 | — |
| `GET /:id/sample-url` | — | `presignInboxGet(draft.header.sampleKey)` for the preview. 404 when there is none | — |
| `POST /:id/submit` | `{ draft_updated_at, accept_warnings: boolean }` | Section 5.5 | `template.submit` |
| `POST /:id/refresh` | — | Meta-known row: `getTemplate` → `applyMetaTemplate`. `DRAFT` row: 400. Returns the dto | — |
| `POST /:id/delete` | `{ confirm_name }` | Section 5.6 | `template.delete` |
| `POST /sync` | — | `syncTemplatesForWaba` for every WABA. `{ data: { synced } }` | `inbox.templates_sync` |
| `POST /starter` | `{ waba_id, keys: string[] }` | For each key in `STARTER_TEMPLATES` not already present (same name + language, not DELETED): insert a `DRAFT` row with its draft and `starter_key`. `{ data: { created: [names], skipped: [names] } }` | `template.starter_add` |

Audit: `writeAudit(db, c, { action, entityType: "inbox_template", entityId: id, before, after, notify: true })` unless stated. For submit and delete, `after` includes name, language, category, the components sent, and Meta's answer.

Existing routes in `inbox.ts`: `GET /v1/inbox/templates` adds `where status <> 'DRAFT'` (so the picker and older apps never see drafts); `POST /v1/inbox/templates/sync` calls the new domain `syncTemplatesForWaba`; delete the local copy of that function. `sendFromConversation` already refuses anything not `APPROVED`; no change.

### 5.5 Submit (create or edit) — exact order

1. Load the row. `draft` null → 400 "There is nothing to send. Make a change first." `draft_updated_at` mismatch → 409 `changed_elsewhere`.
2. `problems = validateDraft(draft, { name, others })`. Any `error` → 400 `validation_failed`, `details.problems`. Any `warning` and `accept_warnings` not true → 400 `details.reason: "warnings"`, `details.problems`.
3. Decide the mode: `DRAFT` → **create**; `APPROVED`, `REJECTED`, `PAUSED` → **edit**; anything else → 409 with the `not_editable_reason`.
4. Edit of an `APPROVED` row: `editsLeft(...)`; `today === 0` → 409 "WhatsApp allows one change a day to an approved template. Try again after {time, Lagos}."; `month === 0` → 409 "WhatsApp allows 10 changes in 30 days to an approved template. The next one is possible on {date}." Edit of an `APPROVED` row with `draft.category !== category` → 400 "The type of an approved template cannot be changed. Make a new template instead."
5. Media heading: `META_APP_ID` missing → 503 "Sample upload is not set up on this server yet."; load the bytes with `templateDeps.loadSample(sampleKey)` (default: `fetch(await presignInboxGet(key, { expiresIn: 120 }))`; `export const templateDeps = { loadSample }` so tests can replace it); `handle = uploadFileToMeta(cfg, appId, { bytes, mimeType: sampleMime, fileName: sampleName })`.
6. `components = draftToComponents(draft, handle)`.
7. Mark the attempt: `submitted_by`, `submitted_at = now`, `last_error = null`.
8. **Create:** `createTemplate(...)`. On success set `meta_template_id`, `status` (Meta's), `category` (Meta's, upper-case), `components` (what we sent), `parameter_format = 'POSITIONAL'`, `status_changed_at = now`, `draft = null`, `draft_updated_* = null`. Then read back with `getTemplate` and `applyMetaTemplate` (failure of the read-back is logged, not an error). If Meta's category differs from the one asked for, include `data.notice: "WhatsApp filed this under Marketing instead of Order and account updates."`.
   **Edit:** `editTemplate(id, { components, category only when status is not APPROVED and it differs })`. On success: when the row was `APPROVED`, append now to `meta_edit_times` (trim to 30 days); set `components`, `draft = null`; read back with `getTemplate` → `applyMetaTemplate`; if the read-back fails, set `status = 'PENDING'`.
9. On `MetaApiError` with `delivery === "unknown"` (create only): `findTemplateByName(...)`. Found → treat as success (step 8 with its id and status). Not found → `last_error`, row stays `DRAFT`, 502.
10. On any other failure: `last_error = explainTemplateError(err)`, `draft` kept, status unchanged; respond per 5.4.
11. Respond 200 `{ data: TemplateDto, notice? }`.

Two submits at once: wrap steps 1 to 7 in a transaction with `select … for update` on the row and refuse a second submit while `submitted_at` is under 60 seconds old and the row is still `DRAFT` with no `last_error`: 409 "This template is already being sent. Wait a moment."

### 5.6 Delete — exact order

1. `confirm_name` must equal the row's `name` → else 400 "Type the template's name exactly to delete it."
2. `DRAFT` row: set `status = 'DELETED'`, `draft = null`. No Meta call. Done.
3. `DISABLED` → 409 "WhatsApp does not allow a switched-off template to be deleted."
4. `deleteTemplate(cfg, waba, { id: meta_template_id, name })` (one language only). No `meta_template_id` (an old row never re-synced) → run `syncTemplatesForWaba` once, then retry; still none → 409 "Press Sync first, then try again."
5. Success → `status = 'DELETED'`, `draft = null`, `status_changed_at = now`. Failure → `last_error`, per 5.4.

## 6. Worker

`apps/worker/src/inbox-loop.ts` and `jobs/inbox-whatsapp.ts`:

| Job | Every | Does | Lock / retry |
|---|---|---|---|
| `inbox_template_sync` (existing) | 60 min | Now calls domain `syncTemplatesForWaba` per WABA (delete the worker's own copy of the upsert and the "gone" logic) | `withJobLock`; a failure is logged and tried next hour |
| `inbox_template_pending` (new) → `refreshPendingTemplates(db, log)` | 5 min | Rows with `status in ('PENDING','IN_APPEAL')` and `meta_template_id` not null, oldest `synced_at` first, max 20: `getTemplate` → `applyMetaTemplate`. Also rows with `category_change_at < now()` and `correct_category` not null (the change is due): same refresh. A status that moved to `REJECTED` here raises the same owner alert as the webhook would | `withJobLock`; stop the run on a retryable `MetaApiError` (rate limit) and try next tick; a `not_sent` refusal for one template is logged and skipped |

No job ever submits, edits or deletes a template (foundation rule 7).

## 7. Screens

Files in `apps/suite/src/features/templates/`:

| File | What |
|---|---|
| `templates-api.ts` | Calls for 5.4; keys `templateKeys.list = ["templates","list"]`, `.one(id)`, `.options` |
| `TemplatesPage.tsx` | Page frame with a tab bar: "Messages" (this spec) and a slot for "Forms" (spec 07 adds it; build the tab bar now with one tab) |
| `TemplateList.tsx` | The list |
| `TemplateEditorPage.tsx` | Write and edit |
| `TemplatePreview.tsx` | Phone-style preview |
| `TemplateChecks.tsx` | The "Before you send" panel |
| `SubmitDialog.tsx`, `DeleteTemplateDialog.tsx`, `StarterSetDialog.tsx`, `NewTemplateDialog.tsx` | Dialogs |
| `template-labels.ts` (+ `.test.ts`) | Pure wording maps from 7.2 |

Routes in `apps/suite/src/router.tsx`: `/templates` → `TemplatesPage`; `/templates/$templateId` → `TemplateEditorPage`. Menu in `SuiteShell.tsx`, section "Set-up", above Settings: `{ to: "/templates", label: "Templates and forms", Icon: LayoutTemplate, cap: "templates.manage" }` (widen `NavItem["to"]`; add to the nav test). Add `"templates.manage"` to `CAPABILITIES` and `ADMIN_CAPS` (not managers). In `apps/admin/src/components/inbox/SettingsNumbers.tsx` (`SettingsTemplates`), change the helper line to "Templates are written and sent for approval under Templates and forms in the Business Suite. Sync brings the latest here." (both apps show it).

### 7.1 List (`/templates`, tab "Messages")

Header buttons: "New template" (primary), "Add starter set", "Sync from WhatsApp". Intro line: "Templates are the only messages WhatsApp lets you send after a customer has been quiet for 24 hours. WhatsApp checks each one before you can use it, usually within a few minutes and at most a day."

Filter chips: "All", "Drafts", "Waiting", "Approved", "Needs attention" (REJECTED, PAUSED, DISABLED, FLAGGED, quality RED, a pending category change, or `last_error`).

Each row (a card at 390 px): name shown with `humanTemplateName` and the raw name in small grey; language label; type pill ("Order and account updates" for UTILITY, "Marketing", "Login codes" for AUTHENTICATION); status pill (7.2); quality (7.2, approved only); first 90 characters of the body; a line of small notes, any that apply: "Changes not sent yet" (`draft` on a Meta row), "Used for missed-call messages" (`system_use`), "WhatsApp will re-file this as Marketing on {date}" (`correct_category`), the `last_error` in red. Row click opens the editor.

States: loading and error via `DataState`; empty: title "No templates yet", hint "Start with the starter set. It has the messages most shops need.", button "Add starter set". No permission: the menu item is hidden; the address shows "You do not have access to templates. Ask the owner to give your account the 'Templates' permission."

### 7.2 Wording maps (`template-labels.ts`)

| Status | Pill (colour) | Line under it |
|---|---|---|
| `DRAFT` | "Draft" (grey) | "Only in the suite. Not sent to WhatsApp yet." |
| `PENDING` | "Waiting for WhatsApp" (amber) | "WhatsApp is checking it. This can take up to a day." |
| `APPROVED` | "Approved" (green) | "Ready to send." |
| `REJECTED` | "Refused" (red) | reason wording below, then "Change it and send it again." |
| `PAUSED` | "Paused" (amber) | "Customers reacted badly, so WhatsApp paused it for a few hours. It will come back by itself." |
| `DISABLED` | "Switched off" (red) | "WhatsApp switched it off for good. Write a new one with different wording." |
| `IN_APPEAL` | "Under appeal" (amber) | "WhatsApp is looking at it again." |
| `LIMIT_EXCEEDED` | "Over the limit" (red) | "You have too many templates. Delete ones you do not use." |
| `ARCHIVED` | "Archived" (grey) | "Not used for a year. WhatsApp deletes it 28 days after archiving." |
| `PENDING_DELETION` | "Being deleted" (grey) | "" |
| anything else | the raw value (grey) | "" |

Refusal reasons: `INVALID_FORMAT` "The layout breaks one of WhatsApp's rules, for example a blank at the start or end, two blanks side by side, or a missing example."; `ABUSIVE_CONTENT` "WhatsApp found wording it treats as abusive or threatening."; `PROMOTIONAL` "WhatsApp says the wording breaks its rules on promotions."; `SCAM` "WhatsApp thinks customers could mistake this for a scam."; `INCORRECT_CATEGORY`, `TAG_CONTENT_MISMATCH` "The wording does not match the type you chose."; other or none: "WhatsApp did not give a reason." When `review_info.rejection.recommendation` exists, add "WhatsApp's advice: {recommendation}".

Quality: `GREEN` "Customers like it" (green); `YELLOW` "Some customers are blocking or ignoring it" (amber); `RED` "Many customers are blocking or ignoring it. It may be paused" (red); `UNKNOWN` / null "Not rated yet" (grey).

`not_editable_reason`: PENDING / IN_APPEAL "WhatsApp is checking this template. You can change it once it has decided."; DISABLED "This template is switched off for good and cannot be changed."; locked "WhatsApp has locked this template."; cannot be opened "This template has a part the suite cannot edit yet ({templateNeeds reason}). Change it in WhatsApp Manager."; ARCHIVED / PENDING_DELETION / LIMIT_EXCEEDED "This template cannot be changed in its current state."

### 7.3 New template dialog

Title "New template". Fields: "WhatsApp account" (select; hidden when there is one), "Name" (input; helper "Lowercase letters, numbers and underscores. Customers never see this. Example: order_confirmed"; the input lowercases and turns spaces into underscores as you type), "Language" (select, default English), "Type" (two radio cards): **"Order and account updates"** — "For a specific customer about something they did: an order, a payment, a delivery, a missed call. No selling." and **"Marketing"** — "News, offers, new flavours, reminders to buy. Customers can switch these off, and WhatsApp limits how many each person gets." Below: "Login codes are a third type. The suite does not create those." Buttons "Create draft", "Cancel". On success go to the editor.

### 7.4 Editor (`/templates/$templateId`)

Frame title: the human name; crumb "Templates and forms". Top strip: status pill and line (7.2); for APPROVED the note "You can change an approved template once a day and 10 times in 30 days. Changes left this month: {n}."; an amber banner when `last_error`; an amber banner "WhatsApp will move this to Marketing on {date}. If you think that is wrong, ask for a review in WhatsApp Manager within 60 days." when `correct_category` is set; a grey banner with the `not_editable_reason` when not editable (the form is then read-only).

Two columns on desktop (form left, preview and checks right, sticky); one column at 390 px with a "Preview" button that opens the preview in a sheet.

Form sections, in order:

1. **"Type"** — the two radio cards from 7.3. Disabled with the note "The type of an approved template cannot be changed." when status is APPROVED.
2. **"Heading (optional)"** — radio: "None", "Text", "Picture", "Video", "PDF document". Text: input, counter "/60", helper "One line above the message. You may use one blank: {{1}}."; when it has a blank, an "Example for {{1}}" input. Media: a file picker "Choose a sample" with helper "WhatsApp needs a sample to check. Each time you send this template you will attach the real file." (picture: JPG or PNG up to 5 MB; video: MP4 up to 16 MB; PDF up to 16 MB); the chosen sample shows as a thumbnail or a file name with "Replace".
3. **"Message"** — text area, 8 rows, counter "/1024", button "Add a blank" (inserts the next `{{n}}` at the cursor), helper "Write it as you would say it. Use a blank where something changes for each customer, like their name or order number."
4. **"Examples for the blanks"** — one input per blank, labelled "{{1}} for example", placeholder from position: 1 "Ada", others "MS-10482". Helper: "Give a realistic example for each blank. Use made-up details, never a real customer's."
5. **"Small print (optional)"** — input, counter "/60", helper "Grey text under the message, for example your shop name."
6. **"Buttons (optional)"** — list with "Add a button" menu: "Reply button" (label only; helper "The customer taps it to answer in one touch."), "Link button" (label, link, and "Example for the end of the link" when the link ends in `{{1}}`; helper "Opens a web page. The link may end with one blank, for example https://www.mrssamuel.com/order/{{1}}"), "Call button" (label, phone number). Each row has "Remove" and up/down arrows. The menu greys out a kind that has reached its limit with the reason ("Two links at most", "One phone number at most", "Ten buttons at most").

Bottom bar (sticky): "Save draft" (ghost; disabled until something changed; saves with `PUT /draft`; toast "Draft saved."), "Send to WhatsApp for approval" (primary; label "Send changes to WhatsApp" when editing a Meta row), "Discard changes" (only on a Meta row with a draft; confirm "Throw away your unsent changes?"), and a "Delete" link in red on the far side. The editor saves the draft automatically 2 seconds after the last keystroke and shows "Saved just now" / "Saving…" beside the buttons. A 409 `changed_elsewhere` on save shows a banner "Someone else changed this draft." with a "Reload" button and stops auto-saving.

**Preview (`TemplatePreview`)**: a WhatsApp-like bubble on the chat background: the media sample or a grey block labelled "Picture" / "Video" / "PDF", bold heading, the message with blanks filled from the examples (unfilled blanks highlighted amber), grey small print, a time, then the buttons as rows (reply buttons, link with an arrow icon, phone with a phone icon; more than three shows two and "See all options"). Caption: "A preview. WhatsApp may draw it slightly differently."

**Checks (`TemplateChecks`)**, title "Before you send": a list built from `validateDraft`: errors with a red dot, warnings with an amber dot, each with its message; when there are none: a green tick and "Nothing here should get it refused." Below, always, a collapsible "What WhatsApp refuses most often" with these lines: "A blank at the very start or end of the message." / "Two blanks side by side." / "More blanks than words." / "No example for a blank." / "Selling words in an order update." / "The same wording as another template." / "Threats, insults, or anything that looks like a scam." / "Asking for card numbers, bank PINs or other private details."

### 7.5 Submit dialog

Opens only when there are no errors. Title "Send this template to WhatsApp?" Body: the preview again; a table "Name", "Language", "Type"; then "WhatsApp will check it. Most are decided in minutes; it can take up to a day. You cannot change it while it is being checked." For an approved template: "This uses your one change for today ({n} left this month). The template stays usable while WhatsApp checks the new wording." If there are warnings: the list, and a checkbox "I have read these and want to send it anyway" that must be ticked. Buttons "Send to WhatsApp", "Go back". Sending: "Sending…".

Results: success → close, toast by returned status: PENDING "Sent. WhatsApp is checking it."; APPROVED "Approved. It is ready to use."; REJECTED "WhatsApp refused it straight away. See the reason on the page." `notice` shows as an amber banner. Failure → the dialog stays, the server's message in red.

### 7.6 Delete dialog

Title "Delete this template?" Body by case — draft: "This draft exists only in the suite. Deleting it cannot be undone."; Meta template: "This removes “{name}” ({language}) from WhatsApp. Messages already on their way are still delivered. You cannot reuse this name for 30 days."; `system_use`: extra red line "The suite uses this template to message customers whose calls were missed. Those messages will stop until a new one with the same name is approved." Input "Type the name to confirm". Buttons "Delete template" (red; disabled until the name matches), "Keep it".

### 7.7 Starter set dialog

Title "Add the starter set". Text: "These are drafts written for Mrs. Samuel Fruit Juice. Read each one, change the wording if you like, then send it to WhatsApp." A checklist of the seven (section 7.8) with title, type and body; those that already exist are disabled with "Already added". Account select when there is more than one. Buttons "Add as drafts", "Cancel". Toast: "{n} drafts added."

### 7.8 The starter set (`packages/shared/src/template-starter.ts`, `STARTER_TEMPLATES`)

All language `en`, category `UTILITY`, positional blanks. Each is written to Meta's rules in section 3: no blank at the start or end, words between blanks, an example for each, nothing promotional, and it concerns a specific customer action.

| key / name | Title in the dialog | Body | Examples | Footer | Buttons |
|---|---|---|---|---|---|
| `conversation_reopen` | "Re-open a chat" | `Hello {{1}}, this is Mrs. Samuel Fruit Juice. We are following up on your recent message to us. Please reply here so we can continue helping you.` | Ada | (none) | Reply: `Continue chat` |
| `order_confirmed` | "Order confirmed" | `Hello {{1}}, thank you for your order. We have received order {{2}} and the total is {{3}}. We will message you again when it is on its way.` | Ada · MS-10482 · N12,500 | `Mrs. Samuel Fruit Juice` | Link: `View order` → `https://www.mrssamuel.com/order/{{1}}`, example `MS-10482` |
| `order_out_for_delivery` | "Out for delivery" | `Hello {{1}}, your order {{2}} has left our shop and is on its way to you. Our rider will call you when they arrive, so please keep your phone close.` | Ada · MS-10482 | `Mrs. Samuel Fruit Juice` | Link: `View order` → same link and example |
| `order_delivered` | "Delivered" | `Hello {{1}}, your order {{2}} has been delivered. Thank you for choosing Mrs. Samuel Fruit Juice. If anything is not right with this order, reply to this message and we will sort it out.` | Ada · MS-10482 | (none) | Reply: `There is a problem` |
| `missed_call_followup` | "Missed call" | `Hello {{1}}, we are sorry we missed your call to Mrs. Samuel Fruit Juice. Please reply here to tell us how we can help, or tell us a good time to call you back.` | Ada | (none) | Reply: `Call me back` |
| `payment_reminder` | "Payment reminder" | `Hello {{1}}, this is a reminder about order {{2}}. We have not yet received the payment of {{3}}. Please pay with the link we sent you, or reply here if you need help. We will hold the order until {{4}}, then release it.` | Ada · MS-10482 · N12,500 · 6pm today | `Mrs. Samuel Fruit Juice` | (none) |
| `preorder_ready` | "Pre-order ready" | `Hello {{1}}, your pre-order {{2}} is ready. You can collect it at {{3}} during our opening hours. Please reply here if you would like us to deliver it instead.` | Ada · PO-2291 · our Lekki shop | (none) | Reply: `Deliver it instead` |

Notes for the implementer: the examples use "N12,500", not the naira sign, to keep the samples plain; real sends may use "₦". `missed_call_followup` must keep **exactly one** body blank: `sendMissedCallFollowups` in `apps/worker/src/jobs/inbox-voice.ts` sends one value (the first name, or "there"). `conversation_reopen` is the one most likely to be re-filed by Meta as Marketing, because it does not name an order; that is acceptable and the screen will show it.

## 8. Rules and edge cases

1. A `DRAFT` row is never returned by `GET /v1/inbox/templates` and can never be sent.
2. The unique key `(waba_id, name, language)` holds for drafts too: creating a draft whose key exists is refused, except over a `DELETED` row, which is reused.
3. Sync never changes `draft`, never marks a `DRAFT` row `DELETED`, and never creates a second row for a template that a draft already names.
4. Name and language are fixed once the row exists. To rename, make a new template.
5. Only `validateDraft` errors block a submit; warnings need `accept_warnings: true`. Saving a draft is never blocked by problems.
6. The server re-runs `validateDraft`; the browser's result is not trusted.
7. An approved template: at most one successful edit per 24 hours and 10 per 30 days, counted from `meta_edit_times`. Edits made in WhatsApp Manager are not counted here; if Meta refuses for that reason its message is shown.
8. The category of an approved template cannot change. A refused or paused one can.
9. A media heading is uploaded to Meta again on every submit; the sample stays in R2 under `inbox/template-samples/`.
10. Create that times out: look the template up by name; adopt it if Meta has it; otherwise the draft stays and the message says nothing was lost.
11. A duplicate-name refusal (`2388024`) never overwrites the local draft.
12. Meta's answer to a create may carry a different category; the row takes Meta's category and the response carries the notice.
13. Webhook events are matched by Meta's template ID first, then by name and language with `-` turned into `_`.
14. A status event older than the row's `status_changed_at` does not change the status (replays are safe).
15. A template webhook for a WABA we do not hold is ignored and marked processed.
16. An event for a template we do not have triggers one sync of that WABA after the transaction.
17. Owner alerts: at most one per template per kind per 24 hours.
18. Delete removes one language only (`hsm_id` + `name`), never every language of a name.
19. A `DISABLED` template cannot be deleted; the suite says so without calling Meta.
20. Deleting `missed_call_followup` is allowed but shows the extra warning.
21. A template the editor cannot represent (named blanks, carousel, login code, …) opens read-only with the reason; its status and quality are still tracked.
22. Two people on one draft: the second save gets `changed_elsewhere`.
23. Two submits at once: the second is refused (5.5).
24. Sample files: type and size are checked at presign; at submit the first bytes are checked again (JPEG, PNG, `%PDF`, MP4 `ftyp` at offset 4); a mismatch → 400 "That sample file is not what it says it is. Choose it again."
25. Times on screen are Lagos time (D12).
26. No template is ever submitted, edited or deleted without a signed-in person pressing the button and confirming.
27. The token never appears in a response, the audit log, `last_error` or a log line.

## 9. Tests

`packages/shared/src/template-draft.test.ts`
- `name: accepts order_confirmed, refuses capitals, spaces and 61 characters`
- `blanksIn finds numbers in order and ignores named blanks`
- `validateDraft: one test per code in the table in 5.1` (22 tests, named `validateDraft flags <code>`)
- `validateDraft: every starter template has no errors and no warnings`
- `draftToComponents: text heading with a blank, media heading with a handle, body examples nested, footer, buttons in order`
- `draftToComponents leaves out example when there is no blank and builds the full link example`
- `componentsToDraft round-trips what draftToComponents made`
- `componentsToDraft returns null for a carousel, a named blank and an authentication template`
- `editsLeft: none used, one today, ten in the month, drops entries older than 30 days`
- `normaliseTemplateLanguage turns en-US into en_US`

`packages/shared/src/template-starter.test.ts`
- `every starter body obeys the blank rules and is under 1024 characters`
- `missed_call_followup has exactly one blank`

`packages/domain/src/meta/templates.test.ts` (stubbed fetch; pure parts)
- `createTemplate posts name, language, upper-case category, POSITIONAL and components`
- `deleteTemplate sends hsm_id and name`
- `listTemplatesFull falls back to the short field list on code 100`
- `explainTemplateError maps each subcode, a timeout and a token error`

`apps/suite/src/features/templates/template-labels.test.ts`
- `every status, refusal reason and quality value has wording; unknown values fall back`

`apps/api/test/integration/templates.test.ts` (set-up as `inbox-whatsapp.test.ts`; Graph stub keyed by URL and method)
- `every route needs templates.manage`
- `create draft; duplicate key refused; a DELETED key is reused`
- `save draft detects a change made elsewhere`
- `submit: errors block, warnings need accept_warnings`
- `submit create: sends the right payload, stores Meta's id, status and category, clears the draft, audits`
- `submit create: Meta files it as MARKETING and the response carries the notice`
- `submit create with a picture heading uploads the sample and puts the handle in the payload` (replace `templateDeps.loadSample`)
- `submit create: a timeout adopts the template when Meta has it, keeps the draft when it does not`
- `submit create: duplicate name keeps the draft and explains`
- `submit edit of an approved template records the edit and refuses a second one the same day`
- `submit edit refuses a category change on an approved template`
- `delete: wrong name refused; draft deleted without a Meta call; Meta template deleted by hsm_id and name; DISABLED refused`
- `starter: adds seven drafts once, skips them the second time`
- `GET /v1/inbox/templates hides drafts`
- `sync keeps drafts, adopts a Meta template onto a draft row keeping its draft, marks vanished Meta templates DELETED`

`apps/api/test/integration/template-webhooks.test.ts`
- `status APPROVED / REJECTED (with rejection_info) / PAUSED / DISABLED update the row`
- `matches by name and language when the id is unknown, with en-US normalised`
- `an older event does not undo a newer status`
- `quality update to RED sets quality and raises one alert, not two`
- `category notice sets correct_category and the date; the done event changes the category`
- `an event for an unknown template triggers a sync; an event for an unknown WABA is ignored`
- `the same event twice changes nothing the second time`

`apps/worker` test `inbox-template-pending.test.ts`
- `refreshes PENDING rows oldest first, at most 20, and stops on a rate limit`

## 10. Manual check

On the test WhatsApp account, signed in as an admin tester:

1. Confirm with Tes that the three webhook fields are subscribed (section 2). If not, do the check anyway; step 5 will take up to 5 minutes instead of seconds.
2. Templates and forms → Add starter set → add all seven. Seven drafts appear.
3. Open "Order confirmed". Type `50% off` into the message: the amber promotion warning appears. Remove it. Delete the example for {{2}}: a red error appears and the send button opens no dialog. Restore it.
4. Press Send to WhatsApp for approval, read the dialog, confirm. The status becomes "Waiting for WhatsApp".
5. Wait. The status changes to Approved (or Refused with a reason) without reloading for longer than a minute after Meta decides.
6. In the Inbox, open a test conversation → template picker: the approved template is there; drafts are not. Send it to a tester phone and check the link button opens the order page.
7. Make a new template with a picture heading: choose a PNG, write a body, send. In WhatsApp Manager, confirm the template shows the sample.
8. Edit the approved template's wording and send. Try a second edit: the "one change a day" message appears.
9. Create a throwaway draft and delete it. Create and submit a throwaway template, then delete it; confirm it has gone from WhatsApp Manager.
10. In WhatsApp Manager create a template by hand, then press Sync from WhatsApp: it appears in the suite.
11. Repeat steps 2 to 4 at 390 px wide.
12. Admin app → Audit log shows `template.submit` and `template.delete` rows with the components sent.

## 11. Done when

- [ ] Migration 0075, journal entry and Drizzle columns are in; `uq_inbox_template` is unchanged.
- [ ] All tests in section 9 pass; lint, type-check and the suite build are clean.
- [ ] The manual check passes on the test account.
- [ ] The one sync function lives in `packages/domain`; the copies in `inbox.ts` and the worker are gone.
- [ ] The pull request lists each [unverified] fact and what was found, in particular the `body_text` nesting and the URL example.
- [ ] The hand-off note for Tes names the three webhook fields to subscribe and `META_APP_ID`.

## 12. Out of scope

- **Parts the inbox cannot send:** location headings, copy-code buttons, login-code (authentication) templates, named blanks, carousels, limited-time offers, catalogue and product buttons, call-permission templates. Their rules are in section 3 for the day sending is added; such templates made in WhatsApp Manager are listed read-only.
- Form buttons (`FLOW`): spec 07 adds them to this editor.
- Translating one template into several languages in one step (create each language as its own template).
- Appeals and category-review requests (WhatsApp Manager only).
- Un-pausing by API, time-to-live settings, the template library, bulk delete.
- Broadcasts and automatic order messages that use these templates (blueprint stages 7 and 13).

## 13. Work order

1. Migration 0075, journal, Drizzle columns, `TemplateReviewInfo`. Build packages; run the migration in an integration test database.
2. If spec 05 is not merged: `graphRaw`, exported `graph`, `uploadFileToMeta`, `META_APP_ID`. Extend `MetaApiError` with `details`.
3. `packages/shared/src/template-draft.ts` with all its tests.
4. `packages/shared/src/template-starter.ts` with its tests.
5. `packages/domain/src/meta/templates.ts`: Meta calls, `applyMetaTemplate`, `syncTemplatesForWaba`, `explainTemplateError`, tests. Point `inbox.ts` and the worker at it; hide drafts in `GET /v1/inbox/templates`.
6. `applyTemplateWebhook`, the ingest hook, the resync after commit, the owner alert case; `template-webhooks.test.ts`.
7. Worker job `inbox_template_pending` and its test.
8. Permission `templates.manage`; routes list / options / get / create / save draft / discard / refresh / sync / starter; tests.
9. Sample presign and URL routes; submit (create, then edit); delete; tests.
10. Suite: api file, labels, list page with tabs, menu and routes.
11. Suite: new-template dialog, editor form, preview, checks, auto-save.
12. Suite: submit, delete and starter dialogs.
13. Manual check; pull request with the hand-off note.

## 14. Open questions

1. **`body_text` nesting and the URL button example** are not settled by Meta's current pages. Default: nested `[[…]]` and the full link, with the one retry in section 3.3.
2. **Should the editor offer copy-code buttons and location headings?** Meta supports them; the inbox cannot send them yet (`templateNeeds` refuses them). Default: leave them out until the send path is extended in a later task.
3. **Login-code templates.** The shop has no login codes on WhatsApp today. Default: not offered; listed read-only if someone makes one in WhatsApp Manager.
4. **Who may write templates?** Default: owner and admins (`templates.manage`); managers keep `inbox.templates` (send only).
5. **Foundation note:** the foundation's table for spec 06 lists only `work/olu/inbox-gaps` as a dependency, but media headings need the upload helper and `META_APP_ID` that spec 05 introduces. Default: whichever of 05 and 06 is built first creates them (task 2).
6. **Yoruba, Igbo and Pidgin are not template languages at Meta.** Default: English for everything; Hausa is available if wanted.
7. **Category review and appeals** can only be done in WhatsApp Manager. Default: the screen says so and links nowhere (no stable address is documented).

---

## Built differently

Departures made while building this spec on `work/olu/suite-06-templates` (stacked on spec 05 and the `work/olu/inbox-gaps` merge, 20 Nov 2026). Work-order task 13 (the manual check on a test account at desktop and 390 px, and the pull request) was not done: no Meta account or browser was available. Every **[unverified]** fact in section 3 is therefore still **unchecked**: the nesting of `body_text` (the nested form is sent first and the flat form once on code 100, the code decides nothing about which one worked), the full-link URL example, whether `header_handle` must be re-sent on edit (it always is), whether footers may hold blanks (they may not), and the `error_user_title` / `error_user_msg` fields. The migration and every integration test were run on a local Postgres 16 (not Docker), not in CI.

1. **Wording lives in `@ms/shared`** (`template-wording.ts`: status pills and lines, refusal reasons, quality, type names, `templateEditability`, the owner-alert sentences), not only in the suite's `template-labels.ts`, because the API (`not_editable_reason`) and the worker's alert need the same words. `template-labels.ts` re-exports them and adds the list's chips and notes.
2. **Submit holds its lock only for the checks.** Steps 1 to 4 and 7 (look, validate, decide create or edit, edit limits, mark the attempt) run in one transaction with `select … for update`. The sample upload and every Meta call run after it commits, so a transaction is never open across a call to Meta. Refusals before the mark (errors, warnings not ticked, edit limits, category change, no `META_APP_ID`) leave the row untouched; any failure after the mark writes `last_error`, so a retry is never blocked by the "already being sent" rule. That rule applies to `DRAFT` rows only, as the spec says.
3. **`templateDeps` also has `now`**, so tests move a fixed clock (edit limits count days). `GET /options` also returns `exists_in` (which accounts already have each starter), and `POST /starter` answers 200.
4. **`validateDraft` is slightly stricter than the table.** `blank_order` also fires when blanks first appear out of order (`{{2}}` before `{{1}}`); `example_missing` also covers a heading blank and a link's blank (with its own wording); the brace and named-blank checks also run on the heading (reported as `header_blanks`).
5. **`MetaApiError.details`** was already in the class (spec 01); `graph()` now fills it with `subcode`, `userTitle` and `userMessage` when Meta sends them.
6. **Owner alerts.** The template alert is written by `raiseTemplateAlert` in `packages/domain` (the webhook runs there, in its transaction, and the worker calls it too), with `payload.account = "<template id>:<kind>"` so it dedupes like the others; `alertOnce`'s type list gained `inbox.template_alert` but `alertOnce` itself is not used for it. A configuration refusal from the template screens uses `inbox.meta_config` with `area: "whatsapp_templates"`; `outbox.ts` has a branch for it that links to Templates.
7. **Sync and refresh also alert.** `applyMetaTemplate` raises the refused, paused or switched-off alert when it sees a real change of state (not a first sight of a row), so the hourly sync and the 5-minute job cover a missed webhook; the 24-hour rule stops a second alert.
8. **A webhook for a local draft that Meta now knows by name changes nothing** and asks for a sync, because writing a status onto a row with no components would put an unsendable template in the picker. The sync then adopts the draft with Meta's components and keeps its `draft`.
9. **`LOCKED` is cleared** when an `APPROVED`, `REJECTED` or `REINSTATED` event arrives (Meta sends no "unlocked" event).
10. **Sync does not mark a template `DELETED` if its status changed in the last five minutes** (Meta's list can lag a template that was just sent).
11. **`createTemplate` and `editTemplate` take `altComponents`** (the flat body-example shape) and retry once on code 100, except for subcodes that are settled refusals (duplicate name, limit, in review, too long, too many blanks, blank at the edge). `getTemplate` and `findTemplateByName` use the same short-field fallback as the list.
12. **`explainTemplateError`** checks "no answer" before "busy" (a timeout is also retryable), and puts Meta's own message in the brackets after the sentence for support, as `(Meta 100/2388299: …)`.
13. **A refused heading sample is refused before Meta is asked**: wrong type for the heading kind, too big, or first bytes that do not match (400 "That sample file is not what it says it is. Choose it again.").
14. **Screens.** "Send to WhatsApp for approval" stays pressable when there are errors and answers with a message instead of opening the dialog. The empty list also shows an "Add starter set" button. The editor saves before it opens the dialog. The "changes not sent" and "send changes" wording follow 7.4; the preview time is the Lagos time of the moment.
15. **`webhooks-whatsapp.ts` exports `settleTemplateResyncs()`** so a test can wait for the sync that follows a template event for an unknown template.
16. **Admin app.** `templates.manage` is in `GateEditor` (the per-user permission screen) and has a test in `permissions.test.ts`; the Settings, Templates helper line was changed as the spec says.
17. **Existing test expectations:** none changed. The worker test for a refused read uses code 803, because code 100 on a single-template read makes `getTemplate` try the short field list first.
