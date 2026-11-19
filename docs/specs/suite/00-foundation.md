# Suite build specs — 00: Foundation (read this first)

This folder holds one build spec per area of the Mrs. Samuel Business Suite. Each spec is written to be handed to an implementing model (Claude Opus or Sonnet) or a developer with no other context. **Every spec assumes you have read this file.** Where a spec and this file disagree, this file wins; say so in your pull request.

| # | Spec | Size | Suggested model | Depends on |
|---|---|---|---|---|
| 01 | Channel accounts and customer identities | M | Opus | — |
| 02 | Messenger and Instagram direct messages | L | Opus | 01 |
| 03 | Comments on Facebook and Instagram posts | L | Opus | 01, 02 |
| 04 | Chat set-up for Messenger and Instagram (welcome text, starter questions, menu) | S | Sonnet | 01 |
| 05 | WhatsApp business profile | S | Sonnet | — |
| 06 | WhatsApp template authoring | M | Sonnet | `work/olu/inbox-gaps` merged |
| 07 | WhatsApp Flows (in-chat forms and bookings) | L | Opus | 06 |
| 08 | Catalogue sync and selling in chat | L | Opus | — |
| 09 | Publishing posts to Facebook and Instagram | M | Sonnet | 01 |
| 10 | Facebook Page details | S | Sonnet | 01 |
| 11 | Statistics (Page, Instagram, posts, WhatsApp) | M | Sonnet | 01 |
| 12 | Ads: results, spend and click-to-chat ads | L | Opus | 01 |
| 13 | Lead forms from adverts | M | Sonnet | 01, 02 |

Size: S ≈ one sitting, M ≈ a few, L ≈ several with review in between. "Opus" marks specs with concurrency, money, or cross-cutting data-model risk.

---

## 1. What the product is

- **Mrs. Samuel Fruit Juice** is a juice business in Lagos with a storefront (`www.mrssamuel.com`), a staff admin app with a till (`admin.mrssamuel.com`), and an API (`api.mrssamuel.com`).
- **The Business Suite** (`suite.mrssamuel.com`, `apps/suite`) is a separate staff web app for customer conversations, calls, contacts and marketing. It shares the shop's API, worker, database and staff accounts. It serves **this one business only**; do not add multi-tenant columns.
- The users are shop staff, not engineers. **All on-screen wording is plain English**: short sentences, no jargon, no Meta error codes without a plain explanation beside them.

Read `docs/handoffs/2026-11-19-suite-blueprint.md` for the file map, the go-live steps and Meta's state.

## 2. The codebase in one page

A pnpm monorepo, TypeScript throughout, ES modules (imports end in `.js`).

| Path | What |
|---|---|
| `apps/api` | Hono HTTP API. Routes in `src/routes/*.ts`, **registered in `src/test-app.ts`** (the real server imports the same `app`). Env in `src/env.ts` (zod) |
| `apps/worker` | Background jobs. Suite jobs run in `src/inbox-loop.ts`, each under a Postgres advisory lock (`withJobLock`) |
| `apps/admin` | Staff web app (Vite, React 18, TanStack Router and Query, zustand, plain CSS + Tailwind tokens). Holds the shared inbox screens |
| `apps/suite` | The suite web app. Reuses admin source through the `@admin/*` alias |
| `apps/customer` | Storefront (SSR). Not touched by these specs unless stated |
| `packages/db` | Drizzle schema (`src/schema/*.ts`) and SQL migrations (`migrations/NNNN_name.sql`) |
| `packages/domain` | Business logic shared by API and worker. Inbox logic in `src/inbox/` |
| `packages/shared` | Types, permission names (`src/permissions.ts`), pure helpers shared with the front ends |

**Commands** (pnpm is not on PATH on every machine; `npx -y pnpm@9 …` always works):

```
npx -y pnpm@9 install
npx -y pnpm@9 --filter "./packages/*" build     # needed before type-checking apps
npx -y pnpm@9 lint                               # eslint, whole repo
npx -y pnpm@9 typecheck                          # packages, api, worker (tsc -b)
(cd apps/admin && npx tsc --noEmit && npx vitest run)
(cd apps/suite && npx tsc --noEmit && npx vitest run && npx vite build)
(cd apps/api && npx vitest run test/integration/<file>)   # needs Docker running (testcontainers)
```

**Patterns to copy, not reinvent**

| Need | Copy from |
|---|---|
| A Meta webhook: verify signature, store raw, process in a transaction, retry later | `apps/api/src/routes/webhooks-whatsapp.ts` + `retryWebhookEvents` in `apps/worker/src/jobs/inbox-whatsapp.ts` |
| Calling the Graph API with error mapping | `graph()` and `MetaApiError` in `packages/domain/src/inbox/meta.ts` |
| A staff route with permission checks and audit | `apps/api/src/routes/inbox.ts` (`withViewer`, `need(c, cap)`, `visibleConversation`, `audit`) |
| A settings route | `apps/api/src/routes/inbox-settings.ts` |
| A worker job | any entry in `jobs` in `apps/worker/src/inbox-loop.ts` |
| An integration test with Meta stubbed | `apps/api/test/integration/inbox-whatsapp.test.ts` (`installGraphStub`, `setupTestDb`, `seedUser`, `loginAs`) |
| Pure front-end rules with tests | `apps/admin/src/lib/inbox-logic.ts` + `.test.ts` |
| A dialog, a confirm, loading and empty states | `apps/admin/src/components/Modal.tsx`, `ConfirmModal.tsx`, `DataState.tsx` |
| Server calls from the front end | `apps/admin/src/lib/inbox-api.ts` (`api()`, query keys in `inboxKeys`) |
| File uploads (browser → Cloudflare R2 by presigned URL) | `presignInboxPut` / `presignInboxGet` in `apps/api/src/lib/r2.ts`, used in `inbox.ts` |
| Live updates to open browsers | `publishInboxEvent` / `signalFor` in `packages/domain/src/inbox/core.ts`; client in `apps/admin/src/lib/inbox-stream.ts` |

## 3. Rules that apply to every spec

1. **Branch and merge.** Work on `work/<name>/<topic>`. Never push to `master`: a merge deploys to the live shop immediately and runs migrations. The owner's technical lead (Tes) merges.
2. **Migrations are additive and idempotent.** New tables, new nullable columns, new indexes only. Never drop, rename or change a type. Write the SQL by hand in the style of `0070_unified_inbox.sql` (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `--> statement-breakpoint` between statements), add the matching entry to `packages/db/migrations/meta/_journal.json`, and mirror it in the Drizzle schema. State the undo in a comment at the top. **Migration numbers are reserved in section 6; use yours only.**
3. **Never call the real Meta API from a test.** Stub `globalThis.fetch` for `https://graph.facebook.com/`.
4. **Secrets.** Read tokens from env. Never log a token, never store one in the database, never return one from a route, never put one in a test fixture that looks real.
5. **Store first, then process.** Every webhook is saved to `inbox_webhook_event` before anything else, answered `200` quickly, and must be safe to process twice (use unique keys and `ON CONFLICT DO NOTHING`).
6. **One rule for who sees what.** Visibility goes through `canSeeConversation` / `conversationScope` in `packages/domain/src/inbox/scope.ts`. Do not write a second rule.
7. **Anything that leaves the building needs a person.** A public post, a public comment reply, a change to the Page or a profile, anything that spends money: a named staff member with the right permission clicks a button, sees a confirmation that shows exactly what will be sent, and the action is written to the audit log (`writeAudit`). No such action runs unattended unless its spec says so and names the owner switch that turns it on.
8. **Fail soft, say why.** A Meta refusal becomes a row or a banner the staff member can read ("Instagram refused this: the customer has not written in the last 24 hours"), not a thrown 500. Keep Meta's code and message in the record for support.
9. **Idempotent sends.** For anything sent to Meta that would be harmful twice (a message, a post, an ad), write the local row first in a "queued" state, then call Meta, then record the result, as `sendFromConversation` in `packages/domain/src/inbox/send.ts` does. A timeout is "unknown", not "failed".
10. **Tests are part of done.** Each spec lists the tests to write. Unit tests for every parser and builder; one integration test per webhook and per route family.
11. **Screens work on a phone.** Check at 390 px wide as well as desktop.
12. **Do not move files between `apps/admin` and `apps/suite`.** That move is scheduled separately. Put new **inbox-screen changes** in `apps/admin/src/...` (both apps get them) and **new suite-only sections** in `apps/suite/src/features/<area>/`.

## 4. Meta: what exists and how access works

| Thing | Value |
|---|---|
| Meta app | "Mrs Samuel fruit juice" |
| Business account | "aniukwu" (business verification pending on 19 Nov 2026) |
| Token | One system-user token, never expires, in env `META_SYSTEM_USER_TOKEN`. It holds every permission these specs need |
| WhatsApp | Test account with one test number. Rows in `inbox_phone_number` hold `waba_id` and `wa_phone_number_id` |
| Facebook Page | "Mrs Samuel fruit juice", assigned to the system user with messaging rights |
| Instagram | `mrs_samuelfruitjuice`, a professional account linked to that Page |
| Ad accounts, catalogues | None assigned yet |
| Webhook (WhatsApp) | `https://api.mrssamuel.com/v1/webhooks/whatsapp`, signed with `META_APP_SECRET` |
| Graph version | env `META_GRAPH_VERSION`, default `v23.0` in `meta.ts` |

**Access levels.** With *standard access* a permission works only for people who have a role on the Meta app (admin, developer, tester) and for assets the business owns. Real customers need *advanced access*, granted per permission by Meta's app review, which also requires business verification. So: **build and test with app-role accounts; every spec must work end to end that way**, and each spec lists the permissions to submit for review and what the review screencast must show.

**Page access tokens.** Page and Instagram endpoints need a *Page* access token, not the system-user token. Obtain it at run time with `GET /{page-id}?fields=access_token` using the system-user token, cache it in process memory for one hour, and never store it. Spec 01 builds this helper (`pageAccessToken()`); all later specs use it.

**Facts must be checked.** Meta changes its API often. Each spec marks every Meta fact as **[verified: URL, date]** or **[unverified]**. Before coding against an unverified fact, read the linked page. If the page disagrees with the spec, follow the page and note the difference in the pull request.

## 5. Shared design decisions

These are settled. Specs build on them.

**D1. A Page and an Instagram account are "lines", stored beside phone numbers.**
`inbox_phone_number` gains a text column `kind` (`'phone'` default, `'messenger'`, `'instagram'`) and `external_id` (the Page ID or the Instagram account ID); `e164` becomes nullable. Everything that hangs off a line keeps working unchanged: staff access (`inbox_user_number_access`), default team, opening hours, the "one live conversation per customer per line" rule, and the visibility rule. The existing `channels` enum stays and is meaningful only when `kind = 'phone'`. In code and on screen call these **channel accounts**; the table name stays.

**D2. A customer can have many identities.**
New table `inbox_identity (customer_id, channel, account_external_id, external_id, display_name, username, profile_pic_url, …)`, unique on `(channel, account_external_id, external_id)`. `channel` is `'whatsapp' | 'messenger' | 'instagram'`. Messenger and Instagram user IDs are scoped to the Page or Instagram account, hence `account_external_id`. `customer.phone` is already nullable; a customer who has only messaged on Instagram has no phone. Existing customer rows are never modified by ingestion (current rule; keep it).

**D3. One provider-message-id column.** `inbox_message.wa_message_id` (unique) holds the provider's message ID for every channel (WhatsApp `wamid…`, Messenger and Instagram `mid…`). Do not rename it. Add a comment in the schema.

**D4. One reply-window clock.** `inbox_conversation.last_inbound_wa_at` is "when the customer last wrote on this conversation's channel". It drives the 24-hour rule on all three channels. Do not rename it.

**D5. `inbox_conversation` and `inbox_message` gain `channel`** (text, default `'whatsapp'`) so lists can filter and show an icon without a join.

**D6. One new webhook for Page and Instagram:** `POST/GET /v1/webhooks/meta`, same signature check and app secret as WhatsApp. WhatsApp keeps its own address. Events are stored in `inbox_webhook_event` with `source = 'meta'` and `kind` set to `<object>.<field>` (for example `page.messages`, `instagram.comments`, `page.leadgen`).

**D7. Graph client.** Export `graph()` from `packages/domain/src/inbox/meta.ts` with an optional per-call token (for Page tokens). New Meta code goes in `packages/domain/src/meta/<area>.ts`, one file per spec, and is re-exported from the package index.

**D8. New permissions** (add to `CAPABILITIES` in `packages/shared/src/permissions.ts`; owner gets all; grant to admin and manager as each spec says):

| Permission | Lets a person |
|---|---|
| `channels.manage` | Connect and configure channel accounts; edit chat set-up, the WhatsApp profile and Page details (specs 01, 04, 05, 10) |
| `social.comments` | See and answer comments (spec 03) |
| `social.publish` | Create, schedule and publish posts (spec 09) |
| `templates.manage` | Write, submit and delete WhatsApp templates and Flows (specs 06, 07) |
| `catalogue.manage` | Run and repair catalogue sync (spec 08) |
| `insights.view` | See statistics (spec 11) |
| `ads.view` | See ad results and spend (spec 12) |
| `ads.manage` | Create, pause and change ads; **owner only by default** (spec 12) |
| `leads.view` | See leads from lead forms (spec 13) |

**D9. Where things show in the suite.** Menu sections, added to `NAV` in `apps/suite/src/SuiteShell.tsx` and routed in `apps/suite/src/router.tsx`:

| Section | Address | Specs |
|---|---|---|
| Inbox | `/inbox` | 02 (and 13 for leads arriving as conversations) |
| Comments | `/comments` | 03 |
| Posts | `/posts` | 09 |
| Catalogue | `/catalogue` | 08 |
| Ads | `/ads` | 12 |
| Leads | `/leads` | 13 |
| Insights | `/insights` | 11 |
| Reports | `/inbox/reports` | existing |
| Channels | `/channels` | 01, 04, 05, 10 |
| Templates and forms | `/templates` | 06, 07 |
| Settings | `/inbox/settings` | existing |

**D10. Errors and limits.** Treat Meta error code `190` (token invalid) and codes `10`, `200`, `299` (permission) as *configuration* problems: stop retrying, raise one owner alert through the `outbox_event` pattern used by `alertUnknownNumbers` in `webhooks-whatsapp.ts`, and show a banner. Treat `4`, `17`, `32`, `613`, `80007` and HTTP 429 and 5xx as *temporary*: retry with backoff. Everything else is a refusal: record it, show it, do not retry.

**D11. Media.** Incoming media is downloaded by the worker to R2 (existing `downloadPendingMedia`). Outgoing media and post images are uploaded by the browser to R2 with a presigned URL, and Meta is given a short-lived public URL. Meta's own media URLs expire; never store them as the durable copy.

**D12. Time.** The business runs on `Africa/Lagos`. Store timestamps as `timestamptz`. Show times in Lagos time. Helpers exist in `apps/admin/src/lib/inbox-logic.ts` (`lagosDayKey`, `dayLabel`).

**D13. Shared helpers that spec 01 builds and later specs call.** Use these names and shapes exactly, so specs written apart fit together.

```ts
// packages/domain/src/meta/accounts.ts
export type ChannelKind = "phone" | "messenger" | "instagram";
export type IdentityChannel = "whatsapp" | "messenger" | "instagram";

/** A row of inbox_phone_number seen as a channel account. */
export interface ChannelAccount {
  id: string;              // inbox_phone_number.id
  kind: ChannelKind;
  label: string;
  externalId: string | null;   // Page ID or Instagram account ID; null for phones
  pageId: string | null;       // the Page that owns it (same as externalId for messenger)
  isActive: boolean;
}

export function listChannelAccounts(db: DbExecutor, kind?: ChannelKind): Promise<ChannelAccount[]>;
export function channelAccountByExternalId(db: DbExecutor, kind: ChannelKind, externalId: string): Promise<ChannelAccount | null>;

/** Page access token for a Page, fetched with the system-user token and cached in memory for 1 hour. Never stored. */
export function pageAccessToken(cfg: MetaConfig, pageId: string): Promise<string>;

// packages/domain/src/inbox/core.ts
/** Find the customer for an identity on a channel, or create customer + identity. Runs inside a transaction. */
export function findOrCreateCustomerByIdentity(
  db: DbExecutor,
  identity: { channel: IdentityChannel; accountExternalId: string; externalId: string; displayName?: string | null; username?: string | null },
): Promise<{ customerId: string; identityId: string; created: boolean }>;
```

For an Instagram account, `inbox_phone_number.external_id` is the Instagram account ID and a second new column `page_external_id` holds the ID of the Page it is linked to (needed for the Page token and for sending).

## 6. Reserved numbers and names

| Spec | Migration file | New tables / columns (summary) |
|---|---|---|
| 01 | `0071_channel_accounts_identities.sql` | `inbox_phone_number.kind`, `.external_id`, `.page_external_id`, `e164` nullable; `inbox_identity`; `channel` on conversation and message |
| 02 | `0072_meta_messaging.sql` | columns for Messenger and Instagram message state |
| 03 | `0073_social_comments.sql` | `social_post_ref`, `social_comment` |
| 04 | `0074_chat_setup.sql` | `channel_chat_setup` |
| 05 | — | none (profile lives at Meta; a small cache column if needed goes in 0074) |
| 06 | `0075_template_authoring.sql` | `inbox_template` draft and review columns |
| 07 | `0076_wa_flows.sql` | `wa_flow`, `wa_flow_response` |
| 08 | `0077_catalogue_sync.sql` | `catalogue_link`, `catalogue_item_sync` |
| 09 | `0078_social_posts.sql` | `social_post`, `social_post_target` |
| 10 | — | none |
| 11 | `0079_insights.sql` | `insight_metric_daily` |
| 12 | `0080_ads.sql` | `ad_account_link`, `ad_campaign_cache`, `ad_insight_daily`, `ad_action_log` |
| 13 | `0081_leads.sql` | `lead_form`, `lead` |

Table prefixes: keep `inbox_` for things in the conversation timeline; use `social_`, `catalogue_`, `ad_`, `lead_`, `wa_`, `channel_` for the rest. If your spec turns out not to need its migration, leave the number unused; do not renumber others.

## 7. What every spec contains

1. **Outcome** — what a staff member can do when it is finished, in their words.
2. **Depends on** — specs, branches, and things a person must do in Meta first.
3. **Meta reference** — endpoints, fields, permissions, webhook fields, limits, error codes, each marked verified or unverified with its source.
4. **Data** — the exact migration SQL and the Drizzle additions.
5. **Server** — files to add or change, function signatures, routes with request and response shapes, permission per route, audit entries.
6. **Worker** — jobs, intervals, locking, retry rules.
7. **Screens** — each screen and dialog, its states (loading, empty, error, no permission), and the exact wording of labels and messages.
8. **Rules and edge cases** — numbered, each testable.
9. **Tests** — named tests to write, by file.
10. **Manual check** — a script a person follows with a tester account.
11. **Done when** — a checklist.
12. **Out of scope.**
13. **Work order** — numbered tasks, each small enough to finish and verify alone.
14. **Open questions** — with a recommended default so work is never blocked.

## 8. Before you start any spec

1. `git fetch && git switch -c work/<name>/<spec-topic> origin/master` (or the branch your spec depends on, if it is not merged yet).
2. Read this file, the blueprint, and your spec to the end.
3. Open every file named under "Patterns to copy" that your spec touches.
4. Check the spec's **[unverified]** Meta facts against the linked pages.
5. Do the work order in order. Run lint, type-check and tests after each task.
6. In the pull request, list: what you built, what you checked and how, what you could not check, and any place you departed from the spec and why.

---

## 9. Corrections and cross-spec rulings (added after the thirteen specs were written)

Writing the specs against the code and Meta's documentation turned up things this file had wrong or had not decided. **These rulings override sections 3 to 6 above and any spec that says otherwise.**

### 9.1 Corrections to this file

| # | Was | Now |
|---|---|---|
| C1 | Section 4: "every spec must work end to end with app-role accounts" | True except: **Instagram comment webhooks** need advanced access and a Live app (spec 03 polls instead); **lead retrieval** is refused while the Meta app is in Development mode (spec 13). Switching the app to Live affects every product on it and is Tes's decision |
| C2 | D10 files codes `10` and `200` as configuration problems | Classify by **code and subcode**. `10/2018278`, `10/2534022`, `10/2018108` and `200/1545041` are per-customer refusals (outside the window, person unavailable), not configuration. Each spec's error table is the authority for its API. Add `283` to configuration |
| C3 | D10's temporary list | Add `80000`–`80009` and `80014` (Pages, Instagram, Messenger, catalogue, WhatsApp account, leads, Marketing API rate limits) |
| C4 | D11: download all incoming media | **Never store story-mention media** (Meta policy). Two flows do not use R2: the WhatsApp profile photo (spec 05) and the Flows data endpoint (spec 07) |
| C5 | Rule 5: every webhook is stored in `inbox_webhook_event` | Except the Flows **data endpoint** (spec 07 Phase B), a live exchange that must answer within 10 seconds |
| C6 | Rule 7: nothing public or paid runs unattended | Three named owner switches, all **off by default**: scheduled publishing (spec 09), automatic order updates (spec 08), ad rules (spec 12). Ad rules and the ad safety stop may only **pause**, never spend |
| C7 | Section 6 table lists | Specs 03, 08, 11 and 12 create more tables than listed, all under their reserved prefix. Spec 01 adds `inbox_phone_number.external_name` and `inbox_conversation.identity_id`. This is accepted |
| C8 | D2: identities keyed by `account_external_id` | For WhatsApp use the constant `'global'`, and store the business-scoped user ID when Meta sends one |
| C9 | Section 4: the token "holds every permission these specs need" | Do not assume. Each spec's first manual step reads `GET /me/permissions` and the Page's `tasks`. The system user currently has the Page's messaging task; specs 10, 12 and 13 also need **MANAGE** and **ADVERTISE**, which the owner adds in Business Settings |
| C10 | Graph version default `v23.0` | Meta's documentation is on `v27.0`. Keep `META_GRAPH_VERSION` as the single switch. Before app review, Tes sets it to the current version on staging and the manual checks are re-run. Every pull request states which version it was checked on |
| C11 | "Suggested model" column | Unchanged, but specs 03, 07, 08 and 12 came out larger than planned; give them to Opus and build each in its phases |

### 9.2 Rulings where specs overlap

1. **Migration order is by timestamp, not by number.** Drizzle's migrator runs a file only if its journal `when` is later than the newest one already applied. The specs use increasing values (0071 = `1786200000000` … 0081 = `1787200000000`). **If specs merge out of order, the earlier-numbered one is silently skipped.** Whoever opens the pull request must set the new entry's `when` to be later than every entry on `master` and its `idx` to the last `idx` plus one, and say so in the pull request.
2. **One page gate.** Replace `NeedsInbox` in `apps/suite/src/router.tsx` with `Needs({ cap })`, taking the permission the page needs (spec 09's design). The first spec to land builds it; `hasSuiteAccess` in spec 03 is not built. A person signs in to the suite if they hold any suite permission and lands on the first menu item they may see.
3. **One dispatch point for the shared webhook.** Page and Instagram events are processed in `ingestMetaEntry` in `packages/domain/src/inbox/messenger-ingest.ts` (spec 02), which the worker's retry also calls. Specs 03, 12 and 13 add their handling **there**, looping over every `entry.changes[]` and every messaging event, never trusting the stored `kind`.
4. **Shared helpers are built once, by whichever spec lands first, with these names:** `graph()` exported with `opts.token` and `opts.onResponse`; `graphRaw()` and `uploadFileToMeta()` (spec 05) for non-JSON calls; `MetaApiError.subcode` and optional `details`; env `META_APP_ID`. `withViewer`, `need` and `visibleConversation` are exported from `apps/api/src/routes/inbox.ts`. Later specs import; they do not redefine.
5. **Error classifiers are per API and named for it:** `classifyMessagingError` (02), `classifyMetaError` for comments (03), and so on. No two exports share a name in the `@ms/domain` index.
6. **`sendFromConversation` remains the only send function.** Spec 02 adds the channel branch; specs 07 and 08 add `interactive` content to `OutboundContent`. Each adds its member without reshaping the others.
7. **`findOrCreateCustomer` is changed by spec 01 first** (identity lookup before phone match; identity written for phones). Spec 13 then widens its options. `customer_source` gains no values; Messenger, Instagram and lead customers use `'online'`.
8. **Tables that point at `inbox_conversation` or `customer`** must declare `ON DELETE CASCADE` or `SET NULL` and add their rows to the contact **erase** and **merge** routes in `inbox.ts`, or erase will fail on the foreign key.
9. **Postbacks from chat set-up** use the payload strings in spec 04 section 5.6; spec 02's postback handling follows that contract.
10. **Owner alerts** raised through `outbox_event` each need a `case` in `apps/worker/src/outbox.ts`. Unknown event types are sent to the owner's Telegram as raw text, so add the case in the same pull request as the alert.
11. **`graph()`'s network-failure wording** says "WhatsApp". Spec 01 changes it to "Meta" with the channel passed by the caller.
12. **The live stream opens only for people with `inbox.view`.** Screens for people without it (comments-only, posts-only) refresh every 30 seconds instead.

### 9.3 Found in the live system while writing the specs

These are defects today, independent of any new feature. Each is fixed by the spec named, but is worth a small pull request of its own first.

| Defect | Where | Fixed by |
|---|---|---|
| A WhatsApp message with no `from` (a customer using a username) is dropped and marked processed. The customer's message never appears and nobody is told | `ingestMessage` in `packages/domain/src/inbox/whatsapp-ingest.ts` | Spec 01, rule R14 |
| After two contacts are merged, the next message from the merged number reopens the old contact | `findOrCreateCustomer` in `core.ts` | Spec 01 |
| The hourly template sync marks any template Meta did not return as deleted; it would delete drafts | `syncAllTemplates` and its copy in `inbox.ts` | Spec 06 |
| `messaging_limit_tier` is deprecated at Meta | `getNumberInfo()` in `meta.ts` | Spec 05 |

### 9.4 Recommended build order

`01` → `02` → (`04`, `10`, `05` in any order) → `06` → `03` → `08` → `09` → `11` → `13` → `07` → `12`.

01 and 02 unblock most of the rest. 12 is last because it spends money and depends on attribution data from 02 and orders from 08.

### 9.5 How far to trust the Meta facts

Each spec tags every Meta fact. Across the thirteen specs about 450 are tagged verified and about 165 unverified. "Verified" means the named page on developers.facebook.com was read on 19 Nov 2026 through a tool that summarises pages, so wording is paraphrased and a few pages were read through a search extract because they asked for sign-in. **Treat a verified tag as "probably right, re-read before relying on a limit or a field name", and an unverified tag as "check first".** The specs were written by parallel drafting passes and have not yet been reviewed line by line by a person.
