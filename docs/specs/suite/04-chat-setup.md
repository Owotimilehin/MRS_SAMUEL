# Suite build spec 04: Chat set-up for Messenger and Instagram

Size S. Suggested model: Sonnet. Read `00-foundation.md` first; it wins where the two disagree.

How to read the fact marks: **[verified: URL, 19 Nov 2026]** means the fact was read on that page of Meta's developer documentation on 19 Nov 2026 (through a page-reading tool, so wording is paraphrased). **[unverified]** means memory or inference: open the page named beside it before coding against it.

---

## 1. Outcome

A staff member with the "Channels" permission can say:

- "For our Facebook Page I can write the **welcome text** people see before their first message, switch the **Get started** button on, write up to four **starter questions**, and build the **menu** that sits beside the message box."
- "For our Instagram account I can write the starter questions and the menu."
- "I see what is live at Meta right now, a preview of how it will look on a phone, and what will change, before I press Publish."
- "If a publish fails, nothing is lost: my draft is still there and I can try again. I can see who published what, and when."
- "When a customer taps Get started, a starter question or a menu button, it shows in the Inbox as their message, with a note saying what they tapped."

## 2. Depends on

| Needs | Why |
|---|---|
| Spec 01 merged | `ChannelAccount`, `listChannelAccounts`, `pageAccessToken`, exported `graph()` with a per-call token, the `channels.manage` permission, the `/channels` section of the suite |
| Spec 02 (not required to build; required to see taps) | Its handling of `messaging_postbacks` shows taps in the Inbox. Section 5.6 is the contract spec 02 must meet |
| In the Meta app dashboard | Page object subscribed to `messaging_postbacks`; Instagram object subscribed to `messaging_postbacks` [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/ice-breakers, 19 Nov 2026] |
| A tester | With standard access the welcome screen is visible only to people who hold a role on the Meta app [verified: https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/welcome-screen, 19 Nov 2026] |

## 3. Meta reference

One API serves both channels: the **Messenger Profile API**, called with the **Page** access token (`pageAccessToken(cfg, account.pageId)`).

### 3.1 The API

| # | Fact | Mark |
|---|---|---|
| M1 | `GET /me/messenger_profile?fields=<comma list>` returns `{"data": [ {…requested properties…} ]}` (an empty `data` array when nothing is set) | [verified: https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api/, 19 Nov 2026]; the empty-array case is [unverified] |
| M2 | `POST /me/messenger_profile` with a JSON body of properties. "Only properties set in the request body will be overwritten." Returns `{"result": "success"}` | [verified: same page, 19 Nov 2026] |
| M3 | `DELETE /me/messenger_profile` with JSON body `{"fields": ["…"]}`. "Only properties specified in the `fields` array will be deleted." Returns `{"result": "success"}` | [verified: same page, 19 Nov 2026] |
| M4 | Needs a Page access token with `pages_messaging` | [verified: same page, 19 Nov 2026] |
| M5 | "Calls to the Messenger Profile API are limited to 10 API calls per 10 minute interval", per Page | [verified: same page, 19 Nov 2026]. That Instagram-variant calls count against the same Page's 10 is [unverified]; this spec assumes they do |
| M6 | Properties: `get_started` (object), `greeting` (array), `ice_breakers` (array), `persistent_menu` (array), `whitelisted_domains`, `account_linking_url`, `commands`. This spec touches only the first four and never sends or deletes the others | [verified: https://developers.facebook.com/docs/graph-api/reference/page/messenger_profile, 19 Nov 2026] |
| M7 | Instagram variant: the same endpoint with `platform=instagram` (as a query parameter on GET, POST and DELETE in the persistent-menu page; as `"platform": "instagram"` in the JSON body in the ice-breakers page). **Send both** on POST and DELETE; query only on GET | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/persistent-menu, 19 Nov 2026] and [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/ice-breakers, 19 Nov 2026] |
| M8 | A tap arrives as a `messaging_postbacks` webhook: `postback: {mid, title, payload}`. It fires for "a postback button, Get Started button, or persistent menu item". All values are strings. `timestamp` is when Meta sent it, not when the person tapped | [verified: https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messaging_postbacks, 19 Nov 2026] |

### 3.2 Messenger (Facebook Page)

| # | Fact | Mark |
|---|---|---|
| G1 | Greeting: `"greeting": [{"locale": "default", "text": "…"}]`. Shown on the welcome screen before the first message | shape seen in the GET example [verified: https://developers.facebook.com/docs/graph-api/reference/page/messenger_profile, 19 Nov 2026] |
| G2 | Greeting text is at most 160 characters; a `default` locale entry is required; `{{user_first_name}}`, `{{user_last_name}}`, `{{user_full_name}}` are replaced with the person's name | [unverified] the greeting page (https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api/greeting) returned no content on 19 Nov 2026. The suite enforces 160 and offers only `{{user_first_name}}` |
| G3 | Get started: `"get_started": {"payload": "<string>"}`. Tapping it posts "Get Started" into the chat and sends a `messaging_postbacks` webhook. Not supported in the Facebook mobile browser | [verified: https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api/get-started-button, 19 Nov 2026] |
| G4 | The `get_started` payload is at most 1,000 characters | [unverified]. Ours is 11 characters |
| G5 | Ice breakers: `"ice_breakers": [{"locale": "default", "call_to_actions": [{"question": "…", "payload": "…"}]}]`. "A maximum of 4 questions". The `default` locale is required. One request must not mix this format with the old flat format | [verified: https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api/ice-breakers, 19 Nov 2026] |
| G6 | **Ice breakers and the Get started button cannot both show.** Order of precedence: ice breakers set by API, then Get started, then questions typed in Meta's own Page inbox (which become read-only when API ice breakers exist) | [verified: same page, 19 Nov 2026] |
| G7 | Deleting `ice_breakers` deletes all of them, in every locale | [verified: same page, 19 Nov 2026] |
| G8 | Maximum length of an ice-breaker question | [unverified] not stated on the page. The suite enforces 80 characters |
| G9 | Persistent menu: `"persistent_menu": [{"locale": "default", "composer_input_disabled": false, "call_to_actions": [ … ]}]`. Items are `{"type": "postback", "title", "payload"}` or `{"type": "web_url", "title", "url", "webview_height_ratio"}`. Up to 20 items; Meta recommends 5. Title at most 30 characters. Postback payload at most 1,000 characters. At least one entry must have `"locale": "default"` | [verified: https://developers.facebook.com/docs/messenger-platform/send-messages/persistent-menu, 19 Nov 2026] |
| G10 | **The menu requires a Get started button to be set.** | [verified: same page, 19 Nov 2026] |
| G11 | "Page-level persistent menu updates can take up to 24 hours." The menu does not show in the Facebook mobile browser. If `commands` are set they take priority over the menu. It shows only for a published Page | [verified: same page, 19 Nov 2026] |
| G12 | Whether `get_started` and `persistent_menu` may be set in the same POST when `get_started` was not set before | [unverified]. The suite sends two POSTs in that case (section 5.3) |
| G13 | Deleting `get_started` while a menu exists is refused | [unverified]. The suite always deletes the menu in the same DELETE (section 5.3) |

### 3.3 Instagram

| # | Fact | Mark |
|---|---|---|
| N1 | Ice breakers: same shape as G5, at most 4 questions, `default` locale required, **not shown on desktop** | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/ice-breakers, 19 Nov 2026] |
| N2 | Persistent menu: `web_url` and `postback` items; `composer_input_disabled` and `webview_height_ratio` are **not available**; no per-person menus; Meta recommends at most 5 items; "Menus do not update in real time" (people see a change after refreshing their inbox); shown only in the Instagram app on iOS and Android; the business has 24 hours to respond after a tap | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/features/persistent-menu, 19 Nov 2026] |
| N3 | Greeting text and the Get started button do **not** exist on Instagram | [unverified] Meta's Instagram pages document only ice breakers and the persistent menu (index checked 19 Nov 2026: https://developers.facebook.com/documentation/instagram-platform/llms.txt). The suite does not offer them for Instagram and never sends them with `platform=instagram` |
| N4 | The Instagram menu does not need `get_started` | [unverified] the page does not mention it. The suite does not send it |

### 3.4 Errors, permissions, review

- Errors follow foundation D10. In addition treat `613` and HTTP 429 from this endpoint as "the 10-per-10-minutes limit" (M5) and show the wait message in section 7. Meta's error codes for an over-long title, too many items or a bad URL are [unverified]: any refusal is shown with Meta's own message.
- Permissions: `pages_messaging` (requires `pages_manage_metadata`, `pages_show_list`) [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026]; for Instagram `instagram_basic` and `instagram_manage_messages` [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields, 19 Nov 2026].
- **App review:** no extra permission beyond spec 02's (`pages_messaging`, `instagram_manage_messages`). Add one scene to spec 02's screencast: publish a starter question from this screen, open the chat as a tester on a phone, tap the question, and show the tap arriving in the suite's Inbox.

## 4. Data

File `packages/db/migrations/0074_chat_setup.sql`; journal entry `{"idx": 73, "version": "7", "when": 1786500000000, "tag": "0074_chat_setup", "breakpoints": true}` (use a `when` larger than the entry before it). If spec 05 has already created this file for its cache column, append the statements below to it instead of creating a second file.

```sql
-- Chat set-up for Messenger and Instagram (suite spec 04). Additive only: one new table.
-- Each row is one version of the set-up for one channel account: the draft, or a publish attempt.
-- Undo: DROP TABLE channel_chat_setup;

CREATE TABLE IF NOT EXISTS "channel_chat_setup" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('draft','pushing','live','failed','unknown','superseded')),
  "config" jsonb NOT NULL,
  "live_before" jsonb,
  "live_after" jsonb,
  "steps" jsonb,
  "error_code" text,
  "error_message" text,
  "created_by_user_id" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "pushed_by_user_id" uuid REFERENCES "admin_user"("id"),
  "pushed_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_channel_chat_setup_version" ON "channel_chat_setup" ("account_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_channel_chat_setup_draft" ON "channel_chat_setup" ("account_id") WHERE "status" = 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_chat_setup_pushed" ON "channel_chat_setup" ("account_id","pushed_at" DESC);
```

| Status | Meaning |
|---|---|
| `draft` | Being edited. At most one per account |
| `pushing` | A publish is in flight |
| `live` | The last publish that Meta confirmed (read-back matched). At most one per account |
| `superseded` | Was live; a later version replaced it |
| `failed` | Meta refused, or the read-back did not match |
| `unknown` | No answer from Meta and the read-back also failed; nobody knows what is live |

`config` holds a `ChatSetupConfig` (5.1). `live_before` and `live_after` hold what Meta returned before and after the publish (the four properties only). `steps` is an array of `{op: "delete" | "set" | "read", fields: string[], ok: boolean, code: string | null, message: string | null, at: string}`.

**Drizzle:** new file `packages/db/src/schema/channel.ts` exporting `channelChatSetup`, mirroring the SQL; export it from the schema index.

## 5. Server

### 5.1 Shared rules: `packages/shared/src/chat-setup.ts` (new; used by API, worker-free, and the suite)

```ts
export interface ChatSetupMenuItem { type: "postback" | "web_url"; title: string; url?: string }
export interface ChatSetupConfig {
  /** Messenger only. null = no welcome text. */
  greeting: string | null;
  /** Messenger only. Show the Get started button. Forced on when a menu exists (G10). */
  getStarted: boolean;
  /** Starter questions, in order. 0 to 4. */
  iceBreakers: string[];
  /** Menu buttons, in order. 0 to 5. */
  menu: ChatSetupMenuItem[];
}
export const EMPTY_CHAT_SETUP: ChatSetupConfig = { greeting: null, getStarted: false, iceBreakers: [], menu: [] };

export const CHAT_SETUP_LIMITS = {
  greetingMax: 160, iceBreakerCount: 4, iceBreakerMax: 80, menuCount: 5, menuTitleMax: 30, urlMax: 500,
} as const;

export const CHAT_SETUP_PAYLOAD = {
  start: "ms:v1:start",
  ice: (n: number) => `ms:v1:ice:${n}`,     // n = 1..4, position at publish time
  menu: (n: number) => `ms:v1:menu:${n}`,   // n = 1..5, position at publish time
} as const;

/** What a postback payload means, or null when it is not one of ours. */
export function describeChatSetupPayload(payload: string | null | undefined):
  { source: "get_started" | "ice_breaker" | "menu"; index: number | null; caption: string; fallbackTitle: string } | null;

/** Problems a person must fix, in plain English. Empty array = valid. */
export function validateChatSetup(config: ChatSetupConfig, kind: "messenger" | "instagram"): { field: string; message: string }[];

/** Trim, drop empty questions, force getStarted when a menu exists (messenger), clear greeting/getStarted for instagram. */
export function normaliseChatSetup(config: ChatSetupConfig, kind: "messenger" | "instagram"): ChatSetupConfig;
```

`describeChatSetupPayload` matches `^ms:v1:(start|ice:([1-4])|menu:([1-9]|1[0-9]|20))$`:

| Payload | `source` | `caption` | `fallbackTitle` |
|---|---|---|---|
| `ms:v1:start` | `get_started` | "Tapped Get started" | "Get started" |
| `ms:v1:ice:N` | `ice_breaker` | "Tapped a starter question" | "Starter question N" |
| `ms:v1:menu:N` | `menu` | "Tapped a menu button" | "Menu button N" |

`validateChatSetup` messages (field → message):

| Check | Message |
|---|---|
| greeting longer than 160 | "The welcome text is too long. Keep it to 160 characters." |
| greeting contains `{{…}}` other than `{{user_first_name}}` | "Only {{user_first_name}} can be used to insert the customer's name." |
| more than 4 questions | "You can have up to 4 starter questions." |
| a question longer than 80 | "Starter question {n} is too long. Keep it to 80 characters." |
| two identical questions (case-insensitive) | "Starter questions {a} and {b} are the same." |
| more than 5 menu buttons | "The menu can have up to 5 buttons." |
| a menu title empty or longer than 30 | "Menu button {n} needs a name of 1 to 30 characters." |
| `web_url` item without a valid `https://` URL up to 500 characters | "Menu button {n} needs a link that starts with https://" |
| `postback` item with a `url` | (silently dropped by `normaliseChatSetup`) |
| instagram with greeting or getStarted | (silently cleared by `normaliseChatSetup`) |

### 5.2 Meta calls: `packages/domain/src/meta/chat-setup.ts` (new; re-export from the package index)

```ts
export type ProfileKind = "messenger" | "instagram";
export interface LiveProfile { get_started?: { payload: string }; greeting?: { locale: string; text: string }[];
  ice_breakers?: { locale?: string; call_to_actions?: { question: string; payload: string }[] }[];
  persistent_menu?: { locale: string; composer_input_disabled?: boolean;
    call_to_actions: { type: string; title: string; payload?: string; url?: string }[] }[] }

export function readMessengerProfile(cfg: MetaConfig, account: ChannelAccount): Promise<LiveProfile>;
export function setMessengerProfile(cfg: MetaConfig, account: ChannelAccount, props: Record<string, unknown>): Promise<void>;
export function deleteMessengerProfile(cfg: MetaConfig, account: ChannelAccount, fields: string[]): Promise<void>;

/** Meta's shape → ours, plus what we could not represent. Pure. */
export function profileToConfig(live: LiveProfile, kind: ProfileKind):
  { config: ChatSetupConfig; otherLocales: string[]; foreignPayloads: boolean; composerDisabled: boolean };
/** Ours → Meta's properties for the default locale. Pure. */
export function configToProfile(config: ChatSetupConfig, kind: ProfileKind): LiveProfile;
/** The ordered calls a publish must make, given what is live. Pure. */
export function planPublish(config: ChatSetupConfig, live: LiveProfile, kind: ProfileKind):
  { op: "delete" | "set"; fields: string[]; body: Record<string, unknown> }[];
/** True when Meta's live state is what `config` asks for (default locale only). Pure. */
export function liveMatches(config: ChatSetupConfig, live: LiveProfile, kind: ProfileKind): boolean;
```

Requests (token = Page token; `{q}` = `?platform=instagram` for Instagram, empty for Messenger):

| Function | Request |
|---|---|
| `readMessengerProfile` | `GET me/messenger_profile?fields=get_started,greeting,ice_breakers,persistent_menu` (Instagram: `fields=ice_breakers,persistent_menu&platform=instagram`). Return `data[0] ?? {}` |
| `setMessengerProfile` | `POST me/messenger_profile{q}` body `props` (Instagram: body also has `"platform": "instagram"`) |
| `deleteMessengerProfile` | `DELETE me/messenger_profile{q}` body `{"fields": fields}` (Instagram: plus `"platform": "instagram"`) |

`configToProfile` output:

- `greeting` (Messenger, when not null): `[{locale: "default", text: greeting}]`.
- `get_started` (Messenger, when `getStarted` or `menu.length > 0`): `{payload: "ms:v1:start"}`.
- `ice_breakers` (when not empty): `[{locale: "default", call_to_actions: iceBreakers.map((q, i) => ({question: q, payload: CHAT_SETUP_PAYLOAD.ice(i + 1)}))}]`.
- `persistent_menu` (when not empty): Messenger `[{locale: "default", composer_input_disabled: false, call_to_actions}]`; Instagram `[{locale: "default", call_to_actions}]`. Items: postback → `{type: "postback", title, payload: CHAT_SETUP_PAYLOAD.menu(i + 1)}`; link → Messenger `{type: "web_url", title, url, webview_height_ratio: "full"}`, Instagram `{type: "web_url", title, url}`.

`profileToConfig`: read the entry whose `locale` is `default` (or the first entry when none is marked); list every other locale in `otherLocales`; `foreignPayloads = true` when any payload read does not match `describeChatSetupPayload`; `composerDisabled = true` when the live default menu has `composer_input_disabled: true`; menu items of any other type are dropped and also set `foreignPayloads`; cut lists to the suite's limits.

### 5.3 Publishing: `publishChatSetup` in the same file

```ts
export function publishChatSetup(db: DbClient, cfg: MetaConfig, input: { accountId: string; version: number; userId: string }):
  Promise<typeof channelChatSetup.$inferSelect>;
```

1. Load the row; its status must be `draft`, `failed` or `unknown`, else throw `ChatSetupError("not_publishable")`. Validate `config` again; problems → `ChatSetupError("invalid", first message)`.
2. Rate guard (M5): count rows for accounts with the same `pageId` whose `pushed_at > now() - interval '10 minutes'`. If 2 or more → `ChatSetupError("too_soon", …)` carrying the time the oldest of them leaves the window.
3. `UPDATE … SET status = 'pushing', pushed_by_user_id, pushed_at = now(), steps = '[]', error_code = NULL, error_message = NULL WHERE id = $id AND status IN ('draft','failed','unknown') RETURNING id`. No row → someone else is publishing: `ChatSetupError("busy")`.
4. `live = readMessengerProfile(…)`; store as `live_before`; append a `read` step.
5. `plan = planPublish(config, live, kind)`:
   - **Delete step** (first, only if not empty): every one of the four properties that is present in `live` and absent from `configToProfile(config, kind)`. If `get_started` is in the list and `persistent_menu` is live, `persistent_menu` must be in the list too (it always will be, because a menu forces `get_started`; assert it).
   - **Set step A:** `greeting`, `get_started`, `ice_breakers` from `configToProfile` (those present), plus `persistent_menu` when present **and** (`kind === "instagram"` or `live.get_started` exists).
   - **Set step B** (Messenger only, when there is a menu and `live.get_started` did not exist): `persistent_menu` alone (G10, G12).
   - Skip a set step that is empty. Skip the whole plan when `liveMatches(config, live, kind)` and `otherLocales` is empty: go to step 7.
6. Run the steps in order, appending each result to `steps`. Stop at the first failure.
7. Read back: `after = readMessengerProfile(…)`; store `live_after`; append a `read` step. Then:
   - Every step ok and `liveMatches(config, after, kind)` → this row `live`; any other row of the account with status `live` → `superseded` (same transaction).
   - A step failed with a structured Meta error → `failed`, with `error_code`, `error_message` from that error.
   - Steps ok but read-back differs → `failed`, `error_message = "Meta accepted the change but is not showing it yet"` (rule R9).
   - A step timed out (`delivery === "unknown"`): if the read-back worked, decide by `liveMatches` (`live` or `failed`); if the read-back also failed → `unknown`.
8. If the row ended `failed` or `unknown` and the account has no `draft` row, nothing else is needed: a failed row stays editable through `PUT /draft` (5.4), which copies it into a new draft.
9. Errors of class *configuration* (D10) also raise one owner alert per account per 24 hours through `outbox_event` (`eventType: "channels.chat_setup_config"`, payload `{account_id, label, code, message}`); add the matching `case` in `apps/worker/src/outbox.ts` with the text `Chat set-up: Meta refused a change for {label}: {message} (code {code}). Open Channels in the suite to check the connection.`

A publish makes at most 5 Graph calls (read, delete, set, set, read). Two publishes in 10 minutes is the cap, which leaves room for nothing else; hence the read cache in 5.4.

### 5.4 Routes: `apps/api/src/routes/channel-chat-setup.ts` (new)

`export function channelChatSetupRoutes(db: DbClient)`. Register in `apps/api/src/test-app.ts` **before** any `/v1/channels` router from spec 01 so the longer path wins: `app.route("/v1/channels/:accountId/chat-setup", channelChatSetupRoutes(db));`. Every route: `requireAuth()`, `requireCapability("channels.manage")`. `:accountId` must be a uuid of an `inbox_phone_number` row with `kind` `messenger` or `instagram`; otherwise 404 "not found". `kind = 'phone'` → 404.

**Live read cache.** A module-level `Map<pageId + kind, {at: number, live: LiveProfile}>`, 5 minutes. `GET /` uses it; `POST /refresh` and every publish replace it. `POST /refresh` is refused (429) if the cached read is younger than 3 minutes or 2 publishes sit in the 10-minute window (one publish of 5 calls plus 3 refreshes stays under Meta's 10).

```ts
interface ChatSetupView {
  account: { id: string; label: string; kind: "messenger" | "instagram" };
  supports: { greeting: boolean; getStarted: boolean; iceBreakers: true; menu: true };   // first two true only for messenger
  limits: typeof CHAT_SETUP_LIMITS;
  draft: { version: number; config: ChatSetupConfig; updated_at: string; updated_by_name: string | null } | null;
  live: { config: ChatSetupConfig; other_locales: string[]; foreign_payloads: boolean; composer_disabled: boolean; read_at: string } | null;
  live_error: string | null;            // plain-English reason when Meta could not be read
  draft_differs_from_live: boolean;
  last_publish: { version: number; status: "pushing" | "live" | "failed" | "unknown" | "superseded";
                  by_name: string | null; at: string; error_message: string | null; error_code: string | null } | null;
  can_publish_at: string | null;        // ISO time when the rate guard next allows a publish; null = now
}
```

| Method and path | Request | Response and behaviour | Audit |
|---|---|---|---|
| `GET /` | — | `{data: ChatSetupView}`. If Meta cannot be read, `live = null` and `live_error` is set; the route still answers 200. No token is ever in the response | — |
| `PUT /draft` | `{config: ChatSetupConfig}` | Normalise, validate (400 with the first message on a problem). Update the account's `draft` row, or insert one with `version = max(version) + 1`. `{data: ChatSetupView}` | `channels.chat_setup_draft`, entity `channel_chat_setup`, before/after config, `notify: false` |
| `POST /draft/from-live` | — | Replace the draft with `profileToConfig(live).config` (fresh read through the cache). `{data: ChatSetupView}`. 409 "We could not read the live set-up from Meta. Try again in a few minutes." if no live read | same action |
| `DELETE /draft` | — | Delete the draft row (a draft holds no history). `{data: ChatSetupView}` | same action |
| `POST /publish` | `{version: number, confirm: true}` | `confirm` must be literally `true` (400 otherwise). Calls `publishChatSetup`. 200 `{data: ChatSetupView}` when the row ended `live`; 502 `{data: ChatSetupView}` when `failed` or `unknown` (the view carries the reason); 409 `invalid`, `not_publishable`, `busy` ("Someone else is publishing this right now."); 429 `too_soon` ("Meta allows only a few set-up changes every 10 minutes. You can publish again at {HH:MM}.") | `channels.chat_setup_publish`, entity `channel_chat_setup`, entity id = row id, `before = live_before` (as config), `after = {config, status, error_code}`, `notify: true` |
| `POST /refresh` | — | Re-read Meta; `{data: ChatSetupView}`; 429 "Checked a moment ago. Try again in a few minutes." | — |
| `GET /history` | `?limit` (default 20, max 50) | `{data: [{version, status, config, by_name, at, error_message}]}` newest first, excluding the draft | — |
| `POST /history/:version/restore` | — | Copy that version's `config` into the draft (creating one if needed). `{data: ChatSetupView}` | `channels.chat_setup_draft` |

Meta error → `live_error` / `error_message` wording: configuration → "The suite has lost its permission for this account. Ask the owner to check Channels."; temporary → "Meta is busy. Nothing was changed. Try again in a few minutes."; rate limit → "Meta allows only a few set-up changes every 10 minutes. Try again shortly."; refusal → "Meta refused this: {Meta's message} (code {code})."; no answer → "No answer from Meta, so we can't tell what is live. Press Check now in a minute."

### 5.5 Files changed elsewhere

`apps/api/src/test-app.ts` (route), `apps/worker/src/outbox.ts` (alert case), `packages/shared/src/index.ts` and `packages/domain/src/index.ts` (exports). If `channels.manage` is not yet in `CAPABILITIES` (spec 01 adds it), add it and grant it to admin; not to manager.

### 5.6 Contract with spec 02: how a tap shows in the Inbox

This spec defines these payload strings and no others: `ms:v1:start`, `ms:v1:ice:1` … `ms:v1:ice:4`, `ms:v1:menu:1` … `ms:v1:menu:5` (the pattern accepts up to `menu:20` for the future).

When spec 02's ingestion receives a `messaging_postbacks` event (Messenger or Instagram), it must:

1. Store one **inbound** `inbox_message`: `type = "interactive"`, `wa_message_id = postback.mid` (when `mid` is missing use `pb:{sender id}:{timestamp}` so a retry cannot duplicate it), `status = "received"`, `payload = {"postback": {"payload": <payload>, "title": <title or null>}}`.
2. Set `body` to `postback.title`; when the title is missing, to `describeChatSetupPayload(payload)?.fallbackTitle`; when that is also null, to "Tapped a button".
3. Treat it as the customer writing: raise unread, set `last_inbound_wa_at` (a tap opens the 24-hour window; verified for the Instagram menu in N2, [unverified] for Messenger), publish `message.created` with `direction: "in"`.
4. The timeline (`apps/admin/src/components/inbox/Timeline.tsx`) shows the body as the customer's bubble and, under it in small grey text, `describeChatSetupPayload(payload)?.caption` ("Tapped Get started", "Tapped a starter question", "Tapped a menu button"); for any other payload the caption is "Tapped a button". The list preview is the body.

A `web_url` menu button opens the link on the customer's phone and sends **no** webhook; nothing appears in the Inbox. No automatic answer is sent for any tap in this spec (foundation rule 7); staff reply as to any message.

## 6. Worker

No new job. Nothing is pushed to Meta unattended. The only worker change is the alert `case` in `apps/worker/src/outbox.ts` (5.3 step 9).

A row stuck in `pushing` for more than 2 minutes (the API process died mid-publish) is repaired on the next `GET /` for that account: set it to `unknown` with `error_message = "The publish was interrupted. Check what is live, then publish again."`.

## 7. Screens

New files in `apps/suite/src/features/chat-setup/`:

| File | Holds |
|---|---|
| `ChatSetupPage.tsx` | The page. Exports `ChatSetupPage({ accountId })` |
| `GreetingEditor.tsx`, `StarterQuestionsEditor.tsx`, `MenuEditor.tsx` | The three editors |
| `ChatPreview.tsx` | The phone preview |
| `PublishDialog.tsx` | Confirm with before/after, built on `@admin/components/ConfirmModal.js` |
| `HistoryPanel.tsx` | Past versions |
| `chat-setup-api.ts` | `chatSetupApi`, `chatSetupKeys` (keys start `["channels", "chat-setup", accountId]`) |
| `chat-setup-logic.ts`, `chat-setup-logic.test.ts` | Pure helpers: `diffSetup(live, draft)`, `previewModel(config, kind)`, `publishBlockedReason(view, now)` |
| `chat-setup.css` | Styles, prefix `cs-` |

**Route** (`apps/suite/src/router.tsx`): `/channels/$accountId/chat-setup`. **Entry point:** on each Page and Instagram account in spec 01's Channels screen, a link "Chat set-up" (add it to that screen's account row).

**Page frame:** title "Chat set-up", crumb "Channels". Under the title: the account label and "Facebook Messenger" or "Instagram".

**Status strip** (top), one of:

| Condition | Text |
|---|---|
| live read ok, no draft or draft equals live | green: "This is what customers see now. Last checked {time}." and a link "Check now" |
| draft differs from live | amber: "You have changes that are not published yet." |
| last publish `failed` | red: "The last publish did not go through. {error_message}" and a button "Try again" (opens the publish dialog) |
| last publish `unknown` | amber: "We can't tell if the last publish went through. Press Check now." |
| `live_error` | red: "We could not read the set-up from Meta. {live_error}" and "Check now" |
| `live.other_locales` not empty | grey note: "This account also has set-up in other languages ({list}). Publishing from here replaces all of them with one version." |
| `live.foreign_payloads` | grey note: "Some buttons were set up outside the suite. Publishing replaces them. If another tool answers those buttons, it will stop getting the taps." |
| `live.composer_disabled` | grey note: "The message box is switched off for customers on this Page. Publishing from here switches it back on." |

**Editors** (left column on desktop; stacked above the preview at 390 px):

1. **Welcome text** (Messenger only). Label "Welcome text", help "Shown before someone sends their first message." A textarea with a counter "`{n}` / 160" and a button "Insert first name" (adds `{{user_first_name}}`). Empty = no welcome text.
2. **Get started button** (Messenger only). A switch "Show a Get started button", help "People tap it to start the chat. You will see “Get started” arrive in the Inbox." When the menu has buttons the switch is on and disabled with "Needed while the menu is on." When there are starter questions, show the note: "Starter questions are shown instead of the Get started button." (G6).
3. **Starter questions**. Label "Starter questions", help "Up to 4 questions people can tap to start a chat. The question is sent to you as their first message." Instagram adds: "Shown in the Instagram app on phones, not on computers." Rows with a text box (counter to 80), up, down and "Remove"; a button "Add a question" (hidden at 4).
4. **Menu**. Label "Menu", help "Buttons that are always available beside the message box. Up to 5." Messenger adds: "Changes can take up to a day to reach everyone." Instagram adds: "People see changes after they refresh their messages." Each row: name (counter to 30); a choice "Sends a message to you" / "Opens a web page"; for a web page, a link box (placeholder `https://www.mrssamuel.com`); up, down, "Remove". Button "Add a button" (hidden at 5).

Validation messages from `validateChatSetup` show under the field they belong to, as the person types (after first blur).

**Buttons** (sticky bar at the bottom): "Save draft" (`PUT /draft`; toast "Draft saved"), "Discard changes" (`DELETE /draft`, after a `ConfirmModal` "Discard your changes?" / "Your draft will be replaced by what is live now." / "Discard"), "Publish…" (saves the draft first, then opens the dialog). "Publish…" is disabled, with the reason beside it, when: there are validation problems ("Fix the problems above first."); nothing differs from live ("Nothing to publish."); `can_publish_at` is in the future ("You can publish again at {HH:MM}."); Meta could not be read ("We need to read the live set-up first. Press Check now.").

When there is no draft and something is live: the editors show the live values (editing starts a draft). When nothing is live and there is no draft: the editors are empty with the note "Nothing is set up yet. Add a welcome text, questions or a menu, then publish."

**Preview** (`ChatPreview.tsx`), a phone-shaped frame, updates as the person types, with two tabs "Before the first message" and "Menu":

- Messenger, before the first message: the account label as the chat title, the welcome text (with `{{user_first_name}}` shown as "Ada"), then the starter questions as tappable-looking chips **or**, when there are none and Get started is on, a "Get started" button. Nothing set → "Customers see an empty chat."
- Instagram, before the first message: the starter question chips, or "Customers see an empty chat."
- Menu tab: the buttons as a list, links marked with a small arrow icon. None → "No menu."
- Under the frame, small grey: "A rough picture. The real look depends on the customer's phone and app."

**Publish dialog** (`PublishDialog.tsx`): title "Publish chat set-up?". Body: "This changes what customers see on **{account label}** ({Messenger | Instagram}) straight away." Then a table with one row per part that changes (rows that do not change are left out), columns "Now" and "After publishing":

| Row label | Cell content |
|---|---|
| "Welcome text" | the text, or "None" |
| "Get started button" | "On" / "Off" |
| "Starter questions" | a numbered list, or "None" |
| "Menu" | a numbered list: name, and "→ link" for web pages; or "None" |

Then the applicable notes from the status strip (other languages, outside buttons, message box). Confirm "Publish now" / busy "Publishing…". On 200: close, toast "Published. Customers see the new set-up." On 502: keep the dialog closed, show the red status strip. On 429: toast with the server's message.

**History** (`HistoryPanel.tsx`, collapsed section "Past versions"): rows "{date and time, Lagos} · {by_name} · {Published | Replaced | Failed | Not confirmed}" with "View" (shows the config read-only in the preview) and "Use as draft" (`POST /history/:version/restore`, toast "Copied into your draft").

**States:** loading → `DataState`; load error → `DataState` with retry; no permission → `<div className="empty">` title "No access", text "Ask the owner if you need to change the chat set-up."; account not found or a phone number → "This account has no chat set-up."

## 8. Rules and edge cases

- **R1.** Instagram never receives `greeting` or `get_started`; the server strips them even if a client sends them.
- **R2.** A Messenger menu always publishes `get_started` with it, whatever the switch says (G10).
- **R3.** Removing the last menu button and switching Get started off removes both in one DELETE call.
- **R4.** Starter questions and Get started may both be saved; the screen says the questions win (G6). Nothing is blocked.
- **R5.** A publish sends only `get_started`, `greeting`, `ice_breakers`, `persistent_menu`. It never deletes or sets `whitelisted_domains`, `account_linking_url` or `commands`.
- **R6.** A publish with nothing to change makes no set or delete call and ends `live`.
- **R7.** Two people publishing at once: the second gets 409 "Someone else is publishing this right now."
- **R8.** A third publish for the same Page inside 10 minutes is refused before any call to Meta (429), counting Messenger and Instagram publishes together.
- **R9.** Meta said yes but the read-back differs: the row is `failed` with "Meta accepted the change but is not showing it yet"; "Check now" a minute later re-reads, and if it now matches, the row is set to `live` (the `GET /` route does this comparison for the latest `failed` or `unknown` row every time it has a fresh live read).
- **R10.** A failed step leaves earlier steps applied (for example the delete happened, the set did not). The status strip says the publish failed; the live view shows the true current state from the read-back; "Try again" re-plans from that state.
- **R11.** A draft is never changed by a publish failure.
- **R12.** Editing after a failed publish: `PUT /draft` creates a new draft version; the failed row stays in history.
- **R13.** Positions define payloads: the second question always sends `ms:v1:ice:2`. The Inbox shows the question text from the webhook's `title`, so reordering never mislabels a tap.
- **R14.** Set-up made in Meta's own screens after the last publish is detected on the next read: `draft_differs_from_live` and the status strip reflect it; the last `live` row is left as it is.
- **R15.** No route returns or logs the Page token; `live_before`, `live_after` and `steps` contain no token.
- **R16.** Every publish writes one audit row, whether it ended live, failed or unknown.
- **R17.** A deactivated account (`isActive = false`): `GET` works (read-only view, banner "This account is switched off in Channels."); draft and publish routes answer 409.

## 9. Tests

`packages/shared/src/chat-setup.test.ts`:
- `describeChatSetupPayload: start, ice 1-4, menu 1-20; rejects ice:5, menu:0, other strings, null`
- `validateChatSetup: greeting over 160; unknown token; 5 questions; duplicate questions; 6 menu buttons; title over 30; http link refused`
- `normaliseChatSetup: trims, drops empty questions, forces getStarted with a menu on messenger, clears greeting and getStarted on instagram`

`packages/domain/src/meta/chat-setup.test.ts`:
- `configToProfile: messenger full set-up produces the four properties with ms:v1 payloads`
- `configToProfile: instagram omits greeting, get_started, composer_input_disabled and webview_height_ratio`
- `profileToConfig: reads the default locale, lists other locales, flags foreign payloads and a disabled composer`
- `planPublish: nothing live → set A without menu, then set B with menu (messenger)`
- `planPublish: get_started already live → one set call`
- `planPublish: instagram → one set call including the menu`
- `planPublish: removing everything → one delete with all live fields, no set`
- `planPublish: removing get_started always removes persistent_menu in the same delete`
- `planPublish: unchanged → empty plan`
- `liveMatches: order of questions matters; extra locales do not`

`apps/api/test/integration/channel-chat-setup.test.ts` (Graph stub keeps an in-memory profile per `platform`, applies POST and DELETE to it, answers GET from it, and can be told to fail or time out the next call):
- `needs channels.manage; a phone account answers 404`
- `GET shows the live set-up read from Meta and no draft`
- `PUT /draft validates and stores one draft per account`
- `publish: sends delete then set, reads back, marks the row live and the previous live row superseded, writes an audit row`
- `publish: instagram calls carry platform=instagram and never greeting or get_started`
- `publish: Meta refusal → 502, row failed with Meta's code, draft content unchanged`
- `publish: timeout then matching read-back → live`
- `publish: timeout then failing read-back → unknown`
- `publish: third publish within 10 minutes → 429 and no Graph call`
- `publish without confirm:true → 400`
- `restore copies an old version into the draft`
- `no response body contains the token`

`apps/suite/src/features/chat-setup/chat-setup-logic.test.ts`: `diffSetup lists only the parts that changed`, `publishBlockedReason covers invalid, unchanged, rate-limited and unread-live`, `previewModel shows questions instead of Get started when both are set`.

## 10. Manual check

On a non-production server, with a tester who holds a role on the Meta app:

1. Open Channels → the Page → "Chat set-up". The status strip says what is live.
2. Write the welcome text "Hello {{user_first_name}}, welcome to Mrs. Samuel Fruit Juice.", add two starter questions ("What juices do you have today?", "Do you deliver to my area?"), add menu buttons "Talk to us" (message) and "Our shop" (link to the storefront). Watch the preview change.
3. Press Publish. Check the dialog lists exactly those changes. Confirm. The strip turns green.
4. As the tester on a phone, open a **new** Messenger chat with the Page (delete the old chat first): the welcome text and the two questions show. Tap a question. In the suite's Inbox the question appears as the customer's message with "Tapped a starter question" under it.
5. Open the menu in Messenger (allow up to a day, G11), tap "Talk to us": the Inbox shows "Talk to us" with "Tapped a menu button".
6. Remove both questions, publish. Start a fresh chat as the tester: the Get started button shows. Tap it: the Inbox shows "Get started" with "Tapped Get started".
7. Publish twice more quickly: the third is refused with the "publish again at" message.
8. Repeat 2 to 5 for the Instagram account (questions and menu only), checking in the Instagram app on a phone.
9. In Meta Business Suite, change a starter question by hand. Back in the suite press "Check now": the strip shows the difference.
10. "Past versions" lists every publish with your name. "Use as draft" on the first one restores it.
11. Check the whole screen at 390 px.

## 11. Done when

- [ ] Migration 0074, journal entry and Drizzle schema match; lint and type-check pass.
- [ ] All tests in section 9 pass; no test reaches the real Meta API.
- [ ] Welcome text, Get started, starter questions and menu can be published for a Page; starter questions and menu for Instagram.
- [ ] Every publish needs the confirm dialog, sends `confirm: true`, and writes an audit row with before and after.
- [ ] A failed publish keeps the draft, shows Meta's reason in plain English, and can be retried.
- [ ] The live state is read back after every publish and shown.
- [ ] No more than 2 publishes per Page in 10 minutes reach Meta.
- [ ] Taps show in the Inbox as section 5.6 says (with spec 02 merged).
- [ ] The manual check passes on both channels and at 390 px.

## 12. Out of scope

More than one language (locale); switching the customer's message box off (`composer_input_disabled`); per-person menus; `commands`, `whitelisted_domains`, `account_linking_url`; automatic answers to a tap; nested menus; WhatsApp (its welcome and ice-breaker features belong to spec 05); the Page's "frequently asked questions" typed in Meta's own inbox.

## 13. Work order

1. `packages/shared/src/chat-setup.ts` with its tests (limits, payloads, validate, normalise, describe).
2. Migration 0074, journal, Drizzle schema.
3. `packages/domain/src/meta/chat-setup.ts`: pure functions (`configToProfile`, `profileToConfig`, `planPublish`, `liveMatches`) with tests.
4. Check the [unverified] facts G2, G12, G13, N3, N4 against a test Page by hand with the Graph API Explorer; adjust `planPublish` if Meta behaves differently and note it in the pull request.
5. The three Graph functions and `publishChatSetup`.
6. Routes, the read cache, the rate guard; integration tests; the outbox alert case.
7. Suite screen: api and logic files with tests; editors; preview; publish dialog; history; route; link from the Channels screen.
8. With spec 02 present: confirm its postback handling meets 5.6, and add the caption to the timeline if it does not.
9. Manual check; pull request.

## 14. Open questions

| # | Question | Default so work is not blocked |
|---|---|---|
| Q1 | Greeting limits and name tokens (G2) could not be read from Meta's page. | Enforce 160 characters and offer only `{{user_first_name}}`; test on a real Page in work-order step 4 |
| Q2 | Does Instagram have a greeting or Get started (N3)? | Treat as not supported; do not show the fields for Instagram |
| Q3 | Do Messenger and Instagram profile calls share one 10-per-10-minutes budget (M5)? | Assume yes and count them together |
| Q4 | Menu size: Meta allows 20 on Messenger, recommends 5. | Cap at 5 on both channels; raise later by changing `CHAT_SETUP_LIMITS.menuCount` |
| Q5 | Foundation section 6 says spec 05 may put "a small cache column" in 0074. | Whoever lands second appends to the same file; this spec's statements are self-contained and idempotent |
| Q6 | Should managers be able to publish? | No. `channels.manage` goes to owner and admin (foundation D8 leaves this to the spec) |
| Q7 | Meta's pages show Graph `v27.0`; the code default is `v23.0`. | Use `META_GRAPH_VERSION` as set; record the version used in the manual check |
| Q8 | The exact name of spec 02's postback handler is not known here. | Section 5.6 is the contract; whichever spec lands second makes the two agree |
