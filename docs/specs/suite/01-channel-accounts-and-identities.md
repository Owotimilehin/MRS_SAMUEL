# Suite build spec 01 — Channel accounts and customer identities

Read `00-foundation.md` first. This spec turns foundation decisions **D1, D2, D3, D5 and D13** into work. It adds no new way to talk to customers by itself; it lays the ground that specs 02, 03, 04, 09, 10, 11, 12 and 13 stand on. Size M. Suggested model: Opus.

Meta facts are marked **[verified: URL, 19 Nov 2026]** (read on Meta's developer site on that date) or **[unverified]**. Before coding against an unverified fact, read the page.

---

## 1. Outcome

When this is finished, staff can say:

- "On the **Channels** page I can see every place customers reach us: our WhatsApp and phone lines, our Facebook Page and our Instagram account."
- "I can **connect** our Facebook Page and its Instagram account by picking them from a list. I do not type any IDs."
- "For each channel I can set its **name**, the **team** new chats go to, and its **opening hours**, and I can **switch it off**."
- "A customer who writes on WhatsApp and on Instagram can be **one contact**. Once I merge them, they stay merged: the next message from either place lands on the same contact."
- "On the contact panel I can see **every way this customer has reached us** (WhatsApp number, Facebook name, Instagram username)."
- "A WhatsApp customer who has hidden their phone number still arrives in the inbox." (Today such a message is silently dropped; see rule R14.)

Nothing changes for staff who only use WhatsApp and calls, except the last two points.

## 2. Depends on

- **Specs:** none.
- **Branch:** start from `origin/master` once `work/olu/suite-app` is merged (it holds `apps/suite`). If it is not merged yet, branch from `work/olu/suite-app`.
- **In Meta (already true on 19 Nov 2026, per the blueprint):** the system-user token in `META_SYSTEM_USER_TOKEN` can reach the Page "Mrs Samuel fruit juice" and the Instagram account linked to it. Nothing else is needed for this spec. Receiving messages needs more; that is spec 02.
- **Not needed:** app review, business verification, the Messenger or Instagram products on the app.

## 3. Meta reference

| # | Fact | Status |
|---|---|---|
| M1 | `GET /{user-id}/accounts` (or `/me/accounts`) returns "the Facebook Pages that a person owns or is able to perform tasks on". Each item is a Page node plus `tasks` ("the User's tasks assigned to the Page", a list of enums). Paged with `paging.next` | [verified: https://developers.facebook.com/docs/graph-api/reference/user/accounts/, 19 Nov 2026] |
| M2 | `/me/accounts` returns Pages with `access_token` and `id`; a Page token is also obtained with `GET /{page-id}?fields=access_token` using the user token | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/get-started, 19 Nov 2026] |
| M3 | Page field `access_token` is "only returned if the User making the request has a role (other than Live Contributor) on the Page" | [verified: https://developers.facebook.com/docs/graph-api/reference/page/, 19 Nov 2026] |
| M4 | M1 to M3 also work when the caller is a **system user** token (not a person) | [unverified] The blueprint records that the live token reached the Page on 19 Nov 2026, but no Meta page read for this spec says so. Section 5.6 has a fallback (type the Page ID) |
| M5 | Page field `instagram_business_account` is the "Instagram account linked to page during Instagram business conversion flow"; reading it needs a token from someone able to perform tasks on the Page. `connected_instagram_account` is the "Instagram account connected to page via page settings" | [verified: https://developers.facebook.com/docs/graph-api/reference/page/, 19 Nov 2026] |
| M6 | The Instagram account node has fields `id`, `username`, `name`, `profile_picture_url`; with Facebook Login it needs `instagram_basic` and `pages_read_engagement` | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user, 19 Nov 2026] |
| M7 | Page task names include `ANALYZE`, `ADVERTISE`, `MODERATE`, `CREATE_CONTENT`, `MANAGE` and, for messaging, `MESSAGING`. A Page token used for messaging must come from someone who can perform `MESSAGING` and `MODERATE` | [verified: https://developers.facebook.com/docs/messenger-platform/overview, 19 Nov 2026] |
| M8 | A token got from a short-lived user token lasts 1 hour; from a long-lived user token it has no expiry | [verified: https://developers.facebook.com/docs/messenger-platform/instagram/get-started, 19 Nov 2026]. Lifetime of a Page token got from a **system-user** token: [unverified]. We re-fetch hourly either way (D13) |
| M9 | Permissions: `pages_show_list` "allows your app to access the list of Pages a person manages"; `pages_manage_metadata` depends on it; `instagram_basic` reads "an Instagram account profile's info" | [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026] |
| M10 | Messenger user IDs "are scoped to a page and, therefore, are page specific" | [verified: https://developers.facebook.com/documentation/business-messaging/messenger-platform/faq, 19 Nov 2026] |
| M11 | An Instagram-scoped ID is created "when someone messages an Instagram Professional account" (one per person per account) | [verified: https://developers.facebook.com/docs/messenger-platform/overview, 19 Nov 2026] |
| M12 | **WhatsApp business-scoped user ID (BSUID).** Format: two-letter country code, a full stop, then up to 128 letters and digits, e.g. `US.13491208655302741918`. Scoped to the business portfolio. In incoming-message webhooks `contacts[].user_id` and `messages[].from_user_id` are always present; `contacts[].wa_id` and `messages[].from` (the phone number) **can be omitted**; `contacts[].profile.username` is present only if the user has a username | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/, 19 Nov 2026] |
| M13 | The phone number is included only if, for that business number, we messaged or called the user, or they messaged or called us, in the last 30 days, or the user is in the Meta-hosted contact book | [verified: same page as M12] |
| M14 | Sending to a BSUID: put it in `recipient` instead of `to` (`{"messaging_product":"whatsapp","recipient_type":"individual","recipient":"<BSUID>","type":"text","text":{"body":"…"}}`). If both are sent, `to` wins. Supported "starting July 2026". Error `131062` when a BSUID recipient is not supported for the message. Meta recommends sending to the phone number where we have one | [verified: same page as M12] |
| M15 | In status webhooks `statuses[].recipient_id` (phone) may be omitted and `recipient_user_id` carries the BSUID | [verified: same page as M12] |
| M16 | System messages (`type: "system"` on the `messages` field): `user_changed_number` carries `user_id`, `previous_user_id`, `wa_id`; `user_changed_user_id` carries `user_id`, `previous_user_id` and a `body` like "User changed from … to …". There is no separate webhook field to subscribe to | [verified: same page as M12]. The exact nesting of those keys inside the message object: [unverified]; rule R16 reads them defensively |
| M17 | Meta's documentation examples use Graph API `v27.0` on 19 Nov 2026 | [verified: https://developers.facebook.com/docs/graph-api/reference/user/accounts/, 19 Nov 2026]. The code default is `v23.0`; see section 14, Q1 |

**Permissions this spec uses** (the token already holds them): `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`, `business_management`. **Nothing to submit for app review in this spec**: every call here reads assets the business itself owns, which standard access allows. No screencast.

**Error handling** follows D10. Concretely for this spec: any `MetaApiError` from the calls in 5.2 is returned to the screen as a plain sentence (5.6); code `190` shows "Meta says our connection has expired. Ask the technical lead to renew it."; codes `10`, `200`, `299` show "Meta says we are not allowed to see this Page. Ask the technical lead to check the Page is assigned to our system user."; anything retryable shows "Meta did not answer. Try again in a minute."

## 4. Data

### 4.1 Migration `packages/db/migrations/0071_channel_accounts_identities.sql`

Write exactly this. Add the journal entry in 4.2. The file is safe to run twice.

```sql
-- Suite spec 01: channel accounts and customer identities.
-- Additive. inbox_phone_number gains kind/external_id/page_external_id/external_name and
-- its e164 becomes nullable (a Page or an Instagram account has no phone number).
-- New table inbox_identity. inbox_conversation gains channel + identity_id; inbox_message
-- gains channel. Back-fills WhatsApp identities from messages already received.
-- No customer row is created, changed or deleted.
-- Undo: DROP INDEX idx_inbox_conv_channel; ALTER TABLE inbox_message DROP COLUMN channel;
--   ALTER TABLE inbox_conversation DROP COLUMN identity_id, DROP COLUMN channel;
--   DROP TABLE inbox_identity; DROP INDEX uq_inbox_number_kind_external;
--   ALTER TABLE inbox_phone_number DROP CONSTRAINT inbox_phone_number_shape_chk,
--     DROP COLUMN external_name, DROP COLUMN page_external_id, DROP COLUMN external_id, DROP COLUMN kind;
--   (delete non-phone rows first) ALTER TABLE inbox_phone_number ALTER COLUMN e164 SET NOT NULL.

ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'phone' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "external_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "page_external_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "external_name" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ALTER COLUMN "e164" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inbox_phone_number" ADD CONSTRAINT "inbox_phone_number_shape_chk" CHECK (
    ("kind" = 'phone' AND "e164" IS NOT NULL)
    OR ("kind" <> 'phone' AND "external_id" IS NOT NULL AND "page_external_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_number_kind_external"
  ON "inbox_phone_number" ("kind","external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_identity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id"),
  "channel" text NOT NULL CHECK ("channel" IN ('whatsapp','messenger','instagram')),
  "account_external_id" text NOT NULL,
  "external_id" text NOT NULL,
  "display_name" text,
  "username" text,
  "profile_pic_url" text,
  "profile_fetched_at" timestamptz,
  "last_seen_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_identity"
  ON "inbox_identity" ("channel","account_external_id","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_identity_customer" ON "inbox_identity" ("customer_id");
--> statement-breakpoint
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "identity_id" uuid REFERENCES "inbox_identity"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_channel" ON "inbox_conversation" ("channel","status","last_activity_at");
--> statement-breakpoint
COMMENT ON COLUMN "inbox_message"."wa_message_id" IS 'Provider message id for every channel: WhatsApp wamid…, Messenger and Instagram mid… (foundation D3). Do not rename.';
--> statement-breakpoint
COMMENT ON COLUMN "inbox_conversation"."last_inbound_wa_at" IS 'When the customer last wrote on this conversation''s channel; drives the 24-hour reply window on all channels (foundation D4). Do not rename.';
--> statement-breakpoint
-- Back-fill 1: one WhatsApp identity per sender number that has actually written to us.
-- The customer is the one the most recent such message's conversation belongs to today,
-- so contacts merged in the past keep their merge.
INSERT INTO "inbox_identity" ("customer_id","channel","account_external_id","external_id","created_at","last_seen_at")
SELECT DISTINCT ON (m."payload"->>'from')
  c."customer_id", 'whatsapp', 'global', m."payload"->>'from', m."created_at", m."created_at"
FROM "inbox_message" m
JOIN "inbox_conversation" c ON c."id" = m."conversation_id"
WHERE m."direction" = 'in' AND m."payload"->>'from' ~ '^[0-9]{8,15}$'
ORDER BY m."payload"->>'from', m."created_at" DESC
ON CONFLICT ("channel","account_external_id","external_id") DO NOTHING;
--> statement-breakpoint
-- Back-fill 2: each conversation remembers who it is with (the last number that wrote in it).
UPDATE "inbox_conversation" c
SET "identity_id" = i."id"
FROM (
  SELECT DISTINCT ON (m."conversation_id") m."conversation_id", m."payload"->>'from' AS wa_id
  FROM "inbox_message" m
  WHERE m."direction" = 'in' AND m."payload"->>'from' ~ '^[0-9]{8,15}$'
  ORDER BY m."conversation_id", m."created_at" DESC
) last
JOIN "inbox_identity" i
  ON i."channel" = 'whatsapp' AND i."account_external_id" = 'global' AND i."external_id" = last.wa_id
WHERE c."id" = last."conversation_id" AND c."identity_id" IS NULL;
```

**Why the back-fill is safe.** It reads only `inbox_message.payload->>'from'`, which is the WhatsApp sender ID Meta gave us (digits, no "+"), never a phone number typed by a person. It writes only to the new table and the new column. `ON CONFLICT DO NOTHING` and `identity_id IS NULL` make a second run a no-op. Customers who have only been called, or only been sent a template, get no identity now; they get one the first time they write (5.3). The inbox holds messages from Meta's test number only, so the two statements touch a handful of rows; no batching is needed. Adding a column with a constant default does not rewrite the table on Postgres 16 (the version in `docker-compose.yml`).

**Why no CHECK on `kind` or on the two `channel` columns.** Foundation rule 2 forbids dropping anything later, and spec 03 may add values. The allowed values are enforced in TypeScript (4.4) and zod.

**Value conventions** (use these constants; define them in 4.4):

| Column | Rule |
|---|---|
| `inbox_phone_number.kind` | `'phone'` \| `'messenger'` \| `'instagram'` |
| `inbox_phone_number.external_id` | phone: `NULL`. messenger: the Page ID. instagram: the Instagram account ID |
| `inbox_phone_number.page_external_id` | phone: `NULL`. messenger: the Page ID (same as `external_id`). instagram: the ID of the Page it is linked to |
| `inbox_phone_number.external_name` | What Meta calls it: the Page name, or the Instagram username without "@". `NULL` for phones |
| `inbox_phone_number.channels` (existing enum) | Set to `'whatsapp'` on every non-phone row, so existing checks like `channels !== "whatsapp"` (may place calls) stay false for them. Meaningful only when `kind = 'phone'` |
| `inbox_identity.channel` | `'whatsapp'` \| `'messenger'` \| `'instagram'` |
| `inbox_identity.account_external_id` | messenger: Page ID. instagram: Instagram account ID. whatsapp: the constant `'global'` (a WhatsApp number is the same person on every business number; a BSUID is the same across this one business) |
| `inbox_identity.external_id` | whatsapp: the `wa_id` (digits, no "+") **or** a BSUID. messenger: the Page-scoped ID. instagram: the Instagram-scoped ID |
| `inbox_conversation.channel`, `inbox_message.channel` | Copied from the line: `phone → 'whatsapp'`, `messenger → 'messenger'`, `instagram → 'instagram'` |
| `inbox_conversation.identity_id` | The identity that most recently wrote in this conversation. `NULL` for threads that only hold calls or business-started messages |

### 4.2 Journal

Append to `packages/db/migrations/meta/_journal.json` (after idx 69):

```json
{ "idx": 70, "version": "7", "when": 1786200000000, "tag": "0071_channel_accounts_identities", "breakpoints": true }
```

### 4.3 Drizzle (`packages/db/src/schema/inbox.ts`)

- `inboxPhoneNumber`: change `e164: text("e164").unique()` (drop `.notNull()`); add `kind: text("kind").notNull().default("phone")`, `externalId: text("external_id")`, `pageExternalId: text("page_external_id")`, `externalName: text("external_name")`. Add the table's third argument with `uqKindExternal: uniqueIndex("uq_inbox_number_kind_external").on(t.kind, t.externalId).where(sql\`external_id is not null\`)`. Rename nothing. Update the section comment to "Business phone numbers and other channel accounts (a Facebook Page, an Instagram account)".
- New `inboxIdentity` table, declared **before** `inboxConversation`, columns exactly as the SQL, with `uq: uniqueIndex("uq_inbox_identity").on(t.channel, t.accountExternalId, t.externalId)` and `idxCustomer: index("idx_inbox_identity_customer").on(t.customerId)`.
- `inboxConversation`: add `channel: text("channel").notNull().default("whatsapp")`, `identityId: uuid("identity_id").references(() => inboxIdentity.id, { onDelete: "set null" })`, and `idxChannel: index("idx_inbox_conv_channel").on(t.channel, t.status, t.lastActivityAt)`. Replace the comment on `lastInboundWaAt` with: "When the customer last wrote on this conversation's channel. Drives the 24-hour reply window on WhatsApp, Messenger and Instagram (foundation D4)."
- `inboxMessage`: add `channel: text("channel").notNull().default("whatsapp")`. Above `waMessageId` add: "Provider message id for every channel: WhatsApp `wamid…`, Messenger and Instagram `mid…` (foundation D3). Do not rename."
- Check `inboxIdentity` is exported from the package index the same way the other inbox tables are.

### 4.4 Shared types (`packages/shared/src/inbox.ts`)

The front ends cannot import `@ms/domain`, so the D13 types live here and `packages/domain/src/meta/accounts.ts` re-exports them.

```ts
export const CHANNEL_KINDS = ["phone", "messenger", "instagram"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const IDENTITY_CHANNELS = ["whatsapp", "messenger", "instagram"] as const;
export type IdentityChannel = (typeof IDENTITY_CHANNELS)[number];
/** account_external_id of every WhatsApp identity. */
export const WHATSAPP_ACCOUNT_KEY = "global";
/** The conversation channel for a line. */
export function channelForKind(kind: ChannelKind): IdentityChannel; // phone→whatsapp, else same word
/** true for "US.1349…" or "US.ENT.1181…"; false for digits-only wa_ids. Regex: /^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$/ */
export function isBsuid(id: string): boolean;
/** Plain name of a channel for screens: "WhatsApp" | "Facebook Messenger" | "Instagram". */
export function channelLabel(channel: IdentityChannel): string;
```

## 5. Server

### 5.1 `packages/domain/src/inbox/meta.ts`

Export `graph` and give it a fifth parameter (D7). Nothing else in the file changes behaviour.

```ts
export async function graph<T>(
  cfg: MetaConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown,
  opts?: { token?: string },   // when set, used as the bearer token instead of cfg.token
): Promise<T>;
```

`buildSendPayload` and `sendMessage` take `to: string | { bsuid: string }`. A string behaves as today. `{ bsuid }` produces the same payload with the key `recipient` instead of `to` (M14).

### 5.2 New file `packages/domain/src/meta/accounts.ts` (re-export from `packages/domain/src/index.ts` with `export * from "./meta/accounts.js";`)

```ts
export type { ChannelKind, IdentityChannel } from "@ms/shared";
export interface ChannelAccount { id: string; kind: ChannelKind; label: string; externalId: string | null; pageId: string | null; isActive: boolean; }

export function listChannelAccounts(db: DbExecutor, kind?: ChannelKind): Promise<ChannelAccount[]>;
export function channelAccountByExternalId(db: DbExecutor, kind: ChannelKind, externalId: string): Promise<ChannelAccount | null>;
export function pageAccessToken(cfg: MetaConfig, pageId: string): Promise<string>;
export function clearPageTokenCache(pageId?: string): void;                 // extra: tests, and after a 190
export function withPageToken(cfg: MetaConfig, pageId: string): Promise<MetaConfig>; // extra: { ...cfg, token: <page token> }

export interface ConnectablePage {
  pageId: string; name: string; tasks: string[]; canMessage: boolean;      // canMessage = tasks includes "MESSAGING"
  instagram: { id: string; username: string | null } | null;
}
export function listConnectablePages(cfg: MetaConfig): Promise<ConnectablePage[]>;
export function describePage(cfg: MetaConfig, pageId: string): Promise<ConnectablePage>;
```

Exact behaviour:

- **`listChannelAccounts`** — `select` from `inbox_phone_number`, optional `where kind = $kind`, `order by label asc`. Returns active **and** inactive rows; callers filter. Mapping: `externalId = external_id`, `pageId = page_external_id`.
- **`channelAccountByExternalId`** — one row by `(kind, external_id)`, active or not, or `null`. A webhook needs to tell "known but switched off" from "unknown".
- **`pageAccessToken`** — module-level `Map<string, { token: string; expiresAt: number }>` plus a `Map<string, Promise<string>>` of fetches in flight, so ten callers at once make one request. On a hit with `expiresAt > Date.now()` return the token. Otherwise `graph<{ access_token?: string }>(cfg, "GET", \`${pageId}?fields=access_token\`)` (M2, M3, M4). If the answer has no `access_token`, throw `new MetaApiError("Meta did not give us a token for this Page", 403, "no_page_token", false)`. Store with `expiresAt = Date.now() + 60 * 60 * 1000`. A failed fetch is not cached. Never log the token; never write it anywhere.
- **`clearPageTokenCache`** — delete one entry, or all when called with no argument. Callers that get Meta code `190` on a Page-token call must call it for that Page and retry **once**.
- **`listConnectablePages`** — `GET me/accounts?fields=name,tasks,instagram_business_account{id,username}&limit=100` with the system-user token; follow `paging.next` for at most 10 pages. Map each item as the interface says; `instagram` is `null` when the field is absent.
- **`describePage`** — `GET {pageId}?fields=name,instagram_business_account{id,username}`; `tasks` is `[]` and `canMessage` is `true` (unknown, assume yes). Used by the fallback in 5.6 and by "Check connection".

### 5.3 `packages/domain/src/inbox/core.ts`

**(a) `findOrCreateCustomerByIdentity`** — signature exactly as D13. Must run inside a transaction.

1. Trim `accountExternalId` and `externalId`; if either is empty throw `new Error("identity needs an account and an id")`.
2. `select pg_advisory_xact_lock(hashtext('inbox-identity:<channel>:<accountExternalId>:<externalId>'))` (same pattern as `findOrCreateCustomer`).
3. Select the `inbox_identity` row for the unique key, joined to `customer`.
4. **Found, customer live** (`deleted_at is null`): update the identity with `display_name = coalesce(<new non-empty>, display_name)`, `username = coalesce(<new non-empty>, username)`, `last_seen_at = now()`, `updated_at = now()`. Return `{ customerId, identityId, created: false }`. The customer row is not touched.
5. **Found, customer soft-deleted:** insert a new customer (step 6 values), point the identity at it (`customer_id`), update names as in step 4, return `created: true`.
6. **Not found:** insert `customer` with `name = displayName ?? (username ? "@" + username : null)`, `phone = null`, `source = "online"` (see section 14, Q2); insert the identity with `last_seen_at = now()`; return `created: true`.

**(b) `updateIdentityProfile`** (extra helper, used by spec 02):

```ts
export function updateIdentityProfile(db: DbExecutor, identityId: string,
  p: { displayName?: string | null; username?: string | null; profilePicUrl?: string | null }): Promise<void>;
```
Sets only the keys present in `p` (a present `null` clears), plus `profile_fetched_at = now()` and `updated_at = now()`.

**(c) `findOrCreateCustomer`** — signature and return type unchanged. New behaviour, in order:

1. Normalise and take the existing `inbox-customer:<e164>` lock (unchanged).
2. **New:** look for the WhatsApp identity `('whatsapp', 'global', <digits of e164>)` whose customer is live. If found, return `{ id: thatCustomerId, created: false }`. This is what makes a merge stick: after a merge the identity points at the kept contact.
3. Otherwise match on `customer.phone` exactly as today (fast path, slow path), or insert.
4. **New:** if `opts.source === "whatsapp"`, insert the identity `('whatsapp','global',digits)` for the resulting customer with `display_name = opts.name ?? null`, `ON CONFLICT (channel, account_external_id, external_id) DO NOTHING`. For `source: "phone"` (a call) **do not** write an identity: a caller has not shown they use WhatsApp.

**(d) `resolveWhatsAppCustomer`** (new; used by WhatsApp ingest instead of calling `findOrCreateCustomer` directly):

```ts
export function resolveWhatsAppCustomer(db: DbExecutor,
  who: { phone: string | null; userId: string | null; name?: string | null; username?: string | null },
): Promise<{ customerId: string; identityId: string; created: boolean }>;
```
`phone` is E.164 or null; `userId` is a BSUID or null. At least one must be set, else throw. Locks are always taken phone first, then BSUID, so two calls can never deadlock.

| Phone given | BSUID given | What happens | `identityId` returned |
|---|---|---|---|
| yes | no | `findOrCreateCustomer(phone, { name, source: "whatsapp" })` | the phone identity |
| no | yes | `findOrCreateCustomerByIdentity({ channel: "whatsapp", accountExternalId: "global", externalId: userId, displayName: name, username })` | the BSUID identity |
| yes | yes, BSUID identity does not exist | as row 1, then insert the BSUID identity for the same customer (`ON CONFLICT DO NOTHING`), with `username` | the phone identity |
| yes | yes, BSUID identity exists, phone identity does not, and no live `customer.phone` matches | use the BSUID identity's customer; insert the phone identity for that customer. The thread continues | the phone identity |
| yes | yes, both exist on the same customer | use it; refresh `last_seen_at`, `username` | the phone identity |
| yes | yes, they point at different customers (or a `customer.phone` match differs from the BSUID's customer) | the phone side wins (row 1). Move nothing, change neither identity, return normally (rule R15) | the phone identity |

**(e) `findOrOpenConversation`** — new optional fifth parameter; existing callers compile unchanged.

```ts
export function findOrOpenConversation(db, customerId, phoneNumberId, now = new Date(),
  opts: { identityId?: string | null } = {}): Promise<{ conversation; created; reopened }>;
```
- When inserting, also select the line's `kind` and set `channel = channelForKind(kind)` and `identityId = opts.identityId ?? null`.
- When an existing thread is returned or reopened and `opts.identityId` is set and differs from the row's `identityId`, update it (the last identity to write is the one replies go to).

### 5.4 `packages/domain/src/inbox/whatsapp-ingest.ts`

- Payload types: `WaInboundMessage.from` becomes optional; add `from_user_id?: string`, `system?: { type?: string; body?: string; user_id?: string; previous_user_id?: string; wa_id?: string }`. `WaChangeValue.contacts[]` gains `user_id?: string` and `profile.username?: string`.
- Build the `names` map keyed by **both** `wa_id` and `user_id`; build a second map `usernames` keyed the same way.
- `ingestMessage`: replace the `toE164(m.from)` / `findOrCreateCustomer` lines with:
  ```ts
  const phone = m.from ? toE164(m.from) : null;
  const userId = m.from_user_id && isBsuid(m.from_user_id) ? m.from_user_id : null;
  if (!phone && !userId) return false;   // nothing identifies the sender
  const who = await resolveWhatsAppCustomer(db, { phone, userId, name, username });
  const { conversation } = await findOrOpenConversation(db, who.customerId, phoneNumberId, undefined, { identityId: who.identityId });
  ```
  and add `channel: "whatsapp"` to the inserted message.
- `parseInbound`: add `case "system"`: `type = "system"`, `body = m.system?.body ?? "WhatsApp updated this customer's details."`. Then apply rule R16.
- `applyStatus`, `applyQualityUpdate`: no change (statuses are keyed on the message ID; `where e164 = …` never matches a null).

### 5.5 `packages/domain/src/inbox/send.ts` (WhatsApp only in this spec; spec 02 generalises it)

- Add `kind`, and the conversation's identity (`leftJoin inbox_identity on inbox_identity.id = inbox_conversation.identity_id`, selecting `channel` and `external_id`) to the context query.
- If `ctx.kind !== "phone"` throw `new InboxSendError("no_whatsapp", "This channel can't send yet")` (spec 02 replaces this branch).
- Recipient, first match wins: (1) the conversation's identity is WhatsApp and digits → `to = external_id`; (2) it is WhatsApp and `isBsuid` → `{ bsuid: external_id }`; (3) no identity → `toE164(customer.phone)` as today, else `InboxSendError("no_phone", "This customer has no phone number or WhatsApp ID to send to")`.
- Insert `channel: "whatsapp"` on the queued message.
- Meta error `131062` on a BSUID send is stored like any refusal; the timeline shows "Not sent: WhatsApp can't deliver this kind of message to a customer who has hidden their number." Add that mapping where `errorMessage` is set: when `e.code === "131062"` use that sentence and keep Meta's text in `payload.meta_message`.

### 5.6 New file `apps/api/src/routes/channels.ts`, mounted in `apps/api/src/test-app.ts` as `app.route("/v1/channels", channelRoutes(db));` next to the other inbox routes

Every route: `requireAuth()` then `requireCapability("channels.manage")`. Audit with `writeAudit(db, c, { action, entityType: "inbox_phone_number", entityId, after, before, notify: true })`.

| Route | Request | Response `200` | Notes |
|---|---|---|---|
| `GET /` | — | `{ data: ChannelRow[] }` | All rows of `inbox_phone_number`, `order by kind, label`. `ChannelRow = { id, kind, label, e164, external_id, page_external_id, external_name, default_team_id, hours_profile_id, is_active, open_conversations }` where `open_conversations` counts conversations with `status <> 'closed'` |
| `GET /available` | — | `{ data: AvailablePage[] }`, `AvailablePage = { page_id, name, can_message, messenger_connected, instagram: { id, username, connected } \| null }` | Calls `listConnectablePages`. `…connected` is true when a row with that `(kind, external_id)` exists **and is active**. No token configured → `503 { error: { code: "service_unavailable", message: "Meta is not connected on this server." } }`. `MetaApiError` → `409` with the sentence from section 3 and `details: { meta_code }` |
| `GET /available/:pageId` | `pageId` matches `/^\d{5,25}$/` | `{ data: AvailablePage }` | Fallback when the list is empty (M4): calls `describePage`. Same errors |
| `POST /connect` | `{ page_id: string (/^\d{5,25}$/), messenger: boolean, instagram: boolean, label_messenger?: string(1..60), label_instagram?: string(1..60), default_team_id?: uuid\|null, hours_profile_id?: uuid\|null }`; at least one of `messenger`, `instagram` true | `201 { data: ChannelRow[] }` (the rows created or switched back on) | See steps below |
| `PATCH /:id` | `{ label?: string(1..60), default_team_id?: uuid\|null, hours_profile_id?: uuid\|null, is_active?: boolean }` (`.strict()`) | `{ data: ChannelRow }` | `404` if no row. `400 "Phone lines are changed under Settings, Numbers."` if `kind = 'phone'`. Audit `channels.update`, or `channels.switch_off` / `channels.switch_on` when only `is_active` changed |
| `POST /:id/check` | — | `{ data: { ok: boolean, problem: string \| null, external_name: string \| null } }` | Non-phone rows only. `clearPageTokenCache(pageId)`, `pageAccessToken`, then `describePage`. On success update `external_name` and `updated_at`. `ok: false` with the plain sentence on any `MetaApiError`; for kind `instagram`, also `ok: false, problem: "This Instagram account is no longer linked to the Facebook Page."` when the Page's `instagram.id` differs from the row's `external_id`. Always `200` |

`POST /connect` steps (never trust names or the Instagram ID from the browser):

1. `describePage(cfg, page_id)`; a `MetaApiError` → `409` as above.
2. `pageAccessToken(cfg, page_id)`; failure → `409 "Meta would not give us access to this Page. Check it is assigned to our system user with messaging rights."`
3. If `instagram` is true and the Page has no Instagram account → `400 "This Page has no Instagram account linked to it."`
4. In one transaction, for each requested kind: select the row by `(kind, external_id)`. If it exists: set `is_active = true`, `page_external_id`, `external_name`, `updated_at` (keep its label, team and hours unless given). Else insert `{ kind, external_id, page_external_id: page_id, external_name, e164: null, channels: "whatsapp", label: <given label or default>, default_team_id, hours_profile_id }`. Default labels: `"Facebook Page"` and `"Instagram"`. A `23505` (two people clicking at once) → re-select and treat as existing.
5. Audit `channels.connect` once per row, `after: { kind, label, external_name }`.
6. Call `clearInboxViewerCache()` (exported from `routes/inbox.ts`) so people with `inbox.view_all` see the new line at once.

Spec 02 adds a step between 4 and 5 (subscribe the Page to the app); leave a comment `// spec 02: subscribe webhooks here`.

### 5.7 Changes to existing routes

`apps/api/src/routes/inbox.ts`:

| Place | Change |
|---|---|
| `GET /me` | `numbers[]` items gain `kind` and `external_name`. Add `"channels"` to the capability prefix regex |
| `GET /conversations` | Rows gain `channel`, `number_kind`, `identity_name` (`coalesce(inbox_identity.display_name, '@' \|\| inbox_identity.username)` via `leftJoin` on `identity_id`). Search `q`: add `exists (select 1 from inbox_identity i where i.customer_id = customer.id and (i.username ilike :term or i.display_name ilike :term))` to the `or(...)`. New filter `channel` (one of `IDENTITY_CHANNELS`): `eq(inboxConversation.channel, q.channel)`; ignore other values |
| `GET /conversations/:id` | `number` gains `kind`, `external_name`. Add `identity: { id, channel, display_name, username, profile_pic_url } \| null` |
| `GET /contacts/:customerId` | Add `identities: IdentityRow[]` (see below) |
| `GET /contacts/search` | Add the same identity `exists(...)` to the `or`. Each hit gains `handles: string[]` (up to 3 of `'@' \|\| username`, else `display_name`, across the customer's identities) |
| `POST /contacts/:customerId/merge` | Inside the transaction, after the conversations loop: `update inbox_identity set customer_id = :intoId, updated_at = now() where customer_id = :fromId`. When folding a clashing thread, if the kept thread's `identity_id` is null set it to the folded one's. Response and audit gain `moved_identities` |
| `POST /contacts/:customerId/erase` | Body becomes `{ confirm: string(1..120) }`; keep accepting the old key `confirm_phone` as an alias. Check per rule R10. In the transaction: collect the customer's identities; after deleting conversations, `delete from inbox_identity where customer_id = :id`; for the phone digits **and** for each identity `external_id` of length ≥ 7, delete `inbox_webhook_event` rows whose `payload::text` contains it. Counts gain `identities`. Return `200` (not `404`) when the customer has identities but no conversations |
| `GET /export/contacts.csv` | Add a fifth column "Other names" = the customer's identity handles joined with "; " |

`IdentityRow = { id, channel, account_label, display_name, username, phone, profile_pic_url, last_seen_at }`. `account_label` is the label of the line whose `(kind, external_id)` equals `(channel, account_external_id)`, or `"WhatsApp"` for WhatsApp. `phone` is `"+" + external_id` for a digits-only WhatsApp identity, else `null`. **Visibility:** WhatsApp identities are always returned; a Messenger or Instagram identity is returned only if `canUseNumber(viewer, <that line's id>)` (rule 6 of the foundation: no second rule, reuse the helper).

`apps/api/src/routes/inbox-settings.ts`:

- `GET /numbers`: add `where kind = 'phone'` unless `?kind=all` is passed (the staff-access tab passes it).
- `POST /numbers`: force `kind: "phone"`.
- `PATCH /numbers/:id`, `POST /numbers/:id/register`, `POST /numbers/:id/refresh`: `404` when the row's `kind` is not `'phone'`.

`apps/api/src/routes/voice.ts`:

- `findBusinessNumber`: add `eq(inboxPhoneNumber.kind, "phone")` to both queries.
- Outgoing call (`num.channels === "whatsapp"` check near line 644): also refuse when `num.kind !== "phone"` or `!num.e164`, with the same spoken sentence.
- Incoming call (near line 411): same extra guard. After the guards, `num.e164` is a `string`; the two inserts and `callerId` need no cast.

### 5.8 Every place that assumed "a line is a phone" or "`e164` is never null"

| File and function | Assumption today | Required change |
|---|---|---|
| `packages/db/src/schema/inbox.ts` `inboxPhoneNumber.e164` | `notNull()` | 4.3 |
| `packages/domain/src/inbox/core.ts` `findOrCreateCustomer` | a customer is found only by phone | 5.3 (c) |
| `packages/domain/src/inbox/core.ts` `findOrOpenConversation` | no channel, no identity | 5.3 (e) |
| `packages/domain/src/inbox/whatsapp-ingest.ts` `ingestMessage` | `m.from` always present; a message without it is dropped and the event marked done | 5.4 |
| `packages/domain/src/inbox/whatsapp-ingest.ts` `parseInbound` | `system` messages become "unsupported" | 5.4 |
| `packages/domain/src/inbox/send.ts` `sendFromConversation` | recipient is `customer.phone`; line is a phone | 5.5 |
| `packages/domain/src/inbox/meta.ts` `buildSendPayload`, `sendMessage` | `to` is a phone | 5.1 |
| `apps/api/src/routes/inbox.ts` `GET /me`, `GET /conversations/:id` | return `e164` as a string | 5.7; front-end type becomes `string \| null` |
| `apps/api/src/routes/inbox.ts` conversation search, contact search | name or phone only | 5.7 |
| `apps/api/src/routes/inbox.ts` erase | needs a phone to confirm; removes webhook copies by phone digits only | 5.7, R10 |
| `apps/api/src/routes/inbox.ts` merge | future messages re-match the old customer by phone | 5.7 + 5.3 (c) |
| `apps/api/src/routes/inbox-settings.ts` numbers routes | every row is a phone | 5.7 |
| `apps/api/src/routes/voice.ts` `findBusinessNumber`, incoming and outgoing call handlers | every row can be a caller ID; `num.e164` is a string | 5.7 |
| `apps/worker/src/jobs/inbox-voice.ts` `sendMissedCallFollowups` | the fallback line has WhatsApp | Add `eq(inboxPhoneNumber.kind, "phone")` to the join so a call can never "follow up" from a Page |
| `apps/worker/src/jobs/inbox-push.ts` `sendMessagePushes` | title falls back to the phone | Left-join the conversation's identity; title = `name \|\| phone \|\| identity display_name \|\| "@"+username \|\| "New message"` |
| `apps/admin/src/lib/inbox-types.ts` `InboxNumberLite`, `PhoneNumberRow`, `ConversationRow`, `ConversationDetail`, `ContactInfo`, `ContactSearchHit`, `EraseResult` | phone-shaped | `e164: string \| null`; add the new fields from 5.7 |
| `apps/admin/src/lib/inbox-logic.ts` `contactName(name, phone)` | "Unknown customer" when both are empty | Add a third optional parameter `fallback?: string \| null`, used before "Unknown customer". Pass `identity_name` from the list, header, notifier and call bar |
| `apps/admin/src/lib/inbox-logic.ts` `phoneConfirmMatches` | erase confirm is a phone | Add `eraseConfirmTarget` (section 7.4) |
| `apps/admin/src/components/inbox/ConversationList.tsx` | "All numbers", "Business number", `voiceOnly` | Select label becomes "All channels", `aria-label="Channel"`. (Icon and channel filter: spec 02) |
| `apps/admin/src/components/inbox/ConversationHeader.tsx` | Call button whenever the customer has a phone | Show it only when `conv.number?.kind === "phone" && conv.number.channels !== "whatsapp"` |
| `apps/admin/src/components/inbox/CallBar.tsx` `voiceNumbers` | filters on `channels` only | Also require `n.kind === "phone"` |
| `apps/admin/src/components/inbox/Composer.tsx` `waNumber` | `channels !== "voice"` | `conv.number?.kind === "phone" && conv.number.channels !== "voice"`. For other kinds show, in place of the reply box: "Replies on this channel are not switched on yet." (spec 02 replaces it) |
| `apps/admin/src/components/inbox/ContactPanel.tsx` | phone only; erase needs a phone | Section 7.3, 7.4 |
| `apps/admin/src/components/inbox/SettingsNumbers.tsx` | lists every row | No code change (the route now returns phones only) |
| `apps/admin/src/components/inbox/SettingsTeams.tsx` `SettingsAccess` | "numbers" | Call `settingsApi.numbers({ all: true })` (adds `?kind=all`); column heads show `label`; wording in 7.5 |
| `apps/admin/src/hooks/useInboxNotifier.ts` | title falls back to phone, then "New WhatsApp message" | `name \|\| phone \|\| identity display name \|\| "New message"` |
| `apps/admin/src/routes/inbox/reports.tsx` number filter | "numbers" | Option text "All channels" |

### 5.9 Permission

`packages/shared/src/permissions.ts`: add `"channels.manage"` to `CAPABILITIES` after `"inbox.reports"` with the comment "Connect and configure channel accounts (Facebook Page, Instagram); later: chat set-up, WhatsApp profile, Page details." Add it to `ADMIN_CAPS`. Not to `MANAGER_CAPS`. The owner gets it automatically. In `apps/admin/src/components/GateEditor.tsx` add it to the inbox group and give it the label **"Connect and set up channels (Facebook, Instagram)"**.

## 6. Worker

No new job. Two edits listed in 5.8 (`inbox-voice.ts`, `inbox-push.ts`). `retryWebhookEvents` needs no change: it calls `ingestWhatsAppPayload`, which now handles messages without a phone number.

## 7. Screens

### 7.1 Menu and route (suite only)

- `apps/suite/src/SuiteShell.tsx`: widen `NavItem.to` with `"/channels"`. In the "Set-up" section add, **before** Settings: `{ to: "/channels", label: "Channels", Icon: Share2, cap: "channels.manage" }` (`Share2` from `lucide-react`).
- `apps/suite/src/router.tsx`: `const ChannelsPage = lazyNamed(() => import("./features/channels/ChannelsPage.js"), "ChannelsPage");` and a route `path: "/channels"`, `component: () => page(<ChannelsPage />)`; add it to `routeTree`.
- New files: `apps/suite/src/features/channels/ChannelsPage.tsx`, `ConnectDialog.tsx`, `EditChannelDialog.tsx`, `channels-api.ts` (uses `api()` from `@admin/lib/api.js`; query keys `["channels"]`, `["channels","available"]`), `channels-logic.ts` + `channels-logic.test.ts`.
- The page renders inside the host frame (`import { Frame } from "@admin/lib/app-frame.js"`, as `routes/inbox/settings.tsx` does) with `title="Channels"`.

### 7.2 Channels page

Intro line under the title: **"The places customers can reach you. New chats from each one go to the team you choose."**

Primary button, top right: **"Connect Facebook or Instagram"**.

One card per channel (a table at desktop width, stacked cards at 390 px, using the existing `table ibx-stack` classes):

| Column | Content |
|---|---|
| Channel | Icon + `label` in bold. Second line, grey: phone → `prettyPhone(e164)`; messenger → "Facebook Page: {external_name}"; instagram → "Instagram: @{external_name}" |
| Used for | phone: "WhatsApp and calls" / "Calls only" / "WhatsApp only" (from `channels`); messenger: "Facebook Messenger"; instagram: "Instagram messages" |
| Team | team name, or "No team" |
| Hours | hours profile name, or "Always open" |
| Status | green pill "On", or grey pill "Switched off" |
| Open chats | `open_conversations` |
| Actions | phone: link "Change in Settings" → `/inbox/settings`. Others: **Edit**, **Check connection**, and **Switch off** (or **Switch on**) |

States:

- Loading: `DataState` spinner.
- Empty (no rows at all): title "No channels yet", hint "Connect your Facebook Page or add a phone line in Settings."
- Error: `DataState` with Retry.
- No permission (the route is reached without `channels.manage`): a card: "You don't have access to Channels. Ask the owner to give your account the permission "Connect and set up channels"."
- After **Check connection**: toast "{label}: connected." or an inline red line under the row: "{label}: {problem}".
- **Switch off** opens `ConfirmModal`, title "Switch off {label}?", body: "New messages on this channel will stop coming into the inbox. Chats you already have stay where they are. You can switch it back on at any time.", confirm button "Switch off". **Switch on** needs no confirmation; toast "{label} is on."

Under the list, a quiet note: **"Staff who only see some channels will not see chats from a new one until you tick it for them in Settings, Staff access."** with "Settings" linking to `/inbox/settings`.

### 7.3 Connect dialog (`Modal`, max width 560)

Title: **"Connect Facebook or Instagram"**.

1. **Loading:** "Looking up your Pages…"
2. **List.** Heading "Choose what to connect". One block per Page from `GET /channels/available`:
   - Checkbox "**Facebook Page: {name}** — messages sent to the Page on Messenger". If `messenger_connected`: ticked, disabled, with "Already connected". If `can_message` is false: disabled, with "We don't have messaging rights on this Page. Ask the technical lead."
   - If the Page has Instagram: checkbox "**Instagram: @{username}** — direct messages to this account". If `connected`: ticked, disabled, "Already connected". If there is none, grey text: "No Instagram account is linked to this Page."
   - Only one Page can be chosen per run; ticking a box on another Page unticks the first Page's boxes.
3. **Details** (shown once at least one box is ticked): "Name in the inbox" (one text field per ticked box, pre-filled "Facebook Page" / "Instagram", max 60), "Team for new chats" (select of active teams, first option "No team"), "Opening hours" (select of hours profiles, first option "Always open").
4. Buttons: "Cancel", **"Connect"** (disabled until a box is ticked and every name is filled). While saving: "Connecting…".
5. **Success:** close, toast "Connected: {labels joined with " and "}.", refetch `["channels"]` and `inboxKeys.me`.
6. **Empty list:** "We couldn't find any Pages for this account." Below it a field "Facebook Page ID" (digits only) and a button "Look up", which calls `GET /channels/available/:pageId` and, on success, shows that Page as in step 2. Help text: "You can find the Page ID in Facebook under the Page's About, Page transparency."
7. **Error:** the server's sentence in a red box and a "Try again" button.

### 7.4 Edit dialog and contact panel

**Edit dialog** (`Modal`): title "Edit {label}". Fields: "Name in the inbox", "Team for new chats", "Opening hours". Read-only line: "Connected to Facebook Page: {external_name}" or "Connected to Instagram: @{external_name}". Buttons "Cancel", "Save". Toast "Saved."

**Contact panel** (`apps/admin/src/components/inbox/ContactPanel.tsx`, both apps):

- Heading name: `contactName(c.name, c.phone, firstIdentityHandle)`.
- New block between the phone/e-mail lines and the name field, shown when `identities.length > 0`, eyebrow **"Reaches you on"**. One row per identity: channel icon (16 px: `MessageCircle` WhatsApp, `Facebook` Messenger, `Instagram` Instagram, all from `lucide-react`), then the main text, then grey "last wrote {listTime(last_seen_at)}" when set:
  - WhatsApp with a phone: `prettyPhone(phone)`.
  - WhatsApp without one: "WhatsApp (number hidden)" plus " · @{username}" when set.
  - Messenger: `display_name ?? "Facebook user"` + " · {account_label}".
  - Instagram: `"@" + username` when set, else `display_name ?? "Instagram user"`, + " · {account_label}".
  - A 24 px round picture before the icon when `profile_pic_url` is set; on image error, hide it (Meta's picture links expire).
- When the list is empty the block is not rendered.
- **Merge dialog:** search placeholder "Search by name, phone or username"; each hit's second line appends its `handles` joined with ", ". Confirmation body gains the sentence "Their WhatsApp, Facebook and Instagram details move too, so future messages from them arrive on the kept contact." Success toast: "Moved {n chats} to {name}."
- **Erase dialog:** `eraseConfirmTarget(customer, identities)` (in `inbox-logic.ts`) returns `{ kind: "phone" | "username" | "name" | "word"; show: string }`: the phone if there is one; else the first identity username (shown with "@"); else the customer's name; else the word `DELETE`. Label wording: phone → "Type the customer's phone number to confirm: **{show}**"; username → "Type the customer's username to confirm: **{show}**"; name → "Type the customer's name to confirm: **{show}**"; word → "Type **DELETE** to confirm". The line "This contact has no phone number on file, so it can't be confirmed here." is removed. The body sentence becomes "This permanently removes every chat, call, recording and note for **{who}**, and their WhatsApp, Facebook and Instagram details, from the inbox. It can't be undone." The client sends `{ confirm: typed }`.

### 7.5 Settings → Staff access (wording only)

Intro: "Staff only see chats and calls for the channels ticked here." Empty state: "No channels yet" / "Add a phone line or connect a Page first."

## 8. Rules and edge cases

- **R1.** A row with `kind = 'phone'` always has `e164`; any other kind always has `external_id` and `page_external_id`. The database enforces it.
- **R2.** There is at most one row per `(kind, external_id)`. Connecting something already connected switches it back on and never creates a second row.
- **R3.** `POST /channels/connect` takes the Instagram ID and all names from Meta's answer, never from the request.
- **R4.** A Page token is never stored, logged or returned by any route. It lives in process memory for at most one hour.
- **R5.** Ingestion never changes an existing `customer` row. It may insert a customer and insert, update or re-point `inbox_identity` rows.
- **R6.** Identity lookup comes before phone matching. If a WhatsApp identity exists for a number, its customer is used even when another customer's `phone` matches that number.
- **R7.** After merging contact A into B, the next WhatsApp message from A's number lands on B. (Before this spec it reopened A.)
- **R8.** A call (`source: "phone"`) uses an existing WhatsApp identity for that number if there is one, but never creates one.
- **R9.** Two webhooks arriving together for the same new identity create one customer and one identity (advisory lock + unique index).
- **R10.** Erase confirmation, checked on the server: if the customer has phone digits, `confirm` must match them (existing comparison). Else if any identity has a username, `confirm` (trimmed, leading "@" removed, case-insensitive) must equal one of the usernames. Else if the customer has a name, it must equal the name (trimmed, case-insensitive). Else it must be exactly `DELETE`. Mismatch → `400 "That doesn't match this customer"`.
- **R11.** Erase removes the customer's identities and the stored webhook copies that contain their IDs. The `customer` row is not touched (section 14, Q3).
- **R12.** A conversation's `channel` is set when it is created and never changes. Its `identity_id` follows the last identity that wrote in it.
- **R13.** WhatsApp replies go to the conversation's identity, not to `customer.phone`, when the conversation has one. So after a merge, a reply in the thread reaches the number that wrote in that thread.
- **R14.** An incoming WhatsApp message with no phone number but a BSUID creates (or finds) a phone-less contact and shows in the inbox like any other. A message with neither is ignored and the event is marked processed.
- **R15.** When a message carries a phone and a BSUID that already belong to two different contacts, the phone's contact is used and nothing is merged. Staff can merge the two by hand; after that both identities point at one contact.
- **R16.** On a `system` message whose `system.type` (or, if absent, top-level `type` detail) is `user_changed_user_id`: read `previous_user_id` and `user_id` from `m.system`, falling back to the top level of the message. If both are BSUIDs, an identity exists for the old one and none exists for the new one, set that identity's `external_id` to the new value. Otherwise do nothing. `user_changed_number`: do nothing to identities (the new number will get its own identity when it writes; staff merge if needed). In both cases the system message is stored in the timeline as type `system`.
- **R17.** A soft-deleted customer is never re-used: the identity is pointed at a fresh customer.
- **R18.** Switching a channel off hides it from `GET /inbox/me` (already filtered on `is_active`) and from the "Connect" list's "Already connected" state; its conversations stay visible and closed/open as they were.
- **R19.** Phone lines cannot be edited or switched off from `/v1/channels`; non-phone lines cannot be edited from `/v1/inbox/settings/numbers`.
- **R20.** A Messenger or Instagram identity is shown on the contact panel only to staff who may use that line.
- **R21.** Non-phone rows never match an incoming call and can never be used as a caller ID.

## 9. Tests

`packages/shared/src/inbox.test.ts` (add or extend):
- `channelForKind maps phone to whatsapp and leaves the others`
- `isBsuid accepts US.123 and US.ENT.123 and rejects digits-only and empty`

`packages/domain/src/inbox/inbox.test.ts`:
- `buildSendPayload uses recipient for a BSUID and to for a phone`
- `parseInbound turns a system message into type system with its body`

`packages/domain/src/meta/accounts.test.ts` (new; stub `globalThis.fetch`):
- `pageAccessToken fetches once and serves the cache for an hour` (fake timers)
- `pageAccessToken makes one request for concurrent callers`
- `pageAccessToken throws no_page_token when Meta returns no token, and does not cache the failure`
- `clearPageTokenCache forces a new fetch`
- `listConnectablePages maps tasks, canMessage and the Instagram account, and follows paging`

`apps/api/test/integration/inbox-identities.test.ts` (new; copy the set-up of `inbox-whatsapp.test.ts`):
- `migration back-fill is idempotent` (insert an inbound message row with `payload.from`, run the two back-fill statements twice, expect one identity and `identity_id` set)
- `an inbound WhatsApp message creates the customer, the identity and a conversation with channel whatsapp and identity_id`
- `a second message from the same number re-uses the identity`
- `findOrCreateCustomerByIdentity creates a phone-less customer once under concurrent calls` (two transactions in `Promise.all`)
- `findOrCreateCustomerByIdentity points the identity at a new customer when the old one is soft-deleted`
- `a WhatsApp message without from but with from_user_id is stored on a phone-less contact (R14)`
- `a message with phone and a known BSUID continues the BSUID contact's thread and adds the phone identity`
- `conflicting phone and BSUID contacts: the phone's contact wins and nothing moves (R15)`
- `user_changed_user_id re-keys the identity (R16)`
- `after a merge the next message from the merged number lands on the kept contact (R7)`
- `merge moves identities and reports moved_identities`
- `a reply goes to the conversation's identity, not to customer.phone (R13)` (assert the Graph stub saw `to` = the identity's digits)
- `a reply to a BSUID-only contact sends recipient, not to`
- `erase with a phone still needs the phone; erase without a phone accepts the username, then the name, then DELETE (R10)`
- `erase deletes identities and webhook copies containing the identity id`
- `conversation search finds a contact by Instagram username`
- `a call never creates a WhatsApp identity (R8)`

`apps/api/test/integration/channels.test.ts` (new; Graph stub answers `me/accounts`, `{page}?fields=access_token`, `{page}?fields=name,…`):
- `every /v1/channels route answers 403 without channels.manage`
- `GET /available lists the Page and its Instagram account and marks connected ones`
- `POST /connect creates a messenger row and an instagram row with ids taken from Meta, not from the request`
- `POST /connect twice does not duplicate; a switched-off row is switched back on`
- `POST /connect refuses instagram when the Page has none (400)`
- `POST /connect returns 409 with a plain sentence when Meta refuses the Page token`
- `PATCH refuses a phone row (400) and updates label, team, hours and is_active on others, with an audit row`
- `POST /:id/check reports a problem when the Instagram account is no longer linked`
- `no response body ever contains the stubbed page token string`
- `GET /inbox/settings/numbers returns phones only; ?kind=all returns everything`
- `PATCH /inbox/settings/numbers/:id answers 404 for a messenger row`

`apps/api/test/integration/inbox-voice.test.ts`: add `an incoming call never matches a non-phone row`.

`apps/admin/src/lib/inbox-logic.test.ts`: `contactName falls back to the identity name before "Unknown customer"`; `eraseConfirmTarget picks phone, then username, then name, then the word DELETE`.

`apps/suite/src/features/channels/channels-logic.test.ts`: `usedForText` and `secondLine` for each kind; `connectReady` is false until a box is ticked and names are filled.

`apps/worker/src/jobs/inbox-push.test.ts`: `push title falls back to the identity name`.

## 10. Manual check

Use an account with the owner role. Meta is called read-only in steps 2 to 6.

1. Sign in to the suite. The menu shows **Channels** under Set-up. Sign in as a manager: it does not.
2. Open Channels. The WhatsApp test line is listed with "Change in Settings".
3. Click **Connect Facebook or Instagram**. The Page "Mrs Samuel fruit juice" and "Instagram: @mrs_samuelfruitjuice" appear. (If the list is empty, use the Page ID field; note that in the pull request: it confirms M4 is false.)
4. Tick both, name them "Facebook" and "Instagram", pick a team, click Connect. Two rows appear, both "On".
5. Click **Check connection** on each: "connected".
6. Connect again: both boxes show "Already connected".
7. Switch Instagram off, confirm, then on.
8. In Settings → Numbers only the phone line is listed. In Settings → Staff access all three are listed.
9. From a tester phone, send a WhatsApp message to the test number. Open the chat: the contact panel shows "Reaches you on" with the phone number.
10. Merge that contact into another test contact. Send another WhatsApp message from the same phone: it appears under the kept contact.
11. On the kept contact choose "Delete messages and calls…": the dialog asks for the phone number. On a contact with no phone (make one in a test database), it asks for the username, name, or DELETE.
12. Repeat steps 2, 3 and 9 at 390 px width.
13. Check the audit log shows "channels.connect" and "channels.switch_off".

## 11. Done when

- [ ] Migration 0071 applies on a copy of production data, and applying its statements a second time changes nothing.
- [ ] `npx -y pnpm@9 lint`, `typecheck`, admin and suite `tsc` and `vitest`, and the three integration files pass.
- [ ] Every existing test in `inbox-whatsapp.test.ts` and `inbox-voice.test.ts` still passes unchanged, except the erase test's request body key.
- [ ] Every row of table 5.8 is done or explained in the pull request.
- [ ] No route, log line or test snapshot contains a token.
- [ ] The manual check passes on desktop and at 390 px.
- [ ] The pull request lists each **[unverified]** fact with what was found.

## 12. Out of scope

- Receiving or sending anything on Messenger or Instagram, subscribing the Page to webhooks, fetching profile names and pictures (spec 02).
- Chat set-up, WhatsApp profile, Page details (specs 04, 05, 10), although they will hang off the Channels page.
- Un-merging contacts, or moving one identity to another contact by hand.
- Automatic merging of contacts that look alike.
- WhatsApp usernames as a way to **start** a chat, the Meta contact book, phone-number request buttons, parent BSUIDs.
- Unsubscribing the app from a Page when a channel is switched off.
- Moving files between `apps/admin` and `apps/suite`.

## 13. Work order

1. Shared types and helpers (4.4) with tests.
2. Migration 0071, journal entry, Drizzle changes (4.1 to 4.3). Build packages; fix every type error that `e164: string | null` raises by applying table 5.8 (server rows only).
3. `graph()` export with `opts.token`; `buildSendPayload` / `sendMessage` BSUID form; unit tests.
4. `packages/domain/src/meta/accounts.ts` and its tests.
5. `core.ts`: `findOrCreateCustomerByIdentity`, `updateIdentityProfile`, the `findOrCreateCustomer` change, `resolveWhatsAppCustomer`, `findOrOpenConversation` option.
6. `whatsapp-ingest.ts` and `send.ts` changes; `inbox-identities.test.ts` up to the send tests.
7. `inbox.ts` route changes (lists, detail, contacts, search, merge, erase, export); rest of `inbox-identities.test.ts`.
8. `inbox-settings.ts`, `voice.ts`, worker edits; their tests.
9. Permission `channels.manage` (shared, `GateEditor.tsx`).
10. `routes/channels.ts`, registration in `test-app.ts`, `channels.test.ts`.
11. Admin types, `inbox-logic.ts` helpers and tests, contact panel, merge and erase dialogs, list/header/composer/call-bar/notifier edits, Staff access wording.
12. Suite: `features/channels/*`, menu line, route, tests.
13. Manual check; write the pull request notes.

## 14. Open questions

| # | Question | Recommended default (do this unless told otherwise) |
|---|---|---|
| Q1 | Meta's examples are on Graph `v27.0`; `meta.ts` defaults to `v23.0`, and the foundation (section 4) repeats `v23.0`. **Contradiction with the foundation.** | Keep the default in code as it is in this spec; do not change versions inside a feature branch. Raise it with the technical lead: set `META_GRAPH_VERSION` on the server after a test against the WhatsApp flows. Nothing in this spec needs a newer version, except that BSUID sending (M14) may; if a BSUID send is refused with an "unknown parameter" error, that is the cause |
| Q2 | `customer.source` has no value for Messenger or Instagram (`walkup_anonymous`, `online`, `phone`, `whatsapp`, `chowdeck`). | Use `"online"` for customers created from a Messenger or Instagram identity and `"whatsapp"` for BSUID-only WhatsApp customers. Adding enum values touches a shop table and is the technical lead's call; if he adds `messenger` and `instagram`, change step 6 of 5.3 (a) only |
| Q3 | After "Delete messages and calls" for a contact that exists only because of a social identity, the `customer` row still holds the name Meta gave us. | Leave the row (the standing rule is that the inbox never changes customer rows on erase). Write `customer_row_kept: true` in the audit entry so the owner can remove the customer in the shop admin if the person asked for full deletion |
| Q4 | Does `/me/accounts` work for the system-user token (M4)? | Build both paths (list, and look-up by Page ID). The manual check, step 3, answers it |
| Q5 | Should a newly connected channel be ticked automatically for staff who are limited to certain lines? | No. Show the note in 7.2. Owners and admins (`inbox.view_all`) see it at once |
| Q6 | The foundation's D13 signature of `findOrCreateCustomerByIdentity` has no profile picture. | Keep D13 as written; spec 02 calls `updateIdentityProfile` after it. This spec also adds `clearPageTokenCache`, `withPageToken`, `listConnectablePages`, `describePage`, `resolveWhatsAppCustomer`, a fifth parameter on `findOrOpenConversation`, and the columns `inbox_phone_number.external_name` and `inbox_conversation.identity_id`, none of which D13 or section 6 of the foundation lists. Later specs may rely on them |
| Q7 | D2 says the identity key is `(channel, account_external_id, external_id)` but WhatsApp IDs are not scoped to a line. | Use the constant `'global'` as the account key for every WhatsApp identity (`WHATSAPP_ACCOUNT_KEY`) |
