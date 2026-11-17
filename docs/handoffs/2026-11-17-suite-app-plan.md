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

## The server (read over SSH on 17 Nov 2026, read-only)

| | Finding | What it means |
|---|---|---|
| Size | 2 CPUs, 3.8 GB memory, 78 GB disk, no swap. DigitalOcean. Up 130 days | Small, but lightly used |
| Memory | 1.2 GB in use, 2.2 GB available | Room to run the suite |
| Mrs Samuel's containers | About 350 MB in total: database 176 MB, API 61 MB, storefront 58 MB, worker 39 MB, admin 8 MB | The suite's web app will be about the size of the admin app: under 10 MB |
| Load | 0.5 on 2 CPUs; no out-of-memory kills since boot | Idle most of the time |
| **Another business shares the server** | Six containers for a second site ("n9ja wholesale"), about 430 MB | A heavy build or a full disk on one takes down both |
| **Disk** | 61 GB used of 78 GB (78%). About 50 GB is old Docker build files. The deploy script clears old images but never the build files | The disk will fill with more deploys. A full disk stops the database, which stops the shop and the till |
| Left-over volumes | 80 unused Docker volumes, small | Clutter, not urgent |
| Database | 213 MB | Small. Messages add little; recordings and media go to Cloudflare, not this disk |
| Tunnel | Cloudflare Tunnel is running | A new address is one entry in Cloudflare |

**Verdict.** The server can run the suite as planned (one small extra container, shared API and worker). In the load test the API used 264 MB at 20 messages a second, which fits. The risks are the disk and the deploys, not the day-to-day load.

**Before the suite is added, in this order:**
1. Clear the old build files: `docker builder prune` on the server frees most of the 50 GB. This deletes data, so the owner runs it. It does not touch running containers, images in use or databases.
2. Add the clean-up to the deploy script so it cannot build up again (a small code change, in a pull request).
3. Add 2 GB of swap, so a heavy build slows down instead of failing.
4. Add memory caps to the containers in the compose file (code change).

**Later, if calls become busy:** move to 4 CPUs and 8 GB, or give the wholesale site its own server. Call audio does not pass through this server, so that is about safety margin, not capacity.

`DEPLOY.md` still describes a Hetzner server; it is out of date.

## What I do not know yet

- The name of the subdomain. That is the owner's choice.
- Which Nigerian phone provider, and its features (needs a quote and a test number).
- Which Meta approvals are already granted on the business's account.

## The main design decision

| Option | What it means | Verdict |
|---|---|---|
| **A. Own web app, shared API and worker** | A new web app in this repository, alongside the admin app and the storefront. It uses the shop's existing API, background worker, database and staff accounts | **Chosen by the owner, 17 Nov** |
| B. A tab in the admin app | What exists today | Not what was asked; keeps the suite tied to the shop's layout |
| C. Fully separate product | Own repository, own database, talks to the shop over an API | Not recommended. Customers, orders and stock would be copied between two systems, which is where "the chat says in stock, the shop says sold out" comes from |

Option A makes the suite a third front end, the same way the admin app and the storefront are separate front ends over one API today. It adds exactly one container. "One customer, one record" stays true.

## How it is put together

```
www.<domain>    ──►  storefront   ─┐
admin.<domain>  ──►  admin app    ─┼──►  API  ──►  database
suite.<domain>  ──►  suite app    ─┘      ▲
                     (new, the only       │
                      new container)    worker (shop jobs + suite jobs,
                                                already separate loops)
```

- **Web app:** new `apps/suite`, built with the same tools as the admin app. Its own look, designed around conversations, with shared building blocks in a new `packages/ui` so buttons, tables and forms are made once and cannot drift the way the admin screens did.
- **Server:** the shop's existing API. The suite's routes already live in their own files inside it. Nothing new to run.
- **Worker:** the shop's existing worker. The suite's jobs already run in their own loop inside it, so a slow suite job cannot hold up a shop job.
- **Known trade-off:** every deploy restarts the API for a few seconds, for the shop and the suite alike. Meta re-sends a missed message for up to 7 days, so nothing is lost there. A phone call arriving in those seconds fails and cannot be retried. If that becomes a real problem once calls are live, the API can later be started a second time for calls only, with no code change.
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
| 3 | **Hosting.** One new container for the suite's web app in the compose file, with its web server config and a memory cap | Small | **Live at deploy:** Tes adds the tunnel address; the container starts on merge |
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

## Update: the owner's Meta Business Messaging Platform brief (17 Nov 2026)

The owner supplied a brief listing the services to build on the existing Meta app (WhatsApp Cloud API enabled, test number working, business verification pending). Its services are now in the feature list (`2026-11-17-suite-features.md`, rows marked "brief"). This section records how the brief fits what already exists.

### Where the brief and the existing code already agree

| The brief asks for | What exists |
|---|---|
| Node.js with TypeScript, Postgres, Redis | The shop is built on exactly this |
| Webhook answers fast, checks Meta's signature, ignores duplicates | Built and tested for WhatsApp |
| Messages stored, media downloaded before Meta's links expire | Built (media goes to Cloudflare storage) |
| 24-hour window logic, templates, delivery ticks | Built and tested |
| Background workers with retries | Built: the shop's worker, with the suite's jobs in their own loop |
| Live dashboard updates | Built |
| Roles, audit log, contact export and delete | Built |
| Secrets only in server settings | Already the rule here |

So the brief's "Phase 0" is done, and about half of its "Phase 1" (the WhatsApp inbox) is done. Nothing has to be restarted from scratch.

### Where they differ

| Topic | The brief | What I found | What I will do |
|---|---|---|---|
| Dashboard technology | Next.js | The shop's staff apps use Vite and React | Keep Vite and React, so the suite shares code and one way of building with the admin app |
| Queue | BullMQ or Celery | A database-backed job loop already runs the suite's jobs | Keep it; add a proper queue only if volume demands it |
| Payments | Paystack or Flutterwave | The shop takes payment through OPay | Build payment links behind one interface, OPay first |
| Cost of replies | Replies inside 24 hours are free | Meta's pricing page, read on 17 Nov, says replies are charged since 1 Oct 2026, with 1,000 free per number per month | Treat as charged until the owner's own WhatsApp Manager shows otherwise; build the usage counter |
| Free window after an ad click | 72 hours | Meta's pages disagree: 72 hours on one, "up to 7 days" on another | Read the expiry from each message instead of assuming |
| First marketing limit | About 250 customers a day | Same | Agreed |
| AI | An agent that answers customers by itself | The earlier recommendation was suggestions to staff first | Build both: the agent is the brief's centrepiece, but it stays off until the owner switches it on, per channel and hours |
| Instagram shopping tags, Facebook Shop | One catalogue powers them | Not confirmed as available in Nigeria | Sync the catalogue for WhatsApp and ads; add shop tags only if the account offers them |
| Calls | Not in the brief | Asked for earlier: virtual numbers, call tracking, AI on calls | Keep them in the suite |

### Added build steps

These join the plan after step 12, or earlier where the owner asks.

| # | Step | Size | Touches a live system? |
|---|---|---|---|
| 13 | **AI agent.** Knowledge base, the eight tools (search, product lookup, cart, payment link, order status, booking, lead, hand-over), memory, escalation, test area, transcript review | Large | **Live:** an AI provider key; every answer costs money |
| 14 | **Forms and bookings** with WhatsApp Flows | Medium | **Live:** Flows published in the Meta account |
| 15 | **Social:** comment-to-message, comment rules, story mentions, post scheduler | Large | **Live:** Meta app review for Instagram and Page permissions |
| 16 | **Ads engine:** create click-to-chat ads, daily results, rules, audiences | Large | **Live, and it spends money:** needs Meta's highest ads access |
| 17 | **Notifications and connections:** one-time codes, a private send address for other systems, outgoing notices, Sheets and CRM links | Medium | **Live:** each connected tool |
| 18 | **Several businesses in one suite**, if chosen | Large | Changes the database for every table in the suite |

### The decision that shapes everything: one business or several

The brief describes a platform that could serve several businesses (it names Diagofit as an example and says "multi-business, SaaS-ready"). The suite as planned serves Mrs Samuel only and shares the shop's database.

| Option | What it means | Cost |
|---|---|---|
| **A. Mrs Samuel only** | As planned. One new web app over the shop's API | Smallest. Fastest to live |
| **B. Several of the owner's own businesses** | Each business has its own numbers, staff, contacts and catalogue inside one suite. Mrs Samuel stays connected to its shop; the others connect to their own systems or none | Every suite table gains a "which business" column and every screen and check respects it. Much cheaper to do before go-live than after |
| **C. A product sold to other companies** | Option B plus sign-up, billing, each client connecting their own Meta account, and Meta's Tech Provider programme | A separate product. It should not share the shop's database or server |

Option B or C also changes two earlier decisions: the suite should then have its own API and database rather than living inside the shop's, and a health business brings stricter rules (health details are sensitive under Nigerian law, results must never be sent in a chat, and the AI must not answer clinical questions).

**Recommendation:** decide this before step 1. If there is any real chance of a second business within a year, build the "which business" column in from the start (Option B's data shape) while launching with Mrs Samuel alone.

### Questions from the brief, and what is already answered

| # | Question | Status |
|---|---|---|
| 1 | Which business first: Diagofit, e-commerce, or a platform for many? | **Open.** See above |
| 2 | Node.js or Python; hosting | Answered by what exists: Node.js, the current DigitalOcean server |
| 3 | Who uses the dashboard | **Open:** only the Mrs Samuel team, or other teams too |
| 4 | Payment provider | OPay today. **Open:** add Paystack or Flutterwave? |
| 5 | AI provider and monthly budget | Claude is already wired in for call summaries. **Open:** the monthly budget |
| 6 | Existing systems to connect | The shop itself. **Open:** any CRM, calendar or spreadsheet |
| 7 | Languages for the AI | **Open.** The brief lists English, Pidgin, Yoruba, Hausa, Igbo, French |
| 8 | Real WhatsApp number: new, or keep the phone app on the same number | **Open.** A new number is simpler and is required for WhatsApp calls |

## Owner's decisions (17 Nov 2026)

| Topic | Decision |
|---|---|
| Who it is for | Mrs Samuel only, for now. Option A: one new web app over the shop's API, worker and database |
| CRM | None to connect. The suite is the business's own CRM and must do what a CRM does: contacts, history, pipeline, tasks, groups, reports |
| Payments | Stay with OPay |
| AI languages | English |
| AI budget | Not fixed yet. No hard cap for now; the suite will show AI spend so a limit can be set later |
| WhatsApp number | The owner will supply a real number |
| Calendar, spreadsheet | None now; can be connected later if needed |

## What could go wrong

1. **The server's disk fills up, or a deploy starves the shop.** See "The server" below: the disk is 78% full, mostly old build files that no deploy clears, and there is no swap. We would notice as a failed deploy, or the shop's database stopping when the disk is full. Mitigation: clear the build files and add the clean-up to the deploy script before the suite is added; add swap; cap the new container's memory.
2. **Two sign-ins annoy staff.** The suite and the admin app are different addresses, so staff sign in to each. We would notice in the first week of use. Mitigation: one shared sign-in across both is possible later, but it changes how the session cookie is scoped for the admin app and the till, so it is a deliberate change for Tes, not a default.
3. **Moving the inbox breaks what was just fixed.** The screens were reviewed and fixed inside the admin layout; a new layout can reintroduce fit problems. We would notice in the screenshot check. Mitigation: the same full-screen review (every screen, desktop and phone) is run on the suite before step 2 is called done.

Also: every step from 5 on adds database tables, and a merge applies them to production automatically. Each will be additive and called out in its pull request.

## Decisions needed

| # | Decision | Who | Recommendation |
|---|---|---|---|
| 1 | Option A: own web app, shared API and worker | Owner | **Decided 17 Nov** |
| 2 | The subdomain name | Owner | Something short staff will say out loud, for example `hub`, `desk` or `connect` |
| 3 | The product's name on screen | Owner | Match the subdomain |
| 4 | Separate sign-in to start, or shared sign-in with the admin app | Tes | Separate to start |
| 5 | Release the inbox inside the admin app first, or only in the suite | Tes | Only in the suite, if steps 1 to 3 are approved now |
| 6 | Go to build steps 1 to 3 | Owner | Yes; they need no outside approvals |
| 7 | Start the approvals and accounts listed in the scope document | Owner and Tes | Now; they take the longest |
