# Business suite: going live (PR #24)

For Tes. Written 19 Nov 2026 by Olu with Claude. PR #24 (`work/olu/suite-all`) is ready to merge. Nothing has gone to master.

## In one paragraph

PR #24 contains the whole business suite: specs 01 to 13, spec 14 Phase A (contacts), and the review fixes so far. Merging it deploys on its own: the server pulls master, builds a new `suite` container on port 3011 and runs 13 database migrations. All 13 only add things. Before the new address works, someone has to do three things by hand: back up the database, add `suite.mrssamuel.com` to the Cloudflare Tunnel, and set `META_APP_ID`. Until Meta permissions and webhook fields are switched on, each Meta screen shows "not set up yet" instead of failing.

## What merging does automatically

| Step | What happens |
|---|---|
| Deploy workflow | `git reset --hard origin/master`, `docker compose up -d --build` |
| New container | `suite`: static files behind nginx, which forwards `/v1/` to the api. Listens on `HOST_BIND:3011` |
| Migrations | 0071 to 0082 and 0085 run when the stack starts (13 files) |
| Health check | Only the api (`/v1/health`). The suite container is **not** checked by the workflow |

### The 13 migrations

- Every one adds tables or nullable columns. None drops or renames anything, and none deletes rows.
- Two touch existing tables:
  - 0071 lets `inbox_phone_number.e164` be empty, because a Facebook Page has no phone number. Rows that are phones must still have one.
  - 0071 also fills a **new** column (`inbox_conversation.identity_id`) from past messages. It is one UPDATE over the conversations.
- 0085 (review fixes) adds five nullable columns to suite tables.
- There is no 0083 or 0084. Broadcasts was renumbered to **0086** and stays on its own branch until it is finished. Merge broadcasts only **after** PR #24, never before: its migration timestamp is later on purpose, so the migrator never skips it.

## Before you merge (Tes)

1. **Back up the database.** Run the nightly `pg_dump` line from `DEPLOY.md` by hand and check the file is not empty.
2. **Cloudflare Tunnel:** add the public hostname `suite.mrssamuel.com` → `http://localhost:3011`, next to `admin` and `api`.
3. **Server `.env`:** add `META_APP_ID=<the app's numeric ID>`. It is not a secret, and it is only needed for the WhatsApp profile photo upload. Everything else the suite needs is already in `.env` for the inbox. Optional:
   - `PUBLIC_SUITE_URL`: only if the address is not `https://suite.mrssamuel.com`.
   - `WA_FLOW_PRIVATE_KEY_B64` and `WA_FLOW_PRIVATE_KEY_PASSPHRASE`: leave empty. WhatsApp live forms (spec 07, Phase B) then stay off.

## After the deploy: checks (10 minutes)

1. The GitHub Actions deploy run is green and the log says "API healthy".
2. On the server, `docker compose ps` shows `suite` as Up.
3. `https://suite.mrssamuel.com` opens. Sign in with an existing admin account.
4. The admin app still works: open the Inbox and make a test sale on the till.
5. The suite's Inbox shows the same WhatsApp conversations as before.
6. `docker compose logs --tail=100 api worker` shows no migration errors.

**If something is wrong:** revert the merge commit on master, which redeploys the old code. The new columns and tables are additive, so the old code keeps working with them in place.

## Meta set-up (can come after go-live)

Each Meta area shows "not set up yet" until these are done. They are done once, in the Meta App Dashboard (app "Mrs Samuel fruit juice").

- **WhatsApp webhook fields:**
  - `message_template_status_update`, `message_template_quality_update` and `template_category_update` (templates, spec 06).
  - `account_update`, `business_capability_update` and `user_preferences` (spec 05).
  - `flows` (spec 07).
- **Facebook Page and Instagram:** connect the Page in the suite under Channels. The suite subscribes the Page itself, including `leadgen` for lead forms.
- **Permissions the app needs**, some of which need Meta's app review: `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_manage_engagement`, `pages_manage_posts`, `instagram_content_publish`, `read_insights`, `instagram_manage_insights`, `ads_management`, `ads_read`, `leads_retrieval`, `catalog_management`, `business_management`.

I have not checked which of these the app already has.

## Checked on 19 Nov

- Type checks clean. Lint shows 0 errors (2 warnings). The suite app builds.
- Unit tests pass: 1,118. Database tests: api 988 pass, worker 143 pass.
- The api database tests that fail (adjustments-history, customer-tracking, migration-0052-pickup, offline-replay, online-order and production-runs) also fail on master today. They are old and not from the suite. CI on PR #24 shows no failure that master does not also have.

## Still open

- **Broadcasts (spec 14, Phase B):** tasks 15 and 16 are done, and task 17 onwards is not. It is on `work/olu/suite-14b-broadcasts` and not in PR #24.
- **Two catalogue review fixes are not written.** One stops order updates announcing a status from before they were switched on. The other stops "Ask" and the worker both sending "delivery or pickup?". Their columns exist (0085) but nothing uses them yet.
- **The full list of review findings was not saved to a file.** The fixes done are M1 to M4, M6, M11, M12, F1, F15 (iv), the account-change check and the unconfirmed turn-on. A re-review of the money and order code would show what else is open.
- Old test debt on master (above) is worth a separate clean-up.
