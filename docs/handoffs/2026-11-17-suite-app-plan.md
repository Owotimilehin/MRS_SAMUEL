# Business suite as its own application: scope and plan

Draft for approval, 17 Nov 2026, by Olu with Claude. Nothing here is built. It turns the suite scope (`2026-11-17-business-suite-scope.md`, which lists what Meta allows in Nigeria and the feature phases) into a plan for a standalone application on its own subdomain.

## Scope

**What is being asked.** Take the inbox out of the shop's admin app and build the business suite as an application of its own, reached at its own web address: every Meta channel, catalogue sync, virtual phone numbers, call tracking and AI.

**Why it matters.** Customer conversations are a different job from running the till and the factory, done by different people at different times. As a tab inside the admin app the suite inherits that app's menu, layout and release cycle. As its own application it can have a layout built for conversations, be opened by staff who never need the shop screens, and be updated without touching the till.

**Done looks like.** Staff open one address, sign in with their existing account, and handle messages, calls, the catalogue, broadcasts and reports there. The admin app keeps running the shop and links across. Both read the same customers, orders and stock.

## What I read first

| Fact (checked in the code) | Why it matters |
|---|---|
| Three public addresses today: `www`, `admin` and `api`, each a container behind one Cloudflare Tunnel on one server | A fourth address is a new container plus one tunnel entry. No new server needed to start |
| The admin app is static files behind a small web server that forwards `/v1/` to the API | The suite can be hosted the same way |
| Sign-in cookies belong to the exact address they were set on | Staff will sign in to the suite separately from the admin app, with the same email and password, unless we change this |
| The inbox screens are about 6,900 lines inside `apps/admin` | They move to the new app; they are not rewritten |
| Inbox server code already lives in its own files and its background jobs in their own loop | The server side is already separable |
| The calling code speaks only to Twilio | Call tracking with Nigerian numbers needs a second provider behind a common interface |
| Customers are matched by phone number only | Instagram, Messenger and WhatsApp usernames need a proper list of identities per customer |

## What I do not know yet

- The name of the subdomain. That is the owner's choice.
- How much memory the server has free. The guard blocks me from reading the DigitalOcean account; Tes can check with `free -h`.
- Which Nigerian phone provider, and its features (needs a quote and a test number).
- Which Meta approvals are already granted on the business's account.

## The main design decision

| Option | What it means | Verdict |
|---|---|---|
| **A. Own app, shared data** | New web app and its own server process and background worker, in this repository, using the same database and staff accounts | **Recommended** |
| B. A tab in the admin app | What exists today | Not what was asked; keeps the suite tied to the shop's layout |
| C. Fully separate product | Own repository, own database, talks to the shop over an API | Not recommended. Customers, orders and stock would be copied between two systems, which is where "the chat says in stock, the shop says sold out" comes from |

Option A gives a separate application in every way a user or operator can see (own address, own screens, own containers, own restarts) while "one customer, one record" stays true.

## How it is put together

```
suite.<domain>  ──►  suite web app (new container)
                         │  /v1/…
                         ▼
                     suite server (new container, same code base as the API,
                         │         runs only the suite's routes and webhooks)
                         ▼
                     shared database  ◄── shop API, shop worker (unchanged)
                         ▲
                     suite worker (new container: media, recordings, AI,
                                   catalogue sync, broadcasts)
```

- **Web app:** new `apps/suite`, built with the same tools as the admin app. Its own look, designed around conversations, with shared building blocks in a new `packages/ui` so buttons, tables and forms are made once and cannot drift the way the admin screens did.
- **Server:** the same code base started in "suite" mode, so Meta's and the phone provider's webhooks land on a process that a shop deploy does not restart. A dropped call during a deploy cannot be retried, so this separation matters.
- **Worker:** the inbox loop that already exists, started as its own container.
- **Accounts and permissions:** the existing staff accounts and the existing permission list. No second user table.
- **Admin app:** loses its inbox screens and gains a "Customer messages" link and a link from each customer's page.
- **Phone app:** points at the suite's address.
- **Meta:** one Meta app, with its webhook, privacy policy and data-deletion addresses on the suite's subdomain.

## The application's sections

| Section | Contents |
|---|---|
| Inbox | Every channel in one list: WhatsApp, Instagram, Messenger, comments, calls, voicemail |
| Calls | Live calls, history, recordings, tracking numbers and where calls came from |
| Contacts | One record per customer: identities on each channel, orders, spend, consent, notes, labels |
| Catalogue | What Meta shows for each product, sync status, what failed and why |
| Broadcasts | Audiences, templates, sends, results, opt-outs |
| Assistant | AI settings, what it may answer, suggested-reply review, call summaries |
| Reports | Volumes, reply times, missed calls, sources, message costs, sales that came from chats and calls |
| Settings | Channels and numbers, teams and hours, phone menus, templates, permissions, usage and limits |

## Plan

Each step ends with something that can be shown working. Nothing reaches customers until Tes merges, and steps marked **live** need a person to act on a live system.

| # | Step | Size | Touches a live system? |
|---|---|---|---|
| 1 | **Foundation.** Create `apps/suite` and `packages/ui`; sign-in; the suite's menu and layout; containers and web server config; local preview | Medium | No |
| 2 | **Move the inbox in.** Inbox, reports and settings screens move from the admin app to the suite with the new layout; admin app gets its links; phone app re-pointed | Medium | No |
| 3 | **Separate server and worker.** "Suite" mode for the server; own containers in the compose file; health checks | Small | **Live at deploy:** Tes adds the tunnel address and the containers start on merge |
| 4 | **First real test.** Meta test number and one phone number on the staging copy | Small | **Live:** Meta test app settings, by Tes or the owner |
| 5 | **Contacts.** Identities per channel, consent record, orders and spend on the contact, chats and calls on the shop's customer page | Medium | No (adds database tables) |
| 6 | **Instagram and Messenger.** Messages, story replies, comments and private replies, with Meta's reply-window rules | Large | **Live:** Meta app review |
| 7 | **Usage and cost counter** for WhatsApp, with a warning before the free replies run out | Small | No |
| 8 | **Catalogue sync.** Products, prices and in/out of stock to Meta; product messages; cart back as an order with a payment link; order updates on WhatsApp | Large | **Live:** Meta catalogue and templates. Needs the payment fixes merged |
| 9 | **Phone provider layer.** One interface, Twilio and a Nigerian provider behind it; customer-started WhatsApp calls | Large | **Live:** provider account and numbers |
| 10 | **Call tracking.** A number per advertising source; source on every call; reports | Medium | **Live:** extra numbers |
| 11 | **AI.** Transcripts and summaries, reason and outcome on each call, suggested replies, follow-up tasks; optional after-hours answers | Large | **Live:** transcription provider key |
| 12 | **Broadcasts and ad measurement** | Large | **Live:** Meta marketing terms and access level |

Steps 1 to 3 produce the standalone application with today's features. Steps 5 to 12 are the suite phases from the scope document, in the same order.

### Order of branches

The inbox pull request stays as it is, so the screen fixes and the Bundles fix are not held up. The suite is built on a new branch on top of it, `work/olu/suite-app`. If Tes prefers not to release the inbox inside the admin app at all, step 2 can land before that pull request is merged and the inbox would first appear in the suite.

## What could go wrong

1. **The server runs out of memory.** Three more containers on one machine, which also builds every deploy on itself. We would notice as slow deploys, containers restarting, or the till lagging. Mitigation: memory caps on the suite's containers; Tes checks free memory before step 3; a second small server for the suite is the fallback, and this design allows it without code changes.
2. **Two sign-ins annoy staff.** The suite and the admin app are different addresses, so staff sign in to each. We would notice in the first week of use. Mitigation: one shared sign-in across both is possible later, but it changes how the session cookie is scoped for the admin app and the till, so it is a deliberate change for Tes, not a default.
3. **Moving the inbox breaks what was just fixed.** The screens were reviewed and fixed inside the admin layout; a new layout can reintroduce fit problems. We would notice in the screenshot check. Mitigation: the same full-screen review (every screen, desktop and phone) is run on the suite before step 2 is called done.

Also: every step from 5 on adds database tables, and a merge applies them to production automatically. Each will be additive and called out in its pull request.

## Decisions needed

| # | Decision | Who | Recommendation |
|---|---|---|---|
| 1 | Approve Option A: own application, shared data | Owner and Tes | Yes |
| 2 | The subdomain name | Owner | Something short staff will say out loud, for example `hub`, `desk` or `connect` |
| 3 | The product's name on screen | Owner | Match the subdomain |
| 4 | Separate sign-in to start, or shared sign-in with the admin app | Tes | Separate to start |
| 5 | Release the inbox inside the admin app first, or only in the suite | Tes | Only in the suite, if steps 1 to 3 are approved now |
| 6 | Go to build steps 1 to 3 | Owner | Yes; they need no outside approvals |
| 7 | Start the approvals and accounts listed in the scope document | Owner and Tes | Now; they take the longest |
