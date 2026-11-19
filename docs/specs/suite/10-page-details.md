# Suite build spec 10: Facebook Page details

Size S. Suggested model: Sonnet. Read `00-foundation.md` first; it wins where the two disagree.

How to read the fact marks: **[verified: URL, 19 Nov 2026]** means the fact was read on that page of Meta's developer documentation on 19 Nov 2026 (through a page-reading tool, so wording is paraphrased). **[unverified]** means memory or inference: open the page named beside it before coding against it.

---

## 1. Outcome

A staff member with the "Channels" permission can say:

- "I open our Facebook Page in Channels and see its public details as they are on Facebook right now: description, phone, website, email, opening hours, address, pictures, name, username and category."
- "I can change the description, phone, website, emails, opening hours and address from the suite. Before saving I see a before-and-after of exactly what will change. After saving the suite shows what Facebook now holds."
- "For the things that can only be changed on Facebook (name, username, category, cover photo) the suite says so and gives me a link."
- "For Instagram I can see the profile (name, bio, website, picture), and the suite tells me plainly that it must be edited in the Instagram app."
- "I can see who changed what, and when."

## 2. Depends on

| Needs | Why |
|---|---|
| Spec 01 merged | `ChannelAccount`, `pageAccessToken`, exported `graph()` with a per-call token, `channels.manage`, the `/channels` section |
| In Meta Business Settings (a person does this once) | The suite's system user must be able to perform the **MANAGE** task on the Page (fact P6). The foundation says the Page is assigned "with messaging rights", which may not be enough: the screen detects and explains this (section 7) |

No migration (foundation section 6). History lives in the audit log.

## 3. Meta reference

All calls use the Page access token from `pageAccessToken(cfg, account.pageId)` through `graph()`.

### 3.1 Reading

| # | Fact | Mark |
|---|---|---|
| P1 | `GET /{page-id}?fields=…` returns, among others: `name`, `username` (the alias in the Page's address), `about`, `description`, `phone`, `website`, `emails` (list), `hours` (map), `is_always_open`, `temporary_status`, `location`, `single_line_address`, `cover`, `category`, `category_list`, `link` (the Page's Facebook address), `is_published`, `verification_status` (`blue_verified`, `gray_verified`, `not_verified`), `followers_count`, `fan_count` | [verified: https://developers.facebook.com/docs/graph-api/reference/page/, 19 Nov 2026] |
| P2 | `about` "maps to the **Description** setting in the Edit Page Info user interface. Limit of 100 characters." `description` maps to the **Additional Information** setting | [verified: same page, 19 Nov 2026] |
| P3 | `hours`: keys are `{day}_{number}_{status}`: `{day}` is the first 3 letters of the weekday (`mon`…`sun`), `{number}` is `1` or `2` ("Each day can have 2 different hours ranges"), `{status}` is `open` or `close`. Values look like `"09:00"`. "If a business is open during the night, the closing time can not pass 6:00am." Open all day is `00:00` to `24:00`; for always open use `is_always_open` | [verified: same page, 19 Nov 2026] |
| P4 | Profile picture: `GET /{page-id}/picture?redirect=0&type=large` returns JSON `{"data": {"url": …}}` instead of the image | [verified: https://developers.facebook.com/docs/graph-api/reference/page/picture/, 19 Nov 2026] |
| P5 | Reading Page-owned data needs `pages_read_engagement` (and `pages_read_user_content`), and the person behind the token must be able to perform the MODERATE task | [verified: https://developers.facebook.com/docs/graph-api/reference/page/, 19 Nov 2026] |

### 3.2 Updating

| # | Fact | Mark |
|---|---|---|
| P6 | "If you can perform the `MANAGE` task on the Page, you can use a Page access token to send a `POST` request to the `/page_id` endpoint." Example body `{"about": "…"}`. Success: `{"success": true}` | [verified: https://developers.facebook.com/docs/pages-api/manage-pages, 19 Nov 2026] |
| P7 | The permission that covers it is `pages_manage_metadata` ("…and to update settings on the Page") | [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026]; that it is the **only** permission needed is [unverified] (the Page reference does not say) |
| P8 | Updatable parameters on `POST /{page-id}` include: `about`, `description`, `phone`, `website`, `emails` (list of strings), `hours` (dictionary, P3 format), `is_always_open`, `temporary_status`, `location` (object: `city`, `city_id`, `state`, `country`, `street`, `zip`, `latitude`, `longitude`), `contact_address`, `category_list` (list of category IDs), `cover` (a photo ID), `price_range`, `impressum`, `is_published`. The endpoint supports read-after-write | [verified: https://developers.facebook.com/docs/graph-api/reference/page/, 19 Nov 2026] |
| P9 | **`name` and `username` are not in the list of updatable parameters.** They can only be changed in Facebook's own screens | [verified by absence: same page, 19 Nov 2026]. Meta's page does not state it in words |
| P10 | **Category:** the read-only `category` is not updatable, but `category_list` **is** listed as updatable (it takes category IDs) | [verified: same page, 19 Nov 2026]. This differs from the assumption that category cannot be changed by API; see section 14, Q1. This spec keeps category read-only |
| P11 | `cover` "can only be updated by the Page Admin or Page Editor with `EDIT_PROFILE` and `business_management`" | [verified: same page, 19 Nov 2026]. How the photo is first uploaded to get an ID is [unverified]. Out of scope here |
| P12 | Profile picture: `POST /{page-id}/picture` with `picture` (a URL of the image) creates a new profile picture. Needs the MANAGE task, `pages_read_engagement`, `pages_show_list`. Returns `{success: bool}` | [verified: https://developers.facebook.com/docs/graph-api/reference/page/picture/, 19 Nov 2026]. Optional Phase B (section 5.6) |
| P13 | Error codes on update: `100` invalid parameter, `200` permissions, `190` bad token, `210` user not visible, `368` blocked as abusive, `283` needs an extended permission, `160` invalid geolocation, `374` and `375` location-Page problems, `320` photo edit failure | [verified: https://developers.facebook.com/docs/graph-api/reference/page/, 19 Nov 2026] |
| P14 | How to **clear** a field (empty string for text, empty list for `emails`, empty object for `hours`) | [unverified]. Check each on a test Page in work-order step 2; rule R8 says what the suite does meanwhile |
| P15 | Maximum lengths for `description`, `phone`, `website`, and the number of `emails` | [unverified]. The suite's own limits are in section 5.1 |
| P16 | Updating `location` on a Page that has no address yet, by city **name** rather than `city_id` | [unverified]. The suite sends `street`, `city`, `state`, `country`, `zip`; a refusal is shown with Meta's message (rule R7) |
| P17 | The tasks the token holder has on the Page can be read with `GET /me/accounts?fields=id,tasks` (the guide shows `tasks` such as `ANALYZE`, `ADVERTISE`, `MODERATE`, `CREATE_CONTENT`, `MANAGE` on each Page) | `tasks` on `/user/accounts` [verified: https://developers.facebook.com/docs/pages-api/manage-pages, 19 Nov 2026]; that it works with a **system-user** token is [unverified] |
| P18 | Page rate limit: calls in 24 hours = 4800 × engaged users; error `80001` when exceeded | [verified: https://developers.facebook.com/docs/graph-api/overview/rate-limiting, 19 Nov 2026] |

### 3.3 Instagram profile

| # | Fact | Mark |
|---|---|---|
| G1 | `GET /{ig-user-id}?fields=id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count` | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user, 19 Nov 2026] |
| G2 | **Updating an Instagram account through the API: "This operation is not supported."** Deleting likewise. Name, username, bio, website, profile picture, category and contact buttons can be changed only in the Instagram app or Meta Business Suite | "not supported" [verified: same page, 19 Nov 2026] |

### 3.4 Permissions and review

`pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`; for the Instagram card `instagram_basic`. The business owns this Page, so standard access is enough and **no app review is needed for this spec** [verified: https://developers.facebook.com/documentation/instagram-platform/app-review.md, 19 Nov 2026: review is "not required" for an app serving only a business you own or manage]. If the owner wants it in the review anyway, the screencast shows: open the Page details in the suite, change the phone number, the before-and-after dialog, save, then the new number on the Page's About section on Facebook.

## 4. Data

No migration and no new table.

- Every save writes an `audit_log` row through `writeAudit` (section 5.4). The "Recent changes" list on the screen reads those rows.
- Nothing from Meta is cached in the database. The live read is cached in API process memory for 60 seconds per Page.
- If `channels.manage` is not yet in `CAPABILITIES` (spec 01 adds it), add it and grant it to admin.

## 5. Server

### 5.1 Shared rules: `packages/shared/src/page-details.ts` (new)

```ts
export const PAGE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type PageDay = (typeof PAGE_DAYS)[number];
export interface PageHoursRange { open: string; close: string }           // "HH:MM", close may be "24:00"
export type PageWeek = Record<PageDay, PageHoursRange[]>;                 // 0, 1 or 2 ranges per day
export interface PageAddress { street: string; city: string; state: string; country: string; zip: string }

/** The fields the suite can edit. null = not set on Facebook. */
export interface PageEditable {
  about: string | null; description: string | null; phone: string | null; website: string | null;
  emails: string[]; always_open: boolean; hours: PageWeek | null; address: PageAddress | null;
}
export type PageEditableKey = keyof PageEditable;

export const PAGE_LIMITS = { aboutMax: 100, descriptionMax: 1000, websiteMax: 255, emailsMax: 3,
  streetMax: 200, cityMax: 100, stateMax: 100, countryMax: 100, zipMax: 20 } as const;

export function pageHoursToWeek(hours: Record<string, string> | null | undefined): PageWeek | null;
export function weekToPageHours(week: PageWeek): Record<string, string>;      // {"mon_1_open":"08:00","mon_1_close":"18:00",…}
export function validatePageChanges(changes: Partial<PageEditable>): { field: PageEditableKey; message: string }[];
/** Trim, lower-case emails, E.164 the phone, add https:// to a bare website, turn "" into null. */
export function normalisePageChanges(changes: Partial<PageEditable>): Partial<PageEditable>;
/** Same value after normalising (order of emails ignored; hours compared range by range). */
export function samePageValue(key: PageEditableKey, a: unknown, b: unknown): boolean;
/** Keys whose value differs between two snapshots. */
export function diffPage(before: PageEditable, after: Partial<PageEditable>): PageEditableKey[];
```

Validation messages:

| Field | Rule | Message |
|---|---|---|
| `about` | at most 100 characters (P2) | "Keep the short description to 100 characters." |
| `description` | at most 1,000 characters | "Keep the longer description to 1,000 characters." |
| `phone` | `toE164()` from `@ms/shared` must return a value | "That phone number doesn't look right. Include the country code, for example +234 801 234 5678." |
| `website` | parses as a URL with `http:` or `https:`, has a dot in the host, no spaces, at most 255 characters | "Enter a web address such as https://www.mrssamuel.com" |
| `emails` | at most 3; each matches a simple email pattern; no duplicates | "You can list up to 3 emails." / "“{value}” is not an email address." / "The same email is listed twice." |
| `hours` | each day 0 to 2 ranges; times `HH:MM` in 5-minute steps; `open` before `close`, **or** `close` at or before `06:00` (overnight, P3); two ranges on one day must not overlap; at least one range in the week | "{Day}: closing time must be after opening time (or by 6:00 am the next morning)." / "{Day}: the two opening times overlap." / "Add at least one opening time, or choose Always open." |
| `always_open` | when true, `hours` is ignored and not sent | — |
| `address` | `street`, `city` and `country` required when any part is filled; each within its limit | "Fill in the street, the city and the country." |

### 5.2 Meta calls: `packages/domain/src/meta/page-details.ts` (new; re-export from the package index)

```ts
export interface PageSnapshot {
  id: string; name: string | null; username: string | null; category: string | null; link: string | null;
  is_published: boolean | null; verification_status: string | null; followers_count: number | null;
  picture_url: string | null; cover_url: string | null; single_line_address: string | null;
  editable: PageEditable;
}
export interface InstagramProfile { id: string; username: string | null; name: string | null; biography: string | null;
  website: string | null; profile_picture_url: string | null; followers_count: number | null; media_count: number | null }

export function readPage(cfg: MetaConfig, account: ChannelAccount): Promise<PageSnapshot>;
export function readPageTasks(cfg: MetaConfig, pageId: string): Promise<string[] | null>;   // null = could not tell
export function updatePage(cfg: MetaConfig, account: ChannelAccount, changes: Partial<PageEditable>): Promise<void>;
export function readInstagramProfile(cfg: MetaConfig, account: ChannelAccount): Promise<InstagramProfile>;
/** Pure: our changes → the POST body. */
export function pageUpdateBody(changes: Partial<PageEditable>): Record<string, unknown>;
```

| Function | Request |
|---|---|
| `readPage` | `GET {pageId}?fields=id,name,username,about,description,phone,website,emails,hours,is_always_open,location,single_line_address,category,link,cover,is_published,verification_status,followers_count` with the Page token, then `GET {pageId}/picture?redirect=0&type=large` (P4). `cover_url = cover?.source ?? null` ([unverified] sub-field name; treat as optional). `editable.address` from `location` (`street`, `city`, `state`, `country`, `zip`; null when `location` is missing or has no `street` and no `city`). `editable.hours = pageHoursToWeek(hours)` |
| `readPageTasks` | `GET me/accounts?fields=id,tasks&limit=100` with the **system-user** token (`cfg.token`), find the Page, return its `tasks`. Any error or Page not listed → `null` (P17) |
| `updatePage` | `POST {pageId}` with the Page token, JSON body `pageUpdateBody(changes)` |
| `readInstagramProfile` | `GET {igId}?fields=id,username,name,biography,website,profile_picture_url,followers_count,media_count` with the Page token of `account.pageId` (G1) |

`pageUpdateBody` maps only the keys present in `changes`:

| Our key | Body |
|---|---|
| `about`, `description`, `phone`, `website` | the string; `null` → `""` (P14) |
| `emails` | the array (empty array when cleared) |
| `always_open: true` | `is_always_open: true` (and no `hours`) |
| `always_open: false` | `is_always_open: false` |
| `hours` | `hours: weekToPageHours(week)` |
| `address` | `location: {street, city, state, country, zip}` |

`pageUpdateBody` never emits `name`, `username`, `category_list`, `cover`, `is_published` or any key not in this table, whatever it is given.

### 5.3 Routes: `apps/api/src/routes/channel-page-details.ts` (new)

`export function channelPageRoutes(db: DbClient)`. Register in `apps/api/src/test-app.ts` before any `/v1/channels` router from spec 01: `app.route("/v1/channels/:accountId/page", channelPageRoutes(db));`. Every route: `requireAuth()`, `requireCapability("channels.manage")`. `:accountId` must be an `inbox_phone_number` row of kind `messenger` or `instagram`; a phone number or unknown ID → 404.

```ts
interface PageDetailsView {
  account: { id: string; label: string; kind: "messenger" | "instagram"; is_active: boolean };
  page: PageSnapshot | null;                // for a messenger account; for instagram, the Page it is linked to is NOT loaded
  instagram: InstagramProfile | null;       // for an instagram account
  can_edit: boolean;                        // messenger account, active, and tasks include MANAGE (or tasks unknown)
  cannot_edit_reason: "instagram" | "inactive" | "no_manage_task" | null;
  read_at: string;
  limits: typeof PAGE_LIMITS;
}
```

| Method and path | Request | Response and behaviour |
|---|---|---|
| `GET /` | `?fresh=1` skips the 60-second cache | `{data: PageDetailsView}`. Meta read failure → 502 `BusinessError` with the wording in 5.5 |
| `PATCH /` | `{confirm: true, expected: Partial<PageEditable>, changes: Partial<PageEditable>}`; `changes` and `expected` must have exactly the same keys, at least one | see 5.4. 200 `{data: {view: PageDetailsView, saved: PageEditableKey[], not_saved: PageEditableKey[]}}` |
| `GET /history` | `?limit` (default 20, max 50) | `{data: [{at, by_name, fields: PageEditableKey[], before, after, result}]}` from `audit_log` where `action = 'channels.page_update'` and `entity_id = :accountId`, newest first |

### 5.4 Saving (the `PATCH` route), step by step

1. `confirm` must be literally `true`, else 400. Account must be kind `messenger` and active, else 409 "These details can only be changed on Facebook." / "This account is switched off in Channels."
2. `changes = normalisePageChanges(body.changes)`; `validatePageChanges(changes)` → first problem as 400.
3. Read the Page fresh (`readPage`, no cache). For every key in `changes`: if `!samePageValue(key, live.editable[key], expected[key])` → 409 `stale` with message "These details were changed on Facebook since you opened this page. Check the new values and try again." and the fresh view in `details`. Nothing is sent.
4. Drop keys whose new value already equals the live value. Nothing left → 200 with `saved: []`, no call to Meta, no audit row.
5. `updatePage(cfg, account, remaining)`.
6. Read the Page again (read-after-write, P8). `saved` = keys whose live value now equals the requested value; `not_saved` = the rest. If the first read-back shows any `not_saved`, wait 1.5 seconds and read once more before deciding.
7. Audit: `writeAudit(db, c, {action: "channels.page_update", entityType: "facebook_page", entityId: account.id, before: {…old values of the keys sent}, after: {…requested values, result: "saved" | "partly_saved" | "refused" | "unknown", not_saved, meta_code, meta_message}, notify: true})`. An audit row is written for every attempt that reached step 5, whatever the outcome.
8. Replace the cache with the read-back. Respond 200 when `not_saved` is empty or partly empty (the screen explains); when Meta refused the whole request → 409 with the wording in 5.5 and the fresh view in `details`.
9. Timeout on step 5 (`delivery === "unknown"`): do step 6 anyway. All keys match → treat as saved. Otherwise → 504 "No answer from Facebook. Some details may not have been saved. The page now shows what Facebook holds." with the fresh view; audit `result: "unknown"`.

No queued row is needed: saving the same values twice is harmless, and nothing is retried automatically.

### 5.5 Error wording

| Case (foundation D10 classes) | Message |
|---|---|
| Configuration (`190`, `10`, `200`, `299`, `283`) | "The suite is not allowed to change this Page. Ask the owner to give the suite full control of the Page in Meta Business Settings." Also one owner alert per account per 24 hours through `outbox_event` (`eventType: "channels.page_config"`, payload `{account_id, label, code, message}`); add the `case` in `apps/worker/src/outbox.ts`: `Page details: Facebook refused a change to {label}: {message} (code {code}).` |
| Temporary (`4`, `17`, `32`, `613`, `80001`, 429, 5xx) | "Facebook is busy. Nothing was changed. Try again in a few minutes." |
| `368` | "Facebook blocked this change because it looked unusual. Try again later, or make the change on Facebook." |
| `100`, `160`, `374`, `375` and any other refusal | "Facebook refused this: {Meta's message} (code {code})." |
| Read failure | "We could not load the Page from Facebook. {one of the lines above}" |

### 5.6 Phase B (optional, only if asked): profile picture

`POST /v1/channels/:accountId/page/picture` `{confirm: true, media_key, media_token}`: the browser uploads a JPEG or PNG (at most 4 MB, at least 320 px square) to R2 with `presignInboxPut` (the same upload-token check as inbox attachments), the server gives Meta a short-lived address from `presignInboxGet` in `POST {pageId}/picture` body `{picture: url}` (P12), reads the picture back, audits `channels.page_picture`. Confirm dialog shows the old and new picture side by side. The cover photo stays out of scope (P11).

## 6. Worker

No job. Nothing here runs unattended. The only worker change is the alert `case` in `apps/worker/src/outbox.ts` (5.5).

## 7. Screens

New files in `apps/suite/src/features/page-details/`:

| File | Holds |
|---|---|
| `PageDetailsPage.tsx` | The page. Exports `PageDetailsPage({ accountId })` |
| `PageDetailsForm.tsx` | The editable fields |
| `PageHoursEditor.tsx` | Opening hours: one row per day, up to two time ranges |
| `LockedDetails.tsx` | Name, username, category, pictures (read-only) |
| `SaveDialog.tsx` | Before-and-after confirm, on `@admin/components/ConfirmModal.js` |
| `InstagramProfileCard.tsx` | Read-only Instagram profile |
| `RecentChanges.tsx` | The history list |
| `page-details-api.ts` | `pageDetailsApi`, `pageDetailsKeys` (keys start `["channels", "page", accountId]`) |
| `page-details-logic.ts`, `page-details-logic.test.ts` | `changedKeys(form, live)`, `beforeAfterRows(live, form)`, `hoursText(week, alwaysOpen)`, `fieldLabel(key)` |
| `page-details.css` | Styles, prefix `pd-` |

**Route** (`apps/suite/src/router.tsx`): `/channels/$accountId/page`. **Entry point:** a link "Page details" on a Page's row, and "Profile" on an Instagram account's row, in spec 01's Channels screen. Frame title "Page details" (or "Instagram profile"), crumb "Channels".

**Top of the page (Page account):** profile picture, cover photo (each hidden if it fails to load), the Page name, `@username`, the category, "{followers_count} followers", a chip "Published" or "Not published", and a link "Open on Facebook" (`link`, new tab). Under it, small grey: "Showing what is on Facebook now. Checked {time}." with a link "Check again" (`?fresh=1`).

**Locked details (`LockedDetails.tsx`)**, a card titled "Changed on Facebook only":

| Row | Text beside the value |
|---|---|
| Name | "Facebook reviews name changes. Change it on Facebook." |
| Username | "The @name in your Page's address. Change it on Facebook." |
| Category | "Change it on Facebook." |
| Profile picture, Cover photo | "Change it on Facebook." |

Below the rows: "To change these: open the Page on Facebook, choose **Edit**, and make the change there." and the button "Open the Page on Facebook" (`link`).

**Editable details (`PageDetailsForm.tsx`)**, a card titled "Details you can change here":

| Label | Control | Help text |
|---|---|---|
| "Short description" | textarea, counter "`{n}` / 100" | "One or two lines shown at the top of your Page." |
| "More about the business" | textarea, counter to 1,000 | "Shown in the Page's About section." |
| "Phone" | text | "Include the country code, for example +234…" |
| "Website" | text | — |
| "Emails" | up to 3 text rows with "Remove", button "Add an email" | — |
| "Opening hours" | a switch "Always open"; when off, `PageHoursEditor`: for each day Monday to Sunday a switch "Open", one time range, and a link "Add a second opening time" / "Remove" | "Times are Lagos time. If you close after midnight, the closing time can be up to 6:00 am." |
| "Address" | Street, City, State, Country, Postcode | "Shown on your Page with a map, if Facebook can find it." |

Problems from `validatePageChanges` show under their field after first blur. A sticky bar at the bottom: "Undo changes" (resets the form to live) and "Review and save…" (disabled with "Nothing has changed." when `changedKeys` is empty, or "Fix the problems above first.").

**Save dialog (`SaveDialog.tsx`):** title "Save these changes to Facebook?". Body: "These details are public. They change on your Facebook Page **{name}** straight away." Then a table with a row per changed field, columns "Now on Facebook" and "After saving". Empty values show as "Not set". Hours show as lines such as "Mon 8:00 am to 6:00 pm" (from `hoursText`), "Closed" for a day with no range, or "Always open". Emails are comma-separated. Address on one line. Confirm "Save to Facebook" / busy "Saving…".

After the answer:

| Server answer | What the person sees |
|---|---|
| 200, `not_saved` empty | dialog closes; toast "Saved. Facebook now shows the new details."; the form reloads from the read-back |
| 200, some `not_saved` | dialog closes; amber banner: "Saved: {labels}. Not saved yet: {labels}. Facebook may be reviewing them, or did not accept them. The page shows what Facebook holds now." |
| 409 `stale` | dialog closes; amber banner with the server's message; the form reloads the live values and keeps the person's typed values in the fields that did not clash |
| 409 refusal, 502, 503, 504 | dialog closes; red banner with the server's message; the form keeps what the person typed |

**Cannot-edit banners** (the form is shown read-only, no save bar):

| `cannot_edit_reason` | Banner |
|---|---|
| `no_manage_task` | "The suite can read this Page but is not allowed to change it. The owner needs to give the suite's system user **full control** of the Page in Meta Business Settings (Accounts → Pages → this Page → People)." |
| `inactive` | "This account is switched off in Channels." |

**Instagram account (`InstagramProfileCard.tsx`):** picture, `@username`, name, bio, website, "{followers_count} followers · {media_count} posts", then a grey box: "**Instagram does not let apps change a profile.** To change the name, username, bio, website, picture, category or contact buttons, open the Instagram app → your profile → **Edit profile**." and a link "Open on Instagram" (`https://www.instagram.com/{username}/`, new tab).

**Recent changes (`RecentChanges.tsx`)**, collapsed section: rows "{date and time, Lagos} · {by_name} · changed {labels}" with a chip "Saved", "Partly saved", "Refused" or "Not confirmed"; opening a row shows the before and after values.

**States:** loading → `DataState`; load error → `DataState` with the server's message and "Try again"; no permission → `<div className="empty">` title "No access", text "Ask the owner if you need to change the Page's details."; phone-number account or unknown ID → "This account has no Page details." All of it must work at 390 px: cards stack, the before-and-after table becomes two stacked blocks per field ("Now" above "After").

## 8. Rules and edge cases

- **R1.** A save sends only the fields the person changed. Untouched fields are never sent.
- **R2.** `name`, `username`, category, cover and "published" can never be sent, even if a client puts them in `changes` (the body schema is strict: unknown keys → 400).
- **R3.** `confirm: true` is required; without it nothing is read or sent.
- **R4.** If a changed field's live value no longer equals `expected`, nothing is sent and the person is told (409 `stale`).
- **R5.** After every save the Page is read back and the screen shows the read-back, not the typed values.
- **R6.** Meta answering `success` while the read-back shows the old value is reported as "not saved yet", never as saved.
- **R7.** A refused address (unknown city, wrong Page type) leaves every other field in the same request in an unknown state: the read-back decides `saved` and `not_saved` field by field.
- **R8.** Clearing a text field sends `""`; clearing all emails sends `[]`. If the read-back still shows the old value, the field is in `not_saved` and the banner adds "To remove it completely, do it on Facebook." Clearing **all** opening hours is not offered (validation requires one range or Always open) until P14 is checked.
- **R9.** Switching "Always open" on sends `is_always_open: true` only; switching it off requires valid hours in the same save and sends `is_always_open: false` plus `hours`.
- **R10.** Hours are always sent as the whole week, never one day.
- **R11.** A phone is stored and sent in E.164 (`+234…`); for comparison, live and typed values are both reduced to digits, so "+234 801 234 5678" and "+2348012345678" are the same and cause no save.
- **R12.** A website typed without a scheme gets `https://`. A trailing slash is ignored when comparing.
- **R13.** Every attempt that reaches Meta writes one audit row with before, after and the result; the owner is notified (`notify: true`).
- **R14.** No Page token is stored, logged, returned or written to the audit log.
- **R15.** `readPageTasks` returning `null` (cannot tell) does not block editing; a `200` or `283` refusal from Meta then shows the configuration message.
- **R16.** An Instagram account never gets a save bar, and `PATCH` for it answers 409 "These details can only be changed in the Instagram app."
- **R17.** Two people saving different fields at the same time both succeed; saving the same field: the second gets `stale`.

## 9. Tests

`packages/shared/src/page-details.test.ts`:
- `pageHoursToWeek: reads mon_1 and mon_2 ranges; missing days are closed; null stays null`
- `weekToPageHours: writes {day}_{n}_{open|close} keys for one and two ranges`
- `weekToPageHours then pageHoursToWeek round-trips`
- `validatePageChanges: about over 100; bad phone; website without a dot; 4 emails; duplicate email; bad email`
- `validatePageChanges: hours overlap; close before open; overnight close at 02:00 allowed; overnight close at 07:00 refused; empty week refused`
- `validatePageChanges: address needs street, city and country together`
- `normalisePageChanges: adds https://, lower-cases emails, formats the phone, turns "" into null`
- `samePageValue: phone compared by digits; website ignores a trailing slash; emails ignore order`

`packages/domain/src/meta/page-details.test.ts`:
- `pageUpdateBody: maps each key; always_open true omits hours; null text becomes ""`
- `pageUpdateBody: never emits name, username, category_list, cover or is_published`

`apps/api/test/integration/channel-page-details.test.ts` (Graph stub holds one Page object in memory, applies POST bodies to it unless told to refuse, ignore or time out; answers `me/accounts` with configurable tasks):
- `needs channels.manage; a phone account answers 404`
- `GET returns the Page's details and can_edit true when tasks include MANAGE`
- `GET sets cannot_edit_reason no_manage_task when MANAGE is missing`
- `GET for an instagram account returns the profile and can_edit false`
- `PATCH without confirm:true → 400 and no Graph call`
- `PATCH sends only the changed fields, reads back, returns saved, writes an audit row with before and after`
- `PATCH with an unchanged value makes no POST and writes no audit row`
- `PATCH when the live value differs from expected → 409 stale and no POST`
- `PATCH when Meta says success but keeps the old value → the field is in not_saved`
- `PATCH when Meta refuses → 409 with Meta's message and code, audit result refused`
- `PATCH on timeout with a matching read-back → 200 saved`
- `PATCH with name in changes → 400`
- `PATCH on an instagram account → 409`
- `no response or audit row contains the token`

`apps/suite/src/features/page-details/page-details-logic.test.ts`: `changedKeys ignores formatting-only differences`, `beforeAfterRows shows "Not set" for empty values`, `hoursText renders one range, two ranges, closed and always open`.

## 10. Manual check

On a non-production server connected to a **test** Page (not the live "Mrs Samuel fruit juice" Page):

1. Channels → the Page → "Page details". The values match the Page's About section on Facebook.
2. Change the short description and the phone. Press "Review and save…". The dialog shows only those two rows, with the old and new values. Save. Toast "Saved". Reload Facebook: both changed.
3. Set Monday to two opening times (8:00 to 12:00 and 14:00 to 18:00) and Sunday closed. Save. Check on Facebook.
4. Enter a closing time of 07:00 for a day that opens at 20:00: the form refuses with the 6:00 am message.
5. On Facebook, change the website by hand. In the suite (without reloading) change the website to something else and save: you get the "changed on Facebook since you opened this page" banner and nothing is sent.
6. Enter an address with a made-up city. Save. If Facebook refuses, the red banner shows Facebook's message and the other fields are unchanged.
7. Open "Recent changes": each save is listed with your name and the before and after.
8. The "Changed on Facebook only" card shows name, username and category, and its button opens the Page on Facebook.
9. Open the Instagram account's "Profile": the profile shows, with the "Instagram does not let apps change a profile" note and no save bar.
10. In Meta Business Settings, reduce the system user's access to the test Page to messaging only; reload: the "not allowed to change it" banner shows and the form is read-only. Restore access.
11. Check everything at 390 px.

## 11. Done when

- [ ] No migration was added. Lint and type-check pass.
- [ ] All tests in section 9 pass; no test reaches the real Meta API.
- [ ] Description, longer description, phone, website, emails, opening hours and address can be changed from the suite and show on Facebook.
- [ ] Every save shows a before-and-after, needs a confirm, sends only changed fields, is read back, and writes an audit row.
- [ ] Name, username, category and pictures are shown read-only with a working link to Facebook.
- [ ] The Instagram profile is read-only with the plain explanation.
- [ ] A refusal or timeout never shows as saved, and never returns a 500.
- [ ] The manual check passes, including at 390 px.
- [ ] The pull request states what was found for each [unverified] fact (P7, P14, P15, P16, P17).

## 12. Out of scope

Changing the Page's name, username or category; the cover photo; publishing or unpublishing the Page; temporary closures (`temporary_status`); price range, services, payment options and other restaurant fields; Page roles and people; the call-to-action button on the Page; editing anything on Instagram; the WhatsApp business profile (spec 05); the profile picture unless Phase B is asked for.

## 13. Work order

1. `packages/shared/src/page-details.ts` with its tests.
2. With the Graph API Explorer on a test Page, check P7, P14, P15, P16, P17 and the `cover` sub-field name; write what you found at the top of the pull request and adjust `pageUpdateBody` and rule R8 if needed.
3. `packages/domain/src/meta/page-details.ts` with unit tests for `pageUpdateBody`.
4. Routes (`GET`, `PATCH`, `GET /history`), the 60-second cache, the outbox alert case; integration tests.
5. Suite screen: api and logic files with tests; locked card; form and hours editor; save dialog; banners; Instagram card; recent changes; route; links from the Channels screen.
6. Manual check on a test Page; pull request.
7. (Only if asked) Phase B profile picture.

## 14. Open questions

| # | Question | Default so work is not blocked |
|---|---|---|
| Q1 | **The brief for this spec says category cannot be changed through the API. Meta's Page reference lists `category_list` (category IDs) as an updatable parameter** (P10). | Keep category read-only with the link to Facebook: choosing a category needs a search over Meta's category IDs, which is not worth building for one Page. Reopen if the owner asks |
| Q2 | **The foundation says the Page is assigned to the system user "with messaging rights". Updating needs the MANAGE task** (P6). | Build the detection and the banner (section 7). The owner raises the system user's access to full control before go-live |
| Q3 | Does `business_management` have to be on the token for anything here? | Only for the cover photo (P11), which is out of scope. Not needed otherwise |
| Q4 | How are fields cleared (P14)? | Send `""` / `[]`; report honestly from the read-back (rule R8); do not offer clearing all hours |
| Q5 | Should a manager be allowed to edit the Page? | No. `channels.manage` is owner and admin |
| Q6 | Should the suite also offer "Temporarily closed" (`temporary_status`), useful on public holidays? | Not in this spec; it is one more field on the same route if the owner wants it |
| Q7 | Meta's pages show Graph `v27.0`; the code default is `v23.0`. | Use `META_GRAPH_VERSION` as set; record the version used in the manual check |

## Built differently

Departures made while building this spec on `work/olu/suite-10-page-details` (stacked on `work/olu/suite-04-chat-setup`, 20 Nov 2026). Work-order tasks 2 (Graph API Explorer check) and 6 (manual check on a test Page) were not done: no Meta account or browser was available. Facts P7, P14, P15, P16, P17 and the `cover.source` sub-field are therefore still **unchecked**, and the integration tests have **not been run** (no Docker). Phase B (profile picture) was not built.

1. **Owner alert** goes through `alertOnce` (spec 02), which dedupes on `payload.account`. The payload carries `account` and `account_id` (both the account row ID) plus `label`, `code`, `message`. `alertOnce`'s event-type list gained `channels.page_config`; the worker case is in `outbox.ts` and also ends with a link to Channels.
2. **Error codes in the API.** `ErrorCode` has no "stale" or "bad gateway", so a stale save is `409` with `error.code = "conflict"` and `error.details.reason = "stale"` (and `details.view`); 502 and 504 use `service_unavailable`. `describePageDetailsError` (domain) is the one classifier; a refusal that is a configuration problem, a block (`368`) or any other refusal answers 409, a temporary one 502, no answer 504.
3. **Refused or timed-out saves still read the Page back** (R7), so a request Meta refused can come back as `200` with some fields saved. Result values in the audit row: `saved`, `partly_saved`, `refused` (Meta refused and nothing changed), `unknown` (no answer, or Meta said yes but the read-back shows the old value; shown as "Not confirmed"). If Meta says yes but the read-back cannot be read, the answer is 504, never "saved".
4. **Always open.** When a save turns Always open on, `hours` is dropped from the request. Turning it off always sends `hours` with it, even if they equal what is stored (R9). On screen Always open and hours are one row ("Opening hours") in the dialog and the history.
5. **Phone comparison** reduces both sides with `toE164` before taking digits, so a Page that returns `0801 234 5678` equals `+2348012345678`.
6. **Clearing the address** sends `location` with empty strings (the spec's table does not say); the read-back decides. Clearing is [unverified] like the other fields (P14).
7. **Strict body.** `expected` and `changes` are strict zod objects, so name, username, category, cover and "published" are `400`, as are different key sets in the two.
8. **Time fields** in the hours editor are text boxes (`08:00`), not time pickers, because `24:00` is a valid closing time and a time picker cannot hold it.
9. **The browser sends a save once** (no retry on 502/503/504), like chat set-up's publish. The history rows also return `not_saved`.
10. **Extra tests**: a switched-off Page still reads; unknown tasks allow editing (R15); busy and permission refusals; a timeout with no effect answers 504; hours are sent as the whole week; a bad phone and a fourth email answer 400. `pageDetailsTimings.readBackDelayMs` (exported by the route) lets tests skip the 1.5 second wait.
11. **No `channels.manage` change**: it already exists (spec 01), held by owner and admin.
