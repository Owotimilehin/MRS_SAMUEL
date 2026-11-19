# Mrs. Samuel Business Suite: the blueprint

Written 19 Nov 2026 by Olu with Claude. This is the working map for the suite at `suite.mrssamuel.com`: what exists, where every piece lives, what to change to get a given result, how it goes live, and the order of everything still to build.

It replaces nothing. The feature list, the Meta research and the owner's decisions are in the three 17 Nov documents on the branch `work/olu/unified-inbox` (`suite-features`, `suite-app-plan`, `business-suite-scope`). This document is the "how and where".

## 1. Where things stand today

| Thing | State |
|---|---|
| The suite as its own app (`apps/suite`) | **Built on the branch `work/olu/suite-app`. Not live.** Sign-in, its own menu, Inbox, Reports, Settings, call bar, notifications |
| The inbox inside the shop's admin app | Live since 18 Nov. Stays until the suite is live and staff have moved over |
| New-message notifications (sound, pop-up, tab count) | Built on the same branch. Not live |
| WhatsApp connection | Live, on Meta's **test number**. Permanent system-user token in place since 18 Nov |
| Facebook Page and Instagram | The token can reach the Page "Mrs Samuel fruit juice" and the Instagram account linked to it. **No code uses them yet** |
| Phone calls | Code built for Twilio. Never taken a real call. Hidden until calling is set up |
| AI | Call-summary step exists. No transcription provider, so it cannot run |

**What blocks real customers today (all on Meta's side, all the owner's to fix):** the payment method error on the WhatsApp account, business verification (pending), the business profile missing Legal Name, Country and Website, and the real WhatsApp number not yet added.

## 2. How the suite is put together

```
www.mrssamuel.com    ──►  storefront  (apps/customer)  ─┐
admin.mrssamuel.com  ──►  admin app   (apps/admin)     ─┼──►  API (apps/api)  ──►  database
suite.mrssamuel.com  ──►  suite       (apps/suite)     ─┘        ▲
                          new container, port 3011               │
                                                         worker (apps/worker)
api.mrssamuel.com    ──►  API directly (Meta and Twilio call this)
```

- **One API, one database, one set of staff accounts.** The suite is a third front end. A customer in the suite is the same record as in the shop.
- **Staff sign in to the suite separately**, with the same email and password. The sign-in cookie belongs to one address, so being signed in to the admin app does not sign you in to the suite.
- **The suite reuses the inbox screens from the admin app's source for now.** Both apps must work side by side until staff have moved, and two copies of 7,000 lines would drift apart. The suite's build reads those files through an alias called `@admin`. Section 7 says when they move for good.
- **The seam between the screens and the app hosting them** is one small file, `apps/admin/src/lib/app-frame.tsx`. Each app hands the screens its own page frame and its own "customer profile" link.

## 3. Where everything lives

### The suite's own files (`apps/suite/`)

| File | What it is |
|---|---|
| `src/main.tsx` | Start-up: loads the styles, error reporting, the service worker, and hands the screens the suite's frame |
| `src/router.tsx` | The list of pages and their addresses; the sign-in page's wording; the "no access" page |
| `src/SuiteShell.tsx` | The page frame: the green menu, the header, the unread badge, the call bar, the notifier |
| `src/suite-host.tsx` | What the suite gives the shared screens; the address of the admin app |
| `src/nav.ts` | Which menu line lights up for an address |
| `src/suite.css` | Styles that belong to the suite only (the green menu, the badge) |
| `index.html` | The page title and fonts |
| `vite.config.ts` | Build settings; the installed-app name and icon; the `@admin` alias |
| `nginx.conf` | The web server inside the container: serves the app, forwards `/v1/` to the API, keeps the live stream open |
| `Dockerfile` | How the container is built |
| `public/brand-logo.png` | The logo |

### Shared screens and logic (in `apps/admin/src/`, used by both apps)

| What | Where |
|---|---|
| Inbox screen (list, chat, contact) | `routes/inbox/index.tsx`, `components/inbox/ConversationList.tsx`, `Timeline.tsx`, `Composer.tsx`, `ConversationHeader.tsx`, `ContactPanel.tsx` |
| Reports screen | `routes/inbox/reports.tsx` |
| Settings screen and its tabs | `routes/inbox/settings.tsx`, `components/inbox/SettingsNumbers.tsx`, `SettingsTeams.tsx`, `SettingsHours.tsx`, `GreetingUpload.tsx` |
| Call bar | `components/inbox/CallBar.tsx`, `lib/inbox-voice.ts` |
| Notifications | `hooks/useInboxNotifier.ts` (when to alert), `lib/inbox-notify.ts` (the sound and the pop-up), `components/inbox/NotifySettings.tsx` (the dialog behind the bell) |
| Live updates | `lib/inbox-stream.ts` |
| Rules with tests (24-hour window, ticks, labels, alert rules) | `lib/inbox-logic.ts`, `lib/inbox-logic.test.ts` |
| Calls to the server | `lib/inbox-api.ts`, `lib/inbox-settings-api.ts` |
| Inbox styles | `components/inbox/inbox.css` |
| Colours, type, buttons, cards | `index.css`, `tailwind.config.js` |
| Sign-in page | `routes/login.tsx` |

### The server

| What | Where |
|---|---|
| Inbox routes (conversations, messages, notes, contacts, notifications) | `apps/api/src/routes/inbox.ts` |
| Settings and reports routes | `apps/api/src/routes/inbox-settings.ts`, `inbox-reports.ts` |
| WhatsApp webhook (Meta calls this) | `apps/api/src/routes/webhooks-whatsapp.ts` |
| Voice routes (Twilio calls these) | `apps/api/src/routes/voice.ts` |
| Live-update fan-out | `apps/api/src/inbox/realtime.ts` |
| Talking to Meta (send, media, templates, signature check) | `packages/domain/src/inbox/meta.ts` |
| Turning a Meta webhook into messages | `packages/domain/src/inbox/whatsapp-ingest.ts` |
| Sending a message | `packages/domain/src/inbox/send.ts` |
| Customers, conversations, live signals | `packages/domain/src/inbox/core.ts` |
| Who may see which conversation | `packages/domain/src/inbox/scope.ts` |
| Talking to Twilio | `packages/domain/src/inbox/twilio.ts` |
| Background jobs (retries, media, templates, push, recordings, summaries) | `apps/worker/src/inbox-loop.ts`, `apps/worker/src/jobs/inbox-*.ts` |
| Database tables | `packages/db/src/schema/inbox.ts`; first migration `packages/db/migrations/0070_unified_inbox.sql` |
| Permission names (`inbox.view`, `inbox.reply`, …) | `packages/shared/src/` |
| Containers | `docker-compose.yml` (service `suite`, port 3011) |
| Deploy | `.github/workflows/deploy.yml`: a push to `master` rebuilds and restarts everything on the server |

### Settings on the server (`/opt/mrs-samuel/.env`, names only)

`META_APP_SECRET` (webhook signature), `META_VERIFY_TOKEN` (webhook handshake), `META_SYSTEM_USER_TOKEN` (every call to Meta), `META_GRAPH_VERSION` (optional), `INBOX_TEMPLATE_LANGUAGE` (optional), the `TWILIO_…` set (calls), `PUBLIC_ADMIN_URL` (also becomes the suite's "Shop admin" link).

After changing any of them: `cd /opt/mrs-samuel && docker compose up -d api worker`. The containers must say **Recreated**.

## 4. "I want to change…"

| To change | Edit |
|---|---|
| The suite's menu (add, rename, reorder) | `NAV` in `apps/suite/src/SuiteShell.tsx`, plus a route in `apps/suite/src/router.tsx` |
| The suite's colours or menu look | `apps/suite/src/suite.css` |
| The name in the browser tab | `apps/suite/index.html` |
| The installed-app name and icon | `manifest` in `apps/suite/vite.config.ts` |
| The words on the sign-in page | `SUITE_LOGIN_COPY` in `apps/suite/src/router.tsx` |
| Where "Shop admin" and "Orders & customer profile" lead | `PUBLIC_ADMIN_URL` on the server, or `adminUrl()` in `apps/suite/src/suite-host.tsx` |
| The notification sound | `playMessageSound()` in `apps/admin/src/lib/inbox-notify.ts` |
| Who gets alerted, and when it stays quiet | `shouldAlertForEvent()` in `apps/admin/src/lib/inbox-logic.ts` (tests beside it) |
| The wording of the notification choices | `LEVELS` in `apps/admin/src/components/inbox/NotifySettings.tsx` |
| The five lists (Mine, Unassigned, …) | `inboxTabsFor()` in `apps/admin/src/lib/inbox-logic.ts` |
| Any wording on an inbox screen | The screen's file in section 3; the change shows in both apps |
| Who may do what | Admin app → Users → the person's permissions. The names are in `packages/shared/src/` |
| A WhatsApp template | WhatsApp Manager; then Settings → Templates → Sync in the suite |
| Opening hours, teams, phone menu, quick replies | The suite's Settings screen. No code |
| The Meta token | `META_SYSTEM_USER_TOKEN` in the server's `.env`, then recreate `api` and `worker` |
| Which Graph API version is used | `META_GRAPH_VERSION` on the server (default `v23.0` in `meta.ts`) |

**Rule for every change:** make it on a branch named `work/olu/<topic>`, open a pull request, Tes merges. A merge to `master` deploys to the live shop at once and applies any database change with it.

## 5. Putting the suite live at suite.mrssamuel.com

Nothing here has been done. Steps 2 and 3 touch live systems.

| # | Step | Who | How to check |
|---|---|---|---|
| 1 | Review and merge the pull request for `work/olu/suite-app` | Tes | The deploy run is green |
| 2 | The deploy builds and starts the new `suite` container on port 3011. Nothing else changes: the admin app keeps its inbox | Automatic | On the server: `docker ps` shows `mrs-samuel-suite-1` up; `curl -s -o /dev/null -w '%{http_code}' localhost:3011/login` prints `200` |
| 3 | In Cloudflare → Zero Trust → Tunnels → the existing tunnel → Public hostnames, add `suite.mrssamuel.com` → `http://localhost:3011` | Tes | `https://suite.mrssamuel.com/login` shows the green "Business Suite" sign-in page |
| 4 | Sign in with a shop account that has inbox access | Owner | The inbox opens with the same conversations as the admin app |
| 5 | Click the bell → "Turn on pop-ups" → Allow. Send a WhatsApp message to the business number from a test phone | Each staff member, once per device | A sound, a banner, and (with the tab in the background) a pop-up |
| 6 | On a phone: open the address in Chrome or Safari → "Add to Home Screen" | Each staff member | The suite opens as its own app |

**Meta needs no change for this.** The webhook stays at `https://api.mrssamuel.com/v1/webhooks/whatsapp`. The privacy page stays at `https://mrssamuel.com/privacy`.

**To undo:** remove the Cloudflare hostname. The admin app's inbox is untouched throughout.

**After staff have used the suite for a week** (a separate pull request): remove the three inbox links from the admin app's menu and replace them with one "Customer messages" link to the suite; then do the file move in section 7.

## 6. Meta: what is connected and what each feature needs

Checked against Meta on 19 Nov through the live token (read-only).

| | State |
|---|---|
| App | "Mrs Samuel fruit juice" |
| Business account | "aniukwu". Verification **pending** |
| Token | System user `NEWUSERSYSTEM`, never expires |
| WhatsApp account | "Test Messaging Account", one number ("Test Number"), connected, quality green |
| Sending on WhatsApp | **Blocked by Meta** for business-started messages: payment method error, verification, incomplete profile. Replies inside 24 hours work |
| Facebook Page | "Mrs Samuel fruit juice", with messaging rights |
| Instagram | `mrs_samuelfruitjuice`, linked to the Page |
| Ad accounts, catalogues | None assigned to the system user |

| Feature | Permissions (the token has all of these) | Still needed from Meta |
|---|---|---|
| WhatsApp inbox, templates, media | `whatsapp_business_messaging`, `whatsapp_business_management` | Real number; payment method; verification |
| Messenger DMs | `pages_messaging`, `pages_manage_metadata` | Messenger product on the app; Page subscribed to the app; app review before real customers |
| Instagram DMs, story replies and mentions | `instagram_manage_messages`, `instagram_basic` | Instagram product on the app; "Allow access to messages" on in the Instagram app; app review |
| Comments (reply, hide, private reply) | `pages_manage_engagement`, `pages_read_user_content`, `instagram_manage_comments` | App review |
| Replying after 24 hours on Messenger and Instagram | "Human agent" feature | App review |
| Catalogue sync, product messages | `catalog_management` | A catalogue created and assigned to the system user |
| Ads results and ad creation | `ads_read`, `ads_management` | Ad account assigned; higher ads access for creation |
| Posting to Instagram | `instagram_content_publish` | App review |
| Lead forms | `leads_retrieval` | App review |

Until app review passes, Messenger and Instagram work only for people listed on the Meta app as admins, developers or testers. That is enough to build, test and record the demo that the review itself asks for.

**The token is wider than it needs to be** (it can create ads). Before go-live with real customers, issue one with only the permissions in use.

## 7. Build order from here

Each stage ends with something that can be shown working. Stages that add database tables are marked; a merge applies them to production automatically, so each migration only adds tables and columns.

| # | Stage | What gets built, and where | Database | Needs from outside | Done when |
|---|---|---|---|---|---|
| 0 | **Suite app + notifications** | This branch | No | Cloudflare hostname | Section 5 passes |
| 1 | **Watchdog** | Worker job that checks the Meta token and the account's health hourly and raises an owner alert: `apps/worker/src/jobs/inbox-meta-health.ts`, a banner in `SuiteShell.tsx` | No | Nothing | Revoking a test token raises an alert within the hour |
| 2 | **Customer identities** | A table of "this customer is this ID on this channel"; matching in `core.ts`; merge keeps identities | **Yes** (new table; `channel` on conversations) | Nothing | A customer with a WhatsApp number and an Instagram ID is one contact |
| 3 | **Messenger and Instagram DMs** | New webhook `apps/api/src/routes/webhooks-meta.ts`; `packages/domain/src/inbox/messenger-ingest.ts`; send path in `send.ts` and `meta.ts`; channel icon and filter in `ConversationList.tsx`; "Channels" tab in Settings | Yes (Page and Instagram accounts) | Messenger and Instagram products on the app; then app review | A DM from a tester on each app lands in the list and a reply reaches them |
| 4 | **Comments** | Ingest in the same webhook; reply, hide and private reply in the timeline | Yes | App review | A comment on a post appears and can be answered from the suite |
| 5 | **Contacts as a CRM** | A Contacts section in the suite: list, search, groups by rule, consent per channel, orders and spend beside the chat | Yes | Nothing | "Bulk buyers who ordered in the last 60 days" is a saved group |
| 6 | **Tasks and reminders** | Snooze, "call back Friday", reply-time targets with a warning | Yes | Nothing | A snoozed chat returns at its time; an overdue chat is flagged |
| 7 | **Catalogue sync and selling in chat** | Shop products pushed to Meta on change; product messages; WhatsApp cart becomes a shop order with an OPay link; order updates by template | Yes | Catalogue assigned; the shop's own templates approved | A sold-out juice shows as out of stock on WhatsApp within minutes |
| 8 | **Phone provider layer** | One interface with Twilio and a Nigerian provider behind it (`packages/domain/src/inbox/voice/`); spoken recording notice; fallback to a mobile when the server is down | Small | **Provider chosen, account, one test number** | A real call to a Nigerian number rings in the suite |
| 9 | **Call tracking** | A number per advert; source on every call and contact; report per source | Yes | Extra numbers | The report shows calls and orders per source |
| 10 | **AI: calls** | Transcription provider behind an interface; reason, outcome and promises on each call; follow-up tasks | Small | **Transcription provider and key** | A test call has a readable summary without anyone typing |
| 11 | **AI: suggested replies** | Drafts from quick replies, products, stock and order status; staff approve; daily spend cap from day one | Yes | AI budget figure | Staff accept or edit a draft in one tap |
| 12 | **AI agent** (answers by itself) | Knowledge base, tools, hand-over, test area, transcript review; off by default, per channel and hours | Yes | Owner's go-ahead after stage 11 has run live | It passes a written set of test questions before it is switched on |
| 13 | **Broadcasts** | Groups from stage 5, approved templates, Meta's limits respected, results | Yes | Verification; payment method; marketing terms | A send to a 20-person test group reports delivered, read and replied |
| 14 | **Forms and bookings (WhatsApp Flows)** | Delivery address, bulk-order enquiry, complaint, pickup slot | Yes | Flows published in the Meta account | A completed form arrives as structured data in the chat |
| 15 | **Ads and measurement** | Click-to-WhatsApp tracked to the order; purchases reported to Meta; daily spend and cost per sale | Yes | Ad account assigned; higher ads access | An order is traced back to the advert that started the chat |
| 16 | **Owner dashboard** | Sales, reply times, missed calls, campaign results on one page | No | Nothing | One page answers "how did this week go?" |
| 17 | **Phone app** | Point the existing app at the suite; add what the web app gained | No | Apple and Google developer accounts; a test on real phones | A message rings a locked phone |

**House-keeping that rides along:**

- **After stage 0 has been live a week:** move the inbox files out of `apps/admin/src` into `apps/suite/src`, move the shared building blocks (`api.ts`, `auth.tsx`, `toast.ts`, `Modal`, `ConfirmModal`, `DataState`, `Spinner`, the colour tokens) into a new `packages/ui`, and delete the `@admin` alias. The admin app keeps a single link to the suite.
- **Merge `work/olu/inbox-gaps`** (templates with a heading, picture or link button; the out-of-hours auto-reply). Without it, a template with a picture heading is refused by Meta (error 132012, seen on 18 Nov).
- **The suite's own templates:** the five in the account are Meta's samples. The shop's own (re-open a chat, order confirmed, out for delivery, missed call) need writing and submitting in WhatsApp Manager.

## 8. Decisions and actions that are not code

| # | What | Who | Blocks |
|---|---|---|---|
| 1 | Fix the payment method on the WhatsApp account | Owner | Templates, broadcasts, anything business-started |
| 2 | Fill in Legal Name, Country and Website on the business profile | Owner | Same |
| 3 | Finish business verification | Owner | Same, plus every app review |
| 4 | Supply the real WhatsApp number. If it is on the WhatsApp Business phone app today, it must be removed from the app first, and chat history on the phone is lost | Owner | Real customers on WhatsApp |
| 5 | Add the Messenger and Instagram products to the Meta app; switch on "Allow access to messages" in Instagram | Owner | Stage 3 testing |
| 6 | Choose the Nigerian phone provider; get a quote and one test number | Tes | Stages 8 and 9 |
| 7 | Choose the transcription provider | Tes | Stage 10 |
| 8 | Set a daily AI spend cap | Owner | Stages 11 and 12 |
| 9 | Write the shop's templates | Owner, with drafts from Olu | Stages 7 and 13 |
| 10 | Add the Cloudflare hostname | Tes | Stage 0 going live |

## 9. What could go wrong

1. **The suite's build breaks when someone changes the admin app.** The suite reads admin files directly until the move in section 7. We would notice as a failed suite build in CI or in the deploy. Mitigation: the suite is type-checked and built in the same CI run; do the file move soon after go-live.
2. **A deploy fails because the new container will not build on the server.** The deploy builds every container; a failure stops the whole deploy and leaves the old version running. We would notice as a red deploy run. Mitigation: the container build has not been run yet (Docker was not available on the machine that wrote it), so the first deploy should be watched, at a quiet hour.
3. **Staff keep two tabs open and get every alert twice.** The admin app and the suite both alert while both have the inbox. We would notice in the first day. Mitigation: it ends when the admin app's inbox links are removed; until then staff should use one.

Also known: CI on `master` was already failing on five tests unrelated to the inbox before this work, and deploys do not wait for CI. Both are worth fixing before the suite carries real customers.

## 10. How this was checked

- The admin app: type-check clean, 193 tests pass, build succeeds.
- The suite: type-check clean, its tests pass, production build succeeds.
- The suite was run on a developer machine against a pretend API and looked at in Chrome at desktop and phone sizes: sign-in page, inbox list, an open chat, the new-message banner, the notification settings, the phone layout. No page errors.
- **Not checked:** the suite against the real API and database, the container build, and the server test for the new live signal. All three need Docker, which was not running on the machine used.
