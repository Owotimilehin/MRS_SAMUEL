# Suite build spec 05: WhatsApp business profile

Read `00-foundation.md` first. Size S. Suggested model: Sonnet. Permission: `channels.manage`. No migration.

Every Meta fact below is tagged **[verified: URL, 19 Nov 2026]** (read on that day) or **[unverified]** (from memory or inferred; read the page before coding against it).

---

## 1. Outcome

A staff member with the right permission can say:

- "I open **Channels**, pick our WhatsApp number, and see what customers see when they tap our name in WhatsApp: the photo, the 'about' line, our description, address, email, website and business type."
- "I change any of those, see a before-and-after list, press **Save to WhatsApp**, and the page then shows what WhatsApp really holds, read back from Meta."
- "I can replace the profile photo."
- "On the same page I see things I cannot change here: the display name and whether Meta approved it, the quality rating, how many people we may message a day, whether the number is connected, and whether a two-step PIN is set. A link takes me to WhatsApp Manager for those."

Nothing is stored in our database. Meta holds the profile; we read it each time the page opens.

## 2. Depends on

- **Specs:** none. If spec 01 is already merged, use its `/channels` page and its `channels.manage` permission instead of creating them (see tasks 1 and 8).
- **Branches:** none.
- **A person must do in Meta first:** nothing for the test number. For a real number, the number must be registered (it is, if it can send).
- **Server setting (new, not a secret):** `META_APP_ID`, the numeric ID of the Meta app "Mrs Samuel fruit juice". Needed only for the photo upload. Tes adds it to `/opt/mrs-samuel/.env` and to `docker-compose.yml` (`api` service). Without it everything works except the photo.

## 3. Meta reference

### 3.1 Business profile

| Fact | Status |
|---|---|
| Read: `GET /{phone-number-id}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`. Response: `{ "data": [ { about, address, description, email, messaging_product, profile_picture_url, websites: string[], vertical } ] }` | [verified: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles, 19 Nov 2026] |
| Write: `POST /{phone-number-id}/whatsapp_business_profile`, JSON body, `messaging_product: "whatsapp"` required. Success: `{ "success": true }` | [verified: same page, 19 Nov 2026] |
| `about`: optional; 1 to 139 characters; cannot be empty. Emoji are allowed as real characters. Links are not clickable; no Markdown | [verified: same page, 19 Nov 2026] |
| `address`: optional; max 256 characters | [verified: same page, 19 Nov 2026] |
| `description`: optional; max 512 characters | [verified: same page, 19 Nov 2026] |
| `email`: optional; valid email format; max 128 characters | [verified: same page, 19 Nov 2026] |
| `websites`: optional; array of strings; **at most 2**, each max 256 characters, each must start with `http://` or `https://` | [verified: same page, 19 Nov 2026] |
| `vertical`: optional; empty string or one of: `ALCOHOL`, `APPAREL`, `AUTO`, `BEAUTY`, `EDU`, `ENTERTAIN`, `EVENT_PLAN`, `FINANCE`, `GOVT`, `GROCERY`, `HEALTH`, `HOTEL`, `NONPROFIT`, `ONLINE_GAMBLING`, `OTC_DRUGS`, `OTHER`, `PHYSICAL_GAMBLING`, `PROF_SERVICES`, `RESTAURANT`, `RETAIL`, `TRAVEL` | [verified: same page, 19 Nov 2026] |
| `profile_picture_handle` (write only): the handle returned by the Resumable Upload API. `profile_picture_url` is read only | [verified: same page, 19 Nov 2026] |
| The profile cannot be deleted on its own; only by deleting the number | [verified: same page, 19 Nov 2026] |
| Fields left out of a POST are left unchanged | [unverified] The pages do not say. This spec therefore always sends every text field |
| `address`, `description`, `email` can be cleared by sending `""`; `websites` by sending `[]` | [unverified] |
| Photo rules: JPEG or PNG, square, at least 192 x 192 px (640 x 640 recommended), max 5 MB | [unverified] Meta's pages give no photo rules. These are our own limits |
| Permission: `whatsapp_business_management` on the system-user token | [unverified] The page says only "a system user access token with required permissions" (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-profiles.md) |
| Error `200` on this endpoint means no token was sent; `190` means the token is invalid or expired | [verified: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes, 19 Nov 2026] |

### 3.2 Resumable Upload API (for the photo)

| Fact | Status |
|---|---|
| Step 1: `POST /{app-id}/uploads?file_name=…&file_length=<bytes>&file_type=<mime>` returns `{ "id": "upload:<SESSION>" }` | [verified: https://developers.facebook.com/docs/graph-api/guides/upload, 19 Nov 2026] |
| Allowed `file_type`: `application/pdf`, `image/jpeg`, `image/jpg`, `image/png`, `video/mp4` | [verified: same page, 19 Nov 2026] |
| Step 2: `POST /upload:<SESSION>` with headers `Authorization: OAuth <token>` and `file_offset: 0`, body = the raw file bytes. Returns `{ "h": "<HANDLE>" }` | [verified: same page, 19 Nov 2026] |
| Resume: `GET /upload:<SESSION>` (same Authorization header) returns `file_offset`; POST again from that offset | [verified: same page, 19 Nov 2026] |
| The guide lists "a User access token" as the prerequisite | [verified: same page, 19 Nov 2026] |
| The system-user token is accepted in place of a user token | [unverified] If Meta refuses it, follow rule 12 in section 8 |

### 3.3 Number status (read only on this screen)

| Fact | Status |
|---|---|
| `GET /{phone-number-id}?fields=…` reads a number. `status` returns `CONNECTED` for a working number; a number must be connected to send and receive | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers.md, 19 Nov 2026] |
| Other `status` values (`PENDING`, `DISCONNECTED`, `FLAGGED`, `RESTRICTED`, `RATE_LIMITED`, `BANNED`, `MIGRATED`, `DELETED`, `UNVERIFIED`, `UNKNOWN`) | [unverified] The page sends you to the API reference, which does not list them |
| `verified_name` (the display name), `display_phone_number`, `quality_rating` (`GREEN`, `YELLOW`, `RED`, `NA`), `code_verification_status` (`VERIFIED`, `UNVERIFIED`) | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api, 19 Nov 2026] |
| `quality_rating` can also be `UNKNOWN` | [verified: phone-numbers.md above, 19 Nov 2026] |
| `name_status`: `APPROVED`, `AVAILABLE_WITHOUT_REVIEW`, `DECLINED`, `EXPIRED`, `PENDING_REVIEW`, `NONE`. Meta marks this field beta | [verified: phone-numbers.md above, 19 Nov 2026] |
| A pending name change is read with `fields=new_display_name,new_name_status` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names.md, 19 Nov 2026] |
| **The display name can be changed by API:** `POST /{phone-number-id}?new_display_name=<name>` returns `{ "success": true }`; the name then goes through Meta's review. Limit: 10 changes per 30 days. After approval the number must be registered again (`POST /{phone-number-id}/register` with the PIN) within 14 days or the name must be re-submitted. A number with Official Business Account status must go through Meta support | [verified: display-names.md above, 19 Nov 2026] |
| Messaging limit: read `whatsapp_business_manager_messaging_limit` on the number (example value `TIER_250`). `messaging_limit_tier` is **deprecated**. Limits are 250, 2,000, 10,000, 100,000 or unlimited people per 24 hours and are shared by all numbers in the business portfolio | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md, 19 Nov 2026] |
| Enum names other than `TIER_250` (`TIER_2K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`) | [unverified] |
| Two-step PIN: set with `POST /{phone-number-id}` body `{ "pin": "<6 digits>" }`. There is **no** documented way to read whether a PIN is set, and no endpoint to turn it off. Meta is retiring the PIN for eligible Cloud API numbers | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/two-step-verification.md, 19 Nov 2026] |
| Fields `is_pin_enabled` and `is_official_business_account` exist on the number | [unverified] Asked for in a separate, tolerant call (section 5.2) |
| WhatsApp Manager address for a number: `https://business.facebook.com/latest/whatsapp_manager/phone_numbers?waba_id=<waba-id>` | [unverified] If it does not open the right page, use `https://business.facebook.com/latest/whatsapp_manager` |

**Contradiction with the code and foundation:** `getNumberInfo()` in `meta.ts` and `inbox_phone_number.messaging_limit` use `messaging_limit_tier`, which Meta has deprecated. See section 14, item 1.

**App review:** none. The business's own number works with standard access.

## 4. Data

No migration. No new columns. Nothing about the profile is stored; the audit log keeps before and after of each change.

## 5. Server

### 5.1 Files

| File | Change |
|---|---|
| `packages/shared/src/permissions.ts` | Add `"channels.manage"` to `CAPABILITIES` (after `"inbox.reports"`) and to `ADMIN_CAPS`, if spec 01 has not already. Not in `MANAGER_CAPS` |
| `packages/shared/src/whatsapp-profile.ts` (new) + export from `packages/shared/src/index.ts` | Limits, the business-type list, validation. Browser-safe |
| `packages/domain/src/inbox/meta.ts` | `export` the existing `graph()` and add an optional 5th argument `opts?: { token?: string }` (D7), if spec 01 has not already. Add `graphRaw()` (5.2) |
| `packages/domain/src/meta/upload.ts` (new) | `uploadFileToMeta()` |
| `packages/domain/src/meta/whatsapp-profile.ts` (new) | Read and write the profile, read the status |
| `packages/domain/src/meta/index.ts` (new if missing) and `packages/domain/src/index.ts` | `export * from "./upload.js"; export * from "./whatsapp-profile.js";` and `export * from "./meta/index.js";` |
| `apps/api/src/env.ts` | `META_APP_ID: z.preprocess(emptyToUndef, z.string().regex(/^\d+$/).optional())` |
| `apps/api/src/routes/whatsapp-profile.ts` (new) | Routes in 5.4 |
| `apps/api/src/test-app.ts` | `app.route("/v1/whatsapp-profile", whatsappProfileRoutes(db));` beside the inbox routes |
| `docker-compose.yml` | `META_APP_ID: ${META_APP_ID:-}` on the `api` service |

### 5.2 Domain functions (exact signatures)

```ts
// packages/domain/src/inbox/meta.ts
/** Like graph(), for calls that are not JSON-in. Same error mapping (MetaApiError). */
export async function graphRaw<T>(
  cfg: MetaConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit | null; authScheme?: "Bearer" | "OAuth"; timeoutMs?: number },
): Promise<T>;
```

`graphRaw` builds the URL exactly as `graph` does, sends `authorization: ${authScheme ?? "Bearer"} ${cfg.token}` plus `init.headers`, uses `AbortSignal.timeout(init.timeoutMs ?? 15_000)`, and maps failures to `MetaApiError` with the same rules as `graph`. Refactor `graph` to call it; do not copy the error code.

```ts
// packages/shared/src/whatsapp-profile.ts
export const WA_PROFILE_LIMITS = { about: 139, address: 256, description: 512, email: 128, websites: 2, website: 256 } as const;
export const WA_PROFILE_PHOTO = { maxBytes: 5 * 1024 * 1024, minSide: 192, types: ["image/jpeg", "image/png"] } as const;
export const WA_VERTICALS: readonly { value: string; label: string }[]; // order and labels in section 7.3
export interface WaProfileFields {
  about: string; address: string; description: string; email: string; websites: string[]; vertical: string;
}
/** Trim every string; drop empty websites. */
export function normaliseWaProfile(input: WaProfileFields): WaProfileFields;
/** Field name -> plain-English problem. Empty object = valid. Wording in section 8. */
export function validateWaProfile(p: WaProfileFields): Partial<Record<keyof WaProfileFields, string>>;
/** Rows for the confirm dialog: only fields that differ. */
export function diffWaProfile(before: WaProfileFields, after: WaProfileFields): { field: keyof WaProfileFields; label: string; before: string; after: string }[];

// packages/domain/src/meta/upload.ts
/** Resumable Upload API: open a session, send the bytes in one POST, return the handle ("h"). */
export async function uploadFileToMeta(
  cfg: MetaConfig, appId: string,
  file: { bytes: Uint8Array; mimeType: string; fileName: string },
): Promise<string>;

// packages/domain/src/meta/whatsapp-profile.ts
export interface WaProfile extends WaProfileFields { profilePictureUrl: string | null }
export interface WaNumberStatus {
  displayPhoneNumber: string | null;
  displayName: string | null;          // verified_name
  nameStatus: string | null;           // name_status
  pendingName: string | null;          // new_display_name
  pendingNameStatus: string | null;    // new_name_status
  qualityRating: string | null;
  status: string | null;
  codeVerificationStatus: string | null;
  messagingLimit: string | null;       // whatsapp_business_manager_messaging_limit
  pinEnabled: boolean | null;          // null = Meta did not tell us
  officialAccount: boolean | null;     // null = Meta did not tell us
}
export async function getWaProfile(cfg: MetaConfig, phoneNumberId: string): Promise<WaProfile>;
export async function updateWaProfile(cfg: MetaConfig, phoneNumberId: string, fields: WaProfileFields): Promise<void>;
export async function setWaProfilePhoto(cfg: MetaConfig, phoneNumberId: string, handle: string): Promise<void>;
export async function getWaNumberStatus(cfg: MetaConfig, phoneNumberId: string): Promise<WaNumberStatus>;
```

Behaviour:

- `getWaProfile`: one GET with the field list in 3.1. Take `data[0]`; missing strings become `""`, missing `websites` becomes `[]`, missing `vertical` becomes `""`, and `vertical: "UNDEFINED"` or any value not in `WA_VERTICALS` is returned as is (the screen shows it as "Not set" but does not overwrite it unless staff change the field).
- `updateWaProfile`: one POST with body `{ messaging_product: "whatsapp", address, description, email, websites, vertical }` plus `about` **only when it is not empty** (Meta refuses an empty `about`). Throws if the answer is not `{ success: true }`.
- `setWaProfilePhoto`: POST `{ messaging_product: "whatsapp", profile_picture_handle: handle }`.
- `uploadFileToMeta`: step 1 through `graph(cfg, "POST", \`${appId}/uploads?file_name=${enc}&file_length=${n}&file_type=${enc}\`)`; step 2 through `graphRaw(cfg, "POST", sessionId, { authScheme: "OAuth", headers: { file_offset: "0", "content-type": "application/octet-stream" }, body: bytes, timeoutMs: 60_000 })`. If step 2 throws with `delivery === "unknown"`, do one `GET` on the session for `file_offset` and POST the remainder once; a second failure is thrown. If no `h` comes back, throw `MetaApiError("Meta returned no file handle", 502, null, true)`.
- `getWaNumberStatus`: **call A** `GET {id}?fields=display_phone_number,verified_name,name_status,new_display_name,new_name_status,quality_rating,status,code_verification_status,whatsapp_business_manager_messaging_limit`. **Call B** `GET {id}?fields=is_pin_enabled,is_official_business_account` inside try/catch: any `MetaApiError` with `delivery === "not_sent"` sets both to `null`. A and B run in parallel. If call A fails with code `100` (an unknown field), retry once with only `display_phone_number,verified_name,quality_rating,status,code_verification_status` and leave the rest `null`.

### 5.3 Error mapping (used by every route below)

| Meta result | HTTP | Body `error.message` (shown as is) |
|---|---|---|
| `metaConfigFromEnv()` is null | 503 `service_unavailable` | "WhatsApp is not set up on this server." |
| code `190`, or `10`, `200`, `299` | 409 `conflict`, `details.reason: "meta_config"` | "WhatsApp would not let us in. The connection needs fixing by the technical lead. (Meta code {code})" Also raise one owner alert per 24 h: insert `outbox_event` `eventType: "inbox.meta_config"`, `payload: { area: "whatsapp_profile", code }`, de-duplicated like `alertUnknownNumbers`; add a `case "inbox.meta_config"` to `apps/worker/src/outbox.ts` with the text "⚠️ *WhatsApp connection problem*\nMeta refused a request from the suite (code {code}, {area}). The access token or its permissions need checking." If spec 01 already added this alert, reuse it |
| retryable (`MetaApiError.retryable`) or `delivery: "unknown"` | 502 `bad_gateway`, `details.reason: "meta_unavailable"` | "WhatsApp did not answer. Nothing was changed for certain. Wait a minute, reload this page and check before trying again." |
| any other `MetaApiError` | 409 `conflict`, `details.reason: "meta_refused"`, `details.meta_code`, `details.meta_message` | "WhatsApp refused this change: {Meta's message}" |

### 5.4 Routes

All under `/v1/whatsapp-profile`, all `requireAuth()` then `requireCapability("channels.manage")`. `:numberId` is `inbox_phone_number.id` (uuid; a bad uuid or unknown id is 404 "not found"). A number with no `wa_phone_number_id` or `channels = 'voice'` is 400 "This number has no WhatsApp."

**GET `/`** → the WhatsApp numbers, for the index page.
`{ data: [{ id, label, e164, is_active }] }`, rows where `wa_phone_number_id is not null` and `channels <> 'voice'`, ordered by label. No Meta call.

**GET `/:numberId`** → profile and status, read live.
```json
{ "data": {
  "number": { "id": "…", "label": "Main line", "e164": "+234…", "waba_id": "…" },
  "profile": { "about": "", "address": "", "description": "", "email": "", "websites": [], "vertical": "", "profile_picture_url": null },
  "status": { "display_phone_number": null, "display_name": null, "name_status": null, "pending_name": null, "pending_name_status": null,
              "quality_rating": null, "status": null, "code_verification_status": null, "messaging_limit": null,
              "pin_enabled": null, "official_account": null },
  "photo_upload_ready": true,
  "manager_url": "https://business.facebook.com/latest/whatsapp_manager/phone_numbers?waba_id=…"
} }
```
`getWaProfile` and `getWaNumberStatus` run in parallel. `photo_upload_ready` is `!!env.META_APP_ID`. Side effect (keeps the existing Settings screen fresh, no Meta write): update `inbox_phone_number.wa_status`, `quality_rating`, `messaging_limit` from the status when the values are not null. Not audited (a read).

**PUT `/:numberId`** → save the text fields.
Request: `{ "profile": WaProfileFields, "expected": WaProfileFields }`. `expected` is what the browser loaded.
Steps, in order:
1. `normaliseWaProfile` both; `validateWaProfile(profile)`; any problem → 400 `validation_failed` with `details.fields` = the problem map.
2. `current = getWaProfile(...)`. If any of the six fields of `current` differs from `expected` → 409 `conflict`, `details.reason: "changed_elsewhere"`, `details.current: current`, message "This profile was changed somewhere else since you opened it. We have loaded the latest version. Check it and make your change again."
3. If `diffWaProfile(current, profile)` is empty → 200 with `data.changed: []` and no Meta write, no audit.
4. If `profile.about === ""` and `current.about !== ""` → 400, field `about`: "WhatsApp does not allow an empty 'about' line. Write a short line instead."
5. `updateWaProfile(...)`.
6. Read back: `after = getWaProfile(...)`. `mismatch` = fields where `after` differs from `profile`.
7. `writeAudit(db, c, { action: "whatsapp_profile.update", entityType: "inbox_phone_number", entityId: numberId, before: <six fields of current>, after: <six fields of after>, notify: true })`.
8. Respond 200 `{ data: { profile: after, changed: [field names], mismatch: [field names] } }`.

**POST `/:numberId/photo`** → replace the photo.
Request: raw body, the image bytes; header `content-type: image/jpeg` or `image/png`; optional header `x-file-name`. Route-level `bodyLimit({ maxSize: 5 * 1024 * 1024 })` → 413 "That picture is larger than 5 MB. Choose a smaller one."
Steps: (1) `META_APP_ID` missing → 503 "Photo upload is not set up on this server yet. Change the photo in WhatsApp Manager for now." (2) content type not in `WA_PROFILE_PHOTO.types` → 400 "Use a JPG or PNG picture." (3) check the first bytes really are JPEG (`FF D8 FF`) or PNG (`89 50 4E 47`) → else 400, same message. (4) `before = getWaProfile(...)`. (5) `handle = uploadFileToMeta(...)`. (6) `setWaProfilePhoto(...)`. (7) `after = getWaProfile(...)`. (8) audit `whatsapp_profile.photo_update`, same entity, `before: { profile_picture_url: before.profilePictureUrl ? "set" : "none" }`, `after: { bytes: n, mime }`, `notify: true`. Never store Meta's picture URL (D11). (9) 200 `{ data: { profile_picture_url: after.profilePictureUrl } }`.

This is a deliberate small departure from D11 (browser → R2 → Meta): the photo is not something we keep, and the upload API needs the bytes from our server, so the browser posts them straight to the API.

No route changes the display name or the PIN.

## 6. Worker

Nothing. No job, no webhook. (`phone_number_name_update` and `phone_number_quality_update` webhooks exist; this screen reads live instead.)

## 7. Screens

All files in `apps/suite/src/features/channels/`:

| File | What |
|---|---|
| `whatsapp-profile-api.ts` | `waProfileApi.list()`, `.get(id)`, `.save(id, profile, expected)`, `.uploadPhoto(id, file)`; keys `waProfileKeys.list = ["channels","wa-profile"]`, `.one(id) = ["channels","wa-profile",id]`. Built on `api()` from `@admin/lib/api.js`. `uploadPhoto` sends the `File` as the body with its own content type |
| `ChannelsIndexPage.tsx` | Only if spec 01 has not built `/channels`. Lists WhatsApp numbers; each row links to its profile. If spec 01's page exists, add a "Business profile" link on each WhatsApp row there instead and do not create this file |
| `WhatsAppProfilePage.tsx` | The screen |
| `ProfileConfirmDialog.tsx` | Before-and-after confirm |
| `ProfilePhotoDialog.tsx` | Choose, preview, confirm a photo |

Routing (`apps/suite/src/router.tsx`): `/channels` (if missing) and `/channels/$accountId/whatsapp-profile`, both wrapped in `page(...)`. Menu (`SuiteShell.tsx`): if there is no Channels item yet, add `{ to: "/channels", label: "Channels", Icon: Radio, cap: "channels.manage" }` to the "Set-up" section above Settings, and widen `NavItem["to"]`. Add `/channels` to the nav test.

### 7.1 Index page (only if needed)

Title "Channels". Card heading "WhatsApp numbers". Each row: label, number, and a link "Business profile". Empty: title "No WhatsApp number yet", hint "Add a number under Settings, then come back here." Loading and error through `DataState`.

### 7.2 Profile page layout

Frame title "WhatsApp business profile", crumb "Channels". Two cards, side by side on desktop, stacked at 390 px.

**Card 1, "What customers see"** (the form):

| Control | Label | Help text under it | Limit shown |
|---|---|---|---|
| Round picture, 96 px, with button | "Profile photo" / button "Change photo" | "A square JPG or PNG. Your logo works best." | |
| Text input | "About" | "One short line under your name, like a status." | counter "0/139" |
| Text area, 4 rows | "Description" | "What you sell and how to order." | "0/512" |
| Text area, 2 rows | "Address" | "Where customers can find you." | "0/256" |
| Email input | "Email" | "An address customers can write to." | "0/128" |
| Text input | "Website" | "Start with https://" | "0/256" |
| Text input | "Second website (optional)" | "For example your Instagram page." | "0/256" |
| Select | "Type of business" | "Helps WhatsApp describe you. Most juice shops choose Restaurant or Food and grocery." | |

Buttons: "Review changes" (primary; disabled until something changed and there are no problems) and "Undo changes" (ghost; resets to what was loaded). Problems show under their field in red as the user types.

**Card 2, "Set by WhatsApp"** (read only). Intro line: "You cannot change these here. WhatsApp sets them, or they are changed in WhatsApp Manager." Rows:

| Row label | Value shown |
|---|---|
| "Phone number" | `display_phone_number`, else our `e164` |
| "Display name" | the name, then a pill from 7.4 |
| "Name waiting for approval" | only when `pending_name` is set: the name and a pill from `pending_name_status` |
| "Connection" | from 7.4 |
| "Quality" | from 7.4 |
| "Daily reach" | from 7.4 |
| "Two-step PIN" | `true` → "Set"; `false` → "Not set. Ask the technical lead to set one."; `null` → "WhatsApp does not tell us. Check in WhatsApp Manager." |
| "Verified badge" | `true` → "Yes"; `false` → "No"; `null` → row hidden |

Under the rows: link button "Open WhatsApp Manager" (`manager_url`, new tab) with the line "Use WhatsApp Manager to change the display name or the two-step PIN."

### 7.3 Business types (value → label, in this order)

`RESTAURANT` "Restaurant", `GROCERY` "Food and grocery", `RETAIL` "Shopping and retail", `EVENT_PLAN` "Event planning", `HOTEL` "Hotel and lodging", `BEAUTY` "Beauty, spa and salon", `APPAREL` "Clothing", `HEALTH` "Medical and health", `EDU` "Education", `ENTERTAIN` "Entertainment", `TRAVEL` "Travel and transport", `AUTO` "Cars and vehicles", `FINANCE` "Finance and banking", `PROF_SERVICES` "Professional services", `NONPROFIT` "Non-profit", `GOVT` "Public service", `OTHER` "Other", `""` "Not set". `ALCOHOL`, `OTC_DRUGS`, `ONLINE_GAMBLING` and `PHYSICAL_GAMBLING` are valid at Meta but not offered; if the profile already holds one, show it as an extra option labelled with the raw value.

### 7.4 Plain wording for Meta's values

| Field | Value → wording (pill colour) |
|---|---|
| name status | `APPROVED` "Approved" (green); `AVAILABLE_WITHOUT_REVIEW` "In use, not reviewed yet" (grey); `PENDING_REVIEW` "Waiting for WhatsApp to review" (amber); `DECLINED` "Refused by WhatsApp" (red); `EXPIRED` "Expired. The number must be set up again" (red); `NONE` "No name on record" (grey); anything else: the raw value (grey) |
| connection | `CONNECTED` "Connected" (green); null "Unknown"; anything else: "Not working normally (WhatsApp says: {value})" (red) |
| quality | `GREEN` "Good" (green); `YELLOW` "Medium. Customers have been blocking or reporting some messages" (amber); `RED` "Low. Slow down on templates until this improves" (red); `NA`, `UNKNOWN`, null "Not rated yet" (grey) |
| daily reach | `TIER_250` "Up to 250 new customers a day"; `TIER_2K` "Up to 2,000 new customers a day"; `TIER_10K` "Up to 10,000 new customers a day"; `TIER_100K` "Up to 100,000 new customers a day"; `TIER_UNLIMITED` "No daily limit"; null "Unknown"; anything else: the raw value. Sub-line always: "This counts conversations you start with templates. Replies to customers are not limited." |

Put these maps in `WhatsAppProfilePage.tsx` as exported pure functions (`nameStatusLabel`, `connectionLabel`, `qualityLabel`, `reachLabel`) so they can be tested.

### 7.5 Confirm dialog (`ProfileConfirmDialog`)

Title "Save these changes to WhatsApp?". Body: "Customers will see the new details straight away." Then a table with columns "", "Now", "After", one row per changed field (labels as in 7.2; an empty value shows as "(empty)"; two websites show on two lines). Buttons "Save to WhatsApp" (primary) and "Go back". While saving: button text "Saving…", both disabled.

After a 200: close; toast "Saved. This is what WhatsApp now shows."; replace the form with `data.profile`. If `mismatch` is not empty, show an amber banner on Card 1 instead of the toast: "Saved, but WhatsApp shows something different for: {labels}. Check below." On 409 `changed_elsewhere`: close, load `details.current` into the form, show the message as an amber banner. Other errors: keep the dialog open and show `error.message` in red inside it.

### 7.6 Photo dialog (`ProfilePhotoDialog`)

Title "Change profile photo". A file input (`accept="image/jpeg,image/png"`), then a round 160 px preview of the chosen file beside the current photo, captions "Now" and "New". Browser checks before upload, each with its message: wrong type "Use a JPG or PNG picture."; over 5 MB "That picture is larger than 5 MB. Choose a smaller one."; either side under 192 px "That picture is too small. Use one at least 192 pixels wide and tall."; not square (sides differ by more than 2%) amber warning, not a block: "This picture is not square. WhatsApp will crop it to a circle from the middle." Buttons "Use this photo" and "Cancel". Success: close, toast "Photo changed.", refetch the page. Failure: message stays in the dialog.

When `photo_upload_ready` is false the "Change photo" button is disabled with the note "Photo upload is not set up on this server yet. Change the photo in WhatsApp Manager for now."

### 7.7 States

- Loading: `DataState` loading on both cards.
- Error (GET failed): `DataState` error with the server's message and "Try again".
- No permission (403): "You do not have access to channel set-up. Ask the owner to give your account the 'Channels' permission."
- Number has no WhatsApp (400): "This number has no WhatsApp."
- Leaving with unsaved changes: browser `beforeunload` prompt; in-app navigation asks "Leave without saving your changes?" with "Leave" and "Stay".

## 8. Rules and edge cases

1. Validation messages (shared by browser and server): about over 139 → "Keep this to 139 characters or fewer."; address over 256 → "Keep the address to 256 characters or fewer."; description over 512 → "Keep the description to 512 characters or fewer."; email over 128 or not matching `^[^\s@]+@[^\s@]+\.[^\s@]+$` → "That does not look like an email address."; a website not starting `http://` or `https://` → "Start the website with https://"; a website over 256 → "Keep each website to 256 characters or fewer."; more than 2 websites → "WhatsApp allows two websites at most."; vertical not in the list and not the value already on the profile → "Choose a type of business from the list."
2. Character counts use `[...text].length` (so an emoji counts as one), but the server also refuses when `text.length` (UTF-16 units) is over the limit, with the same message.
3. Strings are trimmed before comparing and sending. Line breaks are kept in description and address, removed from about, email and websites.
4. A second website with the first empty is moved up to first place.
5. The write always sends address, description, email, websites and vertical, and sends about only when not empty.
6. Nothing is written when nothing changed (no Meta call, no audit row).
7. Two people editing: the second save gets 409 `changed_elsewhere` and sees the first person's version.
8. The page never shows a Meta code alone: every message is plain English, with the code in brackets only where 5.3 says so.
9. Meta's `profile_picture_url` is used only in the `<img>` on this page for the current visit. It is never saved, logged or audited. If the image fails to load, show the grey placeholder with initials "MS".
10. A timeout during save is "unknown": the 502 message tells staff to reload and check. The page then refetches by itself so what is shown is what Meta holds.
11. No automatic retry of a write.
12. If the upload API refuses the system-user token (Meta code `190` or `200` on step 1 or 2 only), answer 409 with "WhatsApp would not accept the photo from here. Change the photo in WhatsApp Manager for now." and do not raise the owner alert. Note it in the pull request.
13. The token never appears in a response, a log line or the audit row. Log Meta's code and message only.
14. Inactive numbers (`is_active = false`) can still be viewed and edited.
15. Works at 390 px: cards stack, the confirm table scrolls sideways inside the dialog.

## 9. Tests

`packages/shared/src/whatsapp-profile.test.ts`
- `accepts a full valid profile`
- `refuses about over 139 characters and counts an emoji as one`
- `refuses a third website and a website without http`
- `refuses a bad email`
- `normalise trims, drops empty websites and moves the second website up`
- `diff lists only changed fields with labels`

`packages/domain/src/meta/whatsapp-profile.test.ts` (stub `globalThis.fetch`)
- `getWaProfile maps data[0] and fills blanks`
- `updateWaProfile leaves about out when empty and always sends the other five`
- `getWaNumberStatus returns nulls for pin and badge when call B is refused`
- `getWaNumberStatus falls back to the short field list on code 100`
- `uploadFileToMeta opens a session then posts bytes with OAuth and file_offset 0`
- `uploadFileToMeta resumes once from the offset Meta reports`

`apps/suite/src/features/channels/WhatsAppProfilePage.test.ts`
- `labels: every known name status, connection, quality and reach value has wording; unknown values fall back to the raw value`

`apps/api/test/integration/whatsapp-profile.test.ts` (copy the set-up of `inbox-whatsapp.test.ts`; the Graph stub answers by URL and keeps an in-memory profile)
- `GET needs channels.manage (403 for a manager, 200 for an admin)`
- `GET returns profile and status and refreshes the number's quality columns`
- `PUT validates and returns field problems`
- `PUT with a stale expected returns 409 changed_elsewhere and writes nothing`
- `PUT writes, reads back and audits before and after`
- `PUT with no change makes no Meta write and no audit row`
- `PUT maps a Meta refusal to 409 with Meta's message and a timeout to 502`
- `photo: refuses a non-image, a wrong signature and a missing META_APP_ID`
- `photo: uploads, sets the handle, audits, and the stored audit row holds no URL`
- `a token error raises one owner alert, not two`

## 10. Manual check

With an admin tester account on the test number:

1. Open the suite → Channels → the test number → Business profile. Both cards load. Compare with the profile shown in the WhatsApp app on a phone that has chatted with the number.
2. Change About to "Fresh juice, made daily in Lagos". Press Review changes. The dialog shows one row. Save. The toast appears. On the phone, open the business's profile: the new line shows (it can take a minute).
3. Put "mrssamuel.com" in Website. The message "Start the website with https://" appears and Review changes is disabled.
4. Open the page in two tabs. Save a change in the first. Save a different change in the second: the "changed somewhere else" banner appears and the first tab's value is loaded.
5. Change the photo to a square PNG logo. Confirm on the phone.
6. Try a 6 MB picture and a 100 x 100 picture: each is refused with its message.
7. Sign in as a manager (no `channels.manage`): Channels is not in the menu; the address typed by hand shows the no-access message.
8. Admin app → Audit log: two rows, `whatsapp_profile.update` and `whatsapp_profile.photo_update`, with before and after and no web address of the picture.
9. At 390 px wide: the cards stack and the dialog is usable.

## 11. Done when

- [ ] All tests in section 9 pass; lint and type-check are clean; the suite builds.
- [ ] The manual check passes on the test number.
- [ ] `META_APP_ID` is documented in the pull request for Tes to add.
- [ ] No profile data is stored in the database; no migration was added.
- [ ] The pull request lists every [unverified] fact in section 3 and what was found.

## 12. Out of scope

- Changing the display name or the two-step PIN from the suite (link out; see section 14, item 2).
- Registering or verifying a number (already in Settings → Numbers).
- Caching the profile, or showing it in the inbox.
- Official Business Account requests.
- Messenger and Instagram profile details (specs 04 and 10).

## 13. Work order

1. Add `channels.manage` (if missing) and `META_APP_ID` to env and compose. Run type-check.
2. `packages/shared/src/whatsapp-profile.ts` and its tests.
3. Export `graph`, add `graphRaw`, refactor `graph` onto it; existing domain tests still pass.
4. `packages/domain/src/meta/upload.ts` and `whatsapp-profile.ts` with tests; export from the package.
5. API routes for GET list, GET one, PUT; register in `test-app.ts`; integration tests.
6. API photo route and its tests; the owner alert case in `outbox.ts`.
7. `whatsapp-profile-api.ts`, `WhatsAppProfilePage.tsx` with the label functions and their test.
8. `ProfileConfirmDialog.tsx`, `ProfilePhotoDialog.tsx`; route and menu (and `ChannelsIndexPage.tsx` if spec 01 is not merged).
9. Manual check at desktop and 390 px; write the pull request.

## 14. Open questions

1. **`messaging_limit_tier` is deprecated by Meta**, but `getNumberInfo()` and Settings → Numbers → Refresh still ask for it. Recommended default: in this spec, change `getNumberInfo()` to request `whatsapp_business_manager_messaging_limit` and map it into the existing `messaging_limit` column; keep the column name. The limit is now shared by the whole business, not per number; the wording in 7.4 already avoids "this number".
2. **The display name can be changed by API** (section 3.3), so a link-out is a choice, not a limit. Recommended default: link out for now. A name change needs the number registered again with its PIN within 14 days of approval, and a wrong step can leave the number unable to send. If the owner wants it in the suite, add it as its own small task with an owner-only confirm.
3. **Does the system-user token work for the upload API?** Meta's guide names a user token. Recommended default: build as written; rule 12 covers a refusal.
4. **Is `/channels` there yet?** The foundation lists no dependency for this spec but places the screen under `/channels`, which spec 01 creates. Recommended default: build the small index page if spec 01 is not merged, and replace it with a link on spec 01's page when it is.
5. **Photo rules** are ours, not Meta's (none are published). Recommended default: keep 5 MB, JPG or PNG, at least 192 px.

## Built differently

Departures made while building this spec on `work/olu/suite-05-wa-profile` (stacked on `work/olu/suite-10-page-details`, 20 Nov 2026). Work-order task 9 (the manual check at desktop and 390 px with a tester account) was not done: no Meta account or browser was available. Every [unverified] fact in section 3 is therefore still **unchecked** (clearing a field with `""`, fields left out of a POST, photo rules, the system-user token for the upload API, `is_pin_enabled` and `is_official_business_account`, the enum names other than `TIER_250`, the WhatsApp Manager address), and the integration tests have **not been run** (no Docker).

1. **Env and index.** `META_APP_ID` already existed (spec 02) as an optional string in `env.ts` and in `MetaConfig.appId`; it was left as it is (no digits-only rule, so a wrong value cannot stop the API starting). The routes read it through `metaConfigFromEnv()` and treat anything that is not all digits as "not set". `docker-compose.yml` passes it to the `api` service only; the `worker` service still lacks it. There is no `meta/index.ts`: the package index lists each `meta/*.ts` file, as specs 01, 02, 04 and 10 do.
2. **Shared helpers.** `validateWaProfile(p, opts?)` takes an optional second argument (`utf16`, which the server sets so an emoji counts as two units as rule 2 says, and `keepVertical`, the business type already on the profile). The server passes the `expected` vertical as `keepVertical`. Extra exports: `changedWaFields`, `waProfileFieldLabel`, `waVerticalLabel`, `WA_VERTICALS_HIDDEN`, `WA_PROFILE_FIELD_KEYS`.
3. **`graphRaw`** takes a fifth argument `opts` (`token`, `onResponse`, `service`, the same as `graph`) so `graph` can be a thin wrapper over it with no copied error code. `uploadFileToMeta` and `graphRaw` are exported from `@ms/domain` for specs 06 and 07.
4. **`getNumberInfo`** (open question 1) asks for `whatsapp_business_manager_messaging_limit` together with the deprecated `messaging_limit_tier`; if Meta refuses the field list with code 100 it asks again with the old field only. `numberMessagingLimit(info)` picks the current value, else the old one, and Settings, Numbers, Refresh uses it. Tests were added to `packages/domain/src/inbox/inbox.test.ts`; no existing expectation changed.
5. **Call B** of `getWaNumberStatus` returns nulls for any Meta refusal or timeout, not only `delivery: "not_sent"`, so an optional field can never stop the page loading.
6. **Error wording.** Meta code `283` is also a configuration code (foundation C2). A plain refusal while reading the page says "WhatsApp refused this request: …" instead of "this change". A bad Meta answer to a write ("did not confirm") is a refusal (409).
7. **Audit.** Besides the two actions in the spec, a save that times out writes `whatsapp_profile.update_unconfirmed` (it may have gone through), and a save that Meta accepted but whose read-back failed writes `whatsapp_profile.update` and answers 502 with `details.reason = "read_back_failed"`.
8. **Owner alert** reuses `inbox.meta_config` (spec 02's `alertOnce`), keyed on `account: "whatsapp_profile"`, so there is one alert per 24 hours for the whole profile area. The existing `outbox.ts` case now branches on `payload.area === "whatsapp_profile"` to give the spec's wording (with a link to Channels); the Facebook and Instagram wording is unchanged.
9. **Error codes.** The API has no `bad_gateway`, so 502 uses `service_unavailable` (as spec 10 does); a 413 uses `validation_failed`.
10. **Routes.** The list route also requires `kind = 'phone'`. A save with nothing changed answers `{ profile, changed: [], mismatch: [] }`. The photo route accepts a JPEG or PNG signature whatever the browser called it and sends Meta the type the bytes prove; the file name is cleaned (default `profile.png` or `profile.jpg`). It does not check the picture's pixel size (the browser does).
11. **The browser sends a save and a photo once** (no retry on 502, rule 11), with its own `fetch`, as specs 04 and 10 do. After a timeout or 5xx the page reloads what WhatsApp holds. The photo's file name goes in `x-file-name` URL-encoded.
12. **Screen.** The "Saved, but WhatsApp shows something different" banner sits at the top of the page, above both cards. `lazyNamed` in `router.tsx` accepts any module, because `WhatsAppProfilePage.tsx` also exports the wording functions. The Channels page already existed, so there is no `ChannelsIndexPage.tsx`; each phone line that is not voice-only gets a "Business profile" link. The menu item and its nav test already existed.
13. **Extra tests.** Worker: `outbox-whatsapp-profile.test.ts`. API: 404 and 400 cases, an ignored write (mismatch), the empty-about refusal, an upload refused with code 190, and an oversize photo (the oversize 413 test sends 5 MB and has not been run).
