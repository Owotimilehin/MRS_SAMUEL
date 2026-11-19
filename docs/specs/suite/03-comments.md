# Suite build spec 03: Comments on Facebook and Instagram posts

Size L. Suggested model: Opus. Read `00-foundation.md` first; it wins where the two disagree.

How to read the fact marks: **[verified: URL, 19 Nov 2026]** means the fact was read on that page of Meta's developer documentation on 19 Nov 2026 (through a page-reading tool, so wording is paraphrased, not quoted). **[unverified]** means it comes from memory or inference: open the page named beside it before coding against it.

---

## 1. Outcome

When this is finished, a staff member with the "Comments" permission can say:

- "I open **Comments** in the suite and see every comment customers left on our Facebook Page posts and our Instagram posts and reels, newest first, with the post it belongs to (text, picture, link)."
- "I can answer a comment publicly, hide it, show it again, delete it, and (on Facebook) like it. Before anything is sent I see exactly what will be posted and where."
- "I can send the person a **private message** about their comment. It opens a chat in the Inbox, and when they answer I carry on there."
- "I can see which comments still need an answer, who is dealing with each one, and mark one as done. The menu shows how many are waiting."
- "If Facebook or Instagram hid a comment, or the customer edited or deleted it, the suite shows that."
- "When we first connect, the last 30 days of comments are already there."

## 2. Depends on

| Needs | Why |
|---|---|
| Spec 01 merged (migration 0071) | `ChannelAccount`, `listChannelAccounts`, `channelAccountByExternalId`, `pageAccessToken`, `findOrCreateCustomerByIdentity`, exported `graph()` with a per-call token |
| Spec 02 merged (migration 0072) | `POST/GET /v1/webhooks/meta` storing events with `kind = "<object>.<field>"`; Messenger and Instagram conversations (the private reply writes into one) |
| In the Meta app dashboard (a person does this once) | Webhooks product → **Page** object: subscribe to `feed` and `mention`. **Instagram** object: subscribe to `comments`, `live_comments`, `mentions`. Then subscribe the Page to the app for `feed,mention` (section 5.6 does this from code) |
| The Instagram account is **public** | Private accounts get no comment or mention webhooks [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup, 19 Nov 2026] |
| A tester account | A Facebook user and an Instagram user who hold a role on the Meta app, to write test comments |

Nothing here needs app review to build and test on Facebook. **Instagram comment webhooks do need it** (section 3.2, fact I2); until then Instagram comments arrive by the polling job in section 6.

## 3. Meta reference

All calls go to `https://graph.facebook.com/{META_GRAPH_VERSION}/…` through `graph()` with the **Page access token** from `pageAccessToken(cfg, account.pageId)`. Meta's pages showed `v27.0` on 19 Nov 2026; the code default is `v23.0` (see section 14, Q1).

### 3.1 Facebook Page comments

| # | Fact | Mark |
|---|---|---|
| F1 | Page webhook field `feed` "describes nearly all changes to a Page's feed". Its `value` has, among others: `item`, `verb`, `comment_id`, `post_id`, `parent_id`, `from {id, name}`, `message`, `created_time`, `edited_time`, `photo`, `video`, `is_hidden`, `permalink_url`, `post {…permalink_url…}`, `reaction_type` | [verified: https://developers.facebook.com/docs/graph-api/webhooks/reference/page/, 19 Nov 2026] |
| F2 | `item` values include `comment`, `post`, `photo`, `video`, `status`, `share`, `reaction`, `mention`. `verb` values: `add`, `block`, `edit`, `edited`, `delete`, `follow`, `hide`, `mute`, `remove`, `unblock`, `unhide`, `update` | [verified: same page, 19 Nov 2026] |
| F3 | For a comment the verbs actually sent are `add`, `edited`, `remove`, `hide`, `unhide` | [unverified] the page lists the enum but not which verb goes with which item. Handle all of F2 as section 5.3 says |
| F4 | "Webhooks are not sent for Ad Posts, but are sent for Comments on Ad Posts." | [verified: same page, 19 Nov 2026] |
| F5 | To receive `feed`, a Page admin with MODERATE rights must have granted the app `pages_manage_metadata` | [verified: same page, 19 Nov 2026] |
| F6 | Page webhook field `mention`: new mentions of the Page in posts and comments. "Some comment_id and post_id fields returned in mention webhooks may not be queried due to missing permissions including privacy issues." Its `from` object is only filled for Workplace | [verified: same page, 19 Nov 2026] |
| F7 | Subscribe a Page: `POST /{page-id}/subscribed_apps` with `subscribed_fields` (array; includes `feed`, `mention`). Needs `pages_manage_metadata` and `pages_show_list`, Page token from someone with CREATE_CONTENT, MANAGE or MODERATE. Returns `{success: bool}`. `GET` on the same edge lists the app's `subscribed_fields`. Instagram fields cannot be set here; they are set in the app dashboard | [verified: https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps, 19 Nov 2026] |
| F8 | Read comments on an object: `GET /{object-id}/comments`. `filter=toplevel` (default) or `stream` (all levels, chronological); `order=chronological` or `reverse_chronological`; `summary=true` adds `total_count`. Reading a Page post's comment IDs needs the MODERATE task. Works on a Comment too (replies) | [verified: https://developers.facebook.com/docs/graph-api/reference/object/comments/, 19 Nov 2026] |
| F9 | Publish a reply: `POST /{object-id}/comments` with `message` (the object may be a comment). Needs a Page token from someone with MODERATE and `pages_manage_engagement`. Returns `{"id": "{comment-id}"}` | [verified: same page, 19 Nov 2026] |
| F10 | Comment node `GET /{comment-id}`: fields confirmed on the page: `id`, `can_comment`, `can_reply_privately`, `comment_count`, `is_private`, `like_count`, `parent`, `private_reply_conversation`, `user_likes`, `live_broadcast_timestamp` | [verified: https://developers.facebook.com/docs/graph-api/reference/comment/, 19 Nov 2026] |
| F11 | Comment node also returns `message`, `from {id,name}`, `created_time`, `is_hidden`, `can_hide`, `can_remove`, `can_like`, `permalink_url`, `attachment` | [unverified] not in the field table the tool returned for https://developers.facebook.com/docs/graph-api/reference/comment/. Request them; treat every one as optional in the parser |
| F12 | Hide or show: `POST /{comment-id}` with `is_hidden=true|false` ("Only applicable to Page comments"). Returns `{success: bool}` | [verified: https://developers.facebook.com/docs/graph-api/reference/comment/, 19 Nov 2026] |
| F13 | Delete: `DELETE /{comment-id}`. Returns `{success: bool}` | [verified: same page, 19 Nov 2026] |
| F14 | Like: `POST /{comment-id}/likes`, Page token with `pages_manage_engagement` (or CREATE_CONTENT task). Returns `{"success": true}`. If the Page already reacted, the call succeeds and nothing changes. Unlike: `DELETE /{comment-id}/likes` (the page words this for "Page objects"; comments are not named) | like [verified: https://developers.facebook.com/docs/graph-api/reference/object/likes/, 19 Nov 2026]; unlike on a comment [unverified] |
| F15 | Post details: `GET /{page-id}_{post-id}?fields=id,message,story,created_time,permalink_url,full_picture,status_type,is_hidden,is_published,from`. Expired posts cannot be read. Reels are not returned by this endpoint | [verified: https://developers.facebook.com/docs/graph-api/reference/page-post/, 19 Nov 2026] |
| F16 | List recent posts: `GET /{page-id}/feed`. Needs `pages_read_engagement` and `pages_read_user_content`. At most 100 posts per `limit`; about 600 ranked published posts per year; no reels. `updated_time` on a post moves when someone comments | feed [verified: https://developers.facebook.com/docs/graph-api/reference/page/feed, 19 Nov 2026]; `updated_time` meaning [verified: https://developers.facebook.com/docs/graph-api/webhooks/reference/page/, 19 Nov 2026] |
| F17 | Private reply: `POST /{page-id}/messages` with `recipient: {"comment_id": "<id>"}` (or `post_id`) and a `message`. Needs `pages_messaging` and a Page token from someone with the MESSAGING task. "Only one message can be sent to the person who commented." "The message must be sent within 7 days from when the post or comment was created." The conversation continues only if the person answers, then the normal 24-hour window applies. Cannot private-reply to another Page. All Send API message types are allowed | [verified: https://developers.facebook.com/docs/messenger-platform/discovery/private-replies, 19 Nov 2026] |
| F18 | The private-reply response contains `recipient_id` (the person's Page-scoped ID, the same one Messenger webhooks use) and `message_id` | [unverified] the page does not describe the response. Code must work when `recipient_id` is missing (rule R19) |
| F19 | `from.id` on a Page comment is the same Page-scoped ID that Messenger uses for that person | [unverified]. Do **not** rely on it: the identity for the chat comes from F18's `recipient_id` |
| F20 | Meta refuses a second private reply to the same comment with error code `10900` | [unverified] code from memory. Treat any refusal as rule R18 says; do not branch on this code |

### 3.2 Instagram comments

| # | Fact | Mark |
|---|---|---|
| I1 | Instagram webhook fields `comments`, `live_comments`, `mentions` need `instagram_manage_comments` (plus `instagram_basic`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` under Facebook Login) | [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields, 19 Nov 2026] |
| I2 | "Advanced Access is required for `comments` and `live_comments` notifications." The app must be published (Live) to get notifications for app users. Private accounts get none. Live-video comment notifications stop when the broadcast ends. Notifications carry no album ID | [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup, 19 Nov 2026] |
| I3 | Payload: `{"object":"instagram","entry":[{"id":"<IG account id>","time":…,"changes":[{"field":"comments","value":{"from":{"id","username"},"id" or "comment_id","parent_id"?,"text"?,"media":{"id","media_product_type"?,"ad_id"?,"ad_title"?,"original_media_id"?}}}]}]}`. `parent_id` only on replies. `live_comments` has the same shape | [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples, 19 Nov 2026]. The tool showed the comment's ID under `comment_id` in one variant and `id` in another: **read `value.id ?? value.comment_id`** |
| I4 | `mentions` payload: `value: {"media_id"}` (mentioned in a caption) or `value: {"comment_id","media_id"}` (mentioned in a comment). No mention webhook when the media is from a private account; story mentions are not covered | [verified: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples, 19 Nov 2026] and [verified: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/mentions.md, 19 Nov 2026] |
| I5 | Read a mentioned comment: `GET /{ig-user-id}?fields=mentioned_comment.comment_id({id}){id,text,timestamp,like_count,media}`. Errors if comments are disabled on that media | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_comment, 19 Nov 2026] |
| I6 | No webhook is sent when an Instagram comment is edited, hidden or deleted | [unverified] no such field is listed on https://developers.facebook.com/documentation/instagram-platform/webhooks/fields. The refresh in rule R13 covers it |
| I7 | List comments: `GET /{ig-media-id}/comments`: newest first by default, at most 50 per query, top-level only unless `replies` is requested by field expansion, cannot filter by time. For a boosted post it returns comments from the post and the ad | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments, 19 Nov 2026] |
| I8 | IG Comment fields: `from`, `hidden`, `id`, `like_count`, `media`, `parent_id`, `replies`, `text`, `timestamp`, `user`, `username`. Comments on age-gated media and from restricted users are not returned. Live-video comments can be read only during the broadcast | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment, 19 Nov 2026] |
| I9 | Reply: `POST /{ig-comment-id}/replies` with `message`. "You can only reply to top-level comments; replies to a reply will be added to the top-level comment." "You cannot reply to hidden comments." "You cannot reply to comments on a live video; use the Instagram Messaging API to send a private reply instead." Returns `{"id": "…"}` | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies, 19 Nov 2026] |
| I10 | Hide or show: `POST /{ig-comment-id}?hide=true|false` → `{"success": true}`. Comments by the media owner on their own media always stay visible. Not supported on live video | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment, 19 Nov 2026] |
| I11 | Delete: `DELETE /{ig-comment-id}` → `{"success": true}`. Only the owner of the media can delete. Not supported on live video | [verified: same page, 19 Nov 2026] |
| I12 | There is no endpoint to like an Instagram comment | [unverified] none is listed on https://developers.facebook.com/docs/instagram-platform/comment-moderation (checked 19 Nov 2026). The Like button is not shown for Instagram |
| I13 | Media details: `GET /{ig-media-id}?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,is_comment_enabled`. `media_url` can be missing (copyright audio): treat it as optional and fall back to `thumbnail_url`, then to no picture | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media, 19 Nov 2026] |
| I14 | List recent media: `GET /{ig-user-id}/media` (up to 10K most recent; stories not included; `since`/`until` supported) | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media, 19 Nov 2026] |
| I15 | Private reply: `POST /{ig-user-id}/messages` with `recipient: {"comment_id": "<id>"}`, `message: {"text": "…"}`. Needs `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`, and `instagram_manage_messages`. "Only one message can be sent to the commenter." Must be sent within 7 days of the comment. For Instagram Live only during the broadcast. Follow-ups only if the person answers, within 24 hours of the answer. It lands in the person's Inbox if they follow the account, otherwise in Requests, with a link to the post. Response: `recipient_id` (Instagram-scoped ID) and `message_id` | [verified: https://developers.facebook.com/docs/instagram-platform/private-replies, 19 Nov 2026] |

### 3.3 Limits and errors

| # | Fact | Mark |
|---|---|---|
| L1 | Pages: calls in 24 h = 4800 × engaged users. Instagram: calls in 24 h = 4800 × impressions (messaging excluded). Instagram private replies: 750 calls per hour per account for posts and reels, 100 per second for Live | [verified: https://developers.facebook.com/docs/graph-api/overview/rate-limiting, 19 Nov 2026] |
| L2 | Rate-limit error codes: `4` (app), `17` (user), `32` (Pages, user token), `613` (custom limit), `80001` (Pages, Page or system-user token), `80002` (Instagram), `80006` (Messenger) | [verified: same page, 19 Nov 2026]. **`80001`, `80002`, `80006` are not in foundation D10's temporary list; this spec treats them as temporary** (section 14, Q2) |
| L3 | Permission problems come back as `200`, `190`, `10`, and `283` ("requires the extended permission pages_read_engagement and/or pages_read_user_content…") | `200`, `190`, `283` [verified: https://developers.facebook.com/docs/graph-api/reference/comment/, 19 Nov 2026]; `10` from foundation D10 |
| L4 | Reading a comment or post that no longer exists returns code `100` (often subcode `33`) | [unverified]. Rule R14 says how to tell "gone" from other refusals |
| L5 | Maximum comment length: Facebook 8,000 characters, Instagram 2,200 | [unverified]. The suite's own limit is 1,000 characters for a public reply and for a private reply |

### 3.4 Permissions and review

| Permission | Used for | Mark |
|---|---|---|
| `pages_read_engagement` | read the Page's own posts | [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026] |
| `pages_read_user_content` | read customers' comments | [verified: same page, 19 Nov 2026] |
| `pages_manage_engagement` (requires the two above and `pages_show_list`) | reply, hide, delete, like | [verified: same page, 19 Nov 2026] |
| `pages_manage_metadata` | subscribe to webhooks | [verified: same page, 19 Nov 2026] |
| `pages_messaging` | Facebook private reply | [verified: https://developers.facebook.com/docs/messenger-platform/discovery/private-replies, 19 Nov 2026] |
| `instagram_basic`, `instagram_manage_comments` | read, reply, hide, delete on Instagram | [verified: same permissions page, 19 Nov 2026] |
| `instagram_manage_messages` | Instagram private reply | [verified: https://developers.facebook.com/docs/instagram-platform/private-replies, 19 Nov 2026] |

**To submit for advanced access:** all eight above (list `pages_show_list` as a dependency). Meta asks for at least one successful API call per permission before the request, a screencast per permission showing the end-to-end use, and step-by-step test instructions with sign-in details for the reviewer [verified: https://developers.facebook.com/documentation/instagram-platform/app-review.md, 19 Nov 2026].

**The screencast must show, in one take, with captions:** (1) signing in to the suite; (2) a tester writing a comment on a Page post in Facebook; (3) that comment appearing in Comments with the post beside it (`pages_read_user_content`, `pages_read_engagement`, `pages_manage_metadata`); (4) typing a reply, the confirm dialog, then the reply shown under the post on Facebook (`pages_manage_engagement`); (5) Hide, then the comment greyed on Facebook; Show again; Delete; (6) "Message privately", confirm, the message arriving in the tester's Messenger, and the chat open in the suite's Inbox (`pages_messaging`); (7) the same steps 2 to 6 on an Instagram post (`instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`). Say aloud or caption what each button does.

## 4. Data

File `packages/db/migrations/0073_social_comments.sql`. Add to `packages/db/migrations/meta/_journal.json` after the 0072 entry: `{"idx": 72, "version": "7", "when": 1786400000000, "tag": "0073_social_comments", "breakpoints": true}` (if the 0072 entry's `when` is not smaller, use that value plus 100000000).

```sql
-- Comments on Facebook Page posts and Instagram posts (suite spec 03).
-- Additive only: four new social_* tables. No existing table is altered.
-- Undo: DROP TABLE social_comment_rule; DROP TABLE social_comment;
--       DROP TABLE social_post_ref; DROP TABLE social_comment_account;

CREATE TABLE IF NOT EXISTS "social_comment_account" (
  "account_id" uuid PRIMARY KEY REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  "backfill_started_at" timestamptz,
  "backfilled_at" timestamptz,
  "last_polled_at" timestamptz,
  "paused_until" timestamptz,
  "last_error_code" text,
  "last_error" text,
  "last_error_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_post_ref" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "network" text NOT NULL CHECK ("network" IN ('facebook','instagram')),
  "external_id" text NOT NULL,
  "message" text,
  "permalink_url" text,
  "picture_url" text,
  "media_type" text,
  "is_ad" boolean DEFAULT false NOT NULL,
  "posted_at" timestamptz,
  "remote_comment_count" integer,
  "remote_updated_at" timestamptz,
  "fetched_at" timestamptz,
  "fetch_attempts" integer DEFAULT 0 NOT NULL,
  "fetch_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_post_ref_ext" ON "social_post_ref" ("network","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_ref_account" ON "social_post_ref" ("account_id","posted_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_comment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "social_post_ref"("id"),
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "network" text NOT NULL CHECK ("network" IN ('facebook','instagram')),
  "external_id" text,
  "parent_external_id" text,
  "root_id" uuid REFERENCES "social_comment"("id"),
  "kind" text DEFAULT 'comment' NOT NULL CHECK ("kind" IN ('comment','live','mention')),
  "author_external_id" text,
  "author_name" text,
  "author_username" text,
  "from_business" boolean DEFAULT false NOT NULL,
  "sent_by_user_id" uuid REFERENCES "admin_user"("id"),
  "message" text,
  "attachment_url" text,
  "status" text DEFAULT 'visible' NOT NULL CHECK ("status" IN ('visible','hidden','deleted')),
  "hidden_source" text CHECK ("hidden_source" IN ('suite','outside')),
  "status_changed_at" timestamptz,
  "edited_at" timestamptz,
  "send_status" text CHECK ("send_status" IN ('queued','sent','failed','unknown')),
  "error_code" text,
  "error_message" text,
  "liked_by_business" boolean DEFAULT false NOT NULL,
  "like_count" integer,
  "needs_fetch" boolean DEFAULT false NOT NULL,
  "work_state" text DEFAULT 'open' NOT NULL CHECK ("work_state" IN ('open','done')),
  "assignee_id" uuid REFERENCES "admin_user"("id"),
  "unread_count" integer DEFAULT 0 NOT NULL,
  "last_activity_at" timestamptz DEFAULT now() NOT NULL,
  "last_preview" text,
  "done_by_user_id" uuid REFERENCES "admin_user"("id"),
  "done_at" timestamptz,
  "refreshed_at" timestamptz,
  "private_reply_status" text CHECK ("private_reply_status" IN ('queued','sent','failed','unknown')),
  "private_reply_body" text,
  "private_reply_message_id" text,
  "private_reply_by_user_id" uuid REFERENCES "admin_user"("id"),
  "private_reply_at" timestamptz,
  "private_reply_error_code" text,
  "private_reply_error" text,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id"),
  "commented_at" timestamptz NOT NULL,
  "payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_comment_ext" ON "social_comment" ("network","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_threads" ON "social_comment" ("work_state","last_activity_at" DESC) WHERE "root_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_root" ON "social_comment" ("root_id","commented_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_post" ON "social_comment" ("post_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_fetch" ON "social_comment" ("created_at") WHERE "needs_fetch";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_comment_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  "keyword" text NOT NULL,
  "match" text DEFAULT 'contains' NOT NULL CHECK ("match" IN ('contains','exact')),
  "reply_text" text NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "activated_by_user_id" uuid REFERENCES "admin_user"("id"),
  "activated_at" timestamptz,
  "sent_count" integer DEFAULT 0 NOT NULL,
  "last_sent_at" timestamptz,
  "created_by_user_id" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
```

How the columns are used:

- **A thread** is one top-level comment plus its replies. The top-level row has `root_id IS NULL`; every reply has `root_id` = that row's `id`. The columns `work_state`, `assignee_id`, `unread_count`, `last_activity_at`, `last_preview`, `done_*`, `refreshed_at` mean something **only on the root row**; on replies they keep their defaults and are never read.
- `external_id` is Meta's comment ID. It is `NULL` only on a reply the suite has queued and Meta has not yet confirmed. The unique index treats NULLs as distinct, so many queued rows can coexist.
- `status` is what the public sees: `visible`, `hidden`, `deleted`. `hidden_source` is `suite` when a staff member hid it here, `outside` when it was hidden in Meta's own screens or by Meta's filters.
- `send_status` is set only on replies written in the suite. `private_reply_*` and `conversation_id` are per comment (root or reply): one private reply per comment.
- `picture_url` on `social_post_ref` is Meta's short-lived address (D11). It is a convenience, never the durable copy; the screen hides the picture if it fails to load.
- `social_comment_rule` is for the optional Phase B (section 5.8). The table is created now so no later migration is needed; nothing reads it in Phase A.

**Drizzle:** new file `packages/db/src/schema/social.ts` exporting `socialCommentAccount`, `socialPostRef`, `socialComment`, `socialCommentRule`, mirroring the SQL exactly (text columns with the CHECKs written as comments, as `inbox.ts` does for free-text status columns). Export it from the schema index next to `inbox.js`. Types: `export type SocialNetwork = "facebook" | "instagram";` in `packages/shared/src/social.ts`.

**Permission:** add `"social.comments"` to `CAPABILITIES` in `packages/shared/src/permissions.ts` (after `"inbox.reports"`, under a comment `// ── Suite: comments on Facebook and Instagram posts ──`), and to `ADMIN_CAPS` and `MANAGER_CAPS`. Owner gets it automatically. Not branch staff. In `apps/admin/src/components/GateEditor.tsx` add it to the inbox group with the label **"See and answer comments (Facebook, Instagram)"**.

**Live events:** add `"comment.created"` and `"comment.updated"` to `INBOX_EVENTS` in `packages/shared/src/inbox.ts`.

## 5. Server

### 5.1 Files

| File | New or changed | Holds |
|---|---|---|
| `packages/domain/src/meta/comments.ts` | new | Parsers, Graph calls, ingestion, actions (5.2 to 5.5). Re-export from `packages/domain/src/index.ts` |
| `packages/domain/src/meta/comments.test.ts` | new | Unit tests (section 9) |
| `packages/shared/src/social.ts` | new | `SocialNetwork`, `COMMENT_MAX = 1000`, `PRIVATE_REPLY_DAYS = 7`, `canPrivateReply()`, `commentActionsFor()` (pure; used by API and screens) |
| `apps/api/src/routes/social-comments.ts` | new | `socialCommentRoutes(db)` (5.7) |
| `apps/api/src/test-app.ts` | changed | `app.route("/v1/social/comments", socialCommentRoutes(db));` after the inbox routes |
| `apps/api/src/routes/webhooks-meta.ts` (spec 02) | changed | call `ingestCommentChanges` from the stored-event processor (5.3) |
| `apps/api/src/inbox/realtime.ts` | changed | `shouldDeliver` rule for `comment.*` events (5.9) |
| `apps/worker/src/jobs/social-comments.ts` | new | Jobs (section 6) |
| `apps/worker/src/outbox.ts` | changed | a `case "social.comments_config":` beside `"inbox.unknown_number"` that sends the owner: `Comments: the suite can no longer read or answer comments on {label}. Meta said: {message} (code {code}). Open Channels in the suite to check the connection.` |

### 5.2 Types and parsers (`comments.ts`)

```ts
export const COMMENT_PAGE_FIELDS = ["feed", "mention"] as const;
export const COMMENT_IG_FIELDS = ["comments", "live_comments", "mentions"] as const;

/** True when a stored /v1/webhooks/meta payload has at least one change this spec handles. */
export function isCommentEvent(payload: unknown): boolean;

export type ParsedCommentChange =
  | { type: "upsert"; network: SocialNetwork; accountExternalId: string; kind: "comment" | "live" | "mention";
      externalId: string; postExternalId: string; parentExternalId: string | null;
      authorExternalId: string | null; authorName: string | null; authorUsername: string | null;
      message: string | null; attachmentUrl: string | null; commentedAt: Date; edited: boolean;
      postPermalink: string | null; isAd: boolean; raw: Record<string, unknown> }
  | { type: "status"; network: SocialNetwork; accountExternalId: string; externalId: string;
      status: "hidden" | "visible" | "deleted"; at: Date }
  | { type: "mention_ref"; network: "instagram"; accountExternalId: string; mediaExternalId: string;
      commentExternalId: string | null; at: Date }
  | { type: "ignored"; reason: string };

/** One Page `feed` or `mention` change → zero or one parsed change. Pure. */
export function parsePageChange(pageId: string, field: string, value: Record<string, unknown>, entryTime: number): ParsedCommentChange;
/** One Instagram `comments` / `live_comments` / `mentions` change. Pure. */
export function parseInstagramChange(igId: string, field: string, value: Record<string, unknown>, entryTime: number): ParsedCommentChange;
```

`parsePageChange` rules, in order:

1. `field === "feed"` and `value.item !== "comment"` → `ignored` ("not a comment"). Reactions, posts, shares and the rest are not this spec's.
2. `value.comment_id` missing → `ignored`.
3. `verb` `add`, `edited`, `edit`, `update` → `upsert` with `edited = verb !== "add"`. `parentExternalId` is `null` when `value.parent_id` is missing or equals `value.post_id`, else `value.parent_id`. `message = value.message ?? null`. `attachmentUrl = value.photo ?? value.video ?? null`. `commentedAt`: `value.created_time` as seconds when it is a number, as a date when it is a string, else `entryTime` (seconds). `postPermalink = value.post?.permalink_url ?? value.permalink_url ?? null`.
4. `verb` `remove` or `delete` → `status: deleted`. `hide` → `status: hidden`. `unhide` → `status: visible`.
5. Any other verb (`block`, `follow`, `mute`, `unblock`) → `ignored`.
6. `field === "mention"`: only when `value.item === "comment"` and `value.comment_id` and `value.post_id` are present → `upsert` with `kind: "mention"`; anything else → `ignored`.

`parseInstagramChange`: `comments` → `upsert`, `kind: "comment"`, `externalId = value.id ?? value.comment_id`, `postExternalId = value.media.id`, `parentExternalId = value.parent_id ?? null`, `authorExternalId = value.from?.id`, `authorUsername = value.from?.username`, `authorName = null`, `message = value.text ?? null`, `commentedAt = entryTime`, `isAd = Boolean(value.media?.ad_id)`. `live_comments` → the same with `kind: "live"`. `mentions` → `mention_ref`. Missing comment ID or media ID → `ignored`.

### 5.3 Ingestion

```ts
export interface CommentIngestResult { upserts: number; statusChanges: number; ignored: number; unknownAccounts: string[] }

/** Walk every entry and change of a stored Meta webhook payload. Runs inside the caller's transaction. Safe to run twice. */
export function ingestCommentChanges(db: DbExecutor, payload: unknown): Promise<CommentIngestResult>;

/** Apply one parsed change. Used by the webhook path, the polling job and the back-fill. */
export function applyCommentChange(db: DbExecutor, account: ChannelAccount, change: ParsedCommentChange,
  opts?: { source: "webhook" | "poll" | "backfill"; now?: Date }): Promise<{ commentId: string | null; created: boolean }>;
```

`ingestCommentChanges`: for each `entry`, find the account with `channelAccountByExternalId(db, payload.object === "instagram" ? "instagram" : "messenger", entry.id)`. Not found or `isActive === false` → push `entry.id` to `unknownAccounts` and skip (the caller parks or finishes the event the way spec 02 does for unknown accounts). For each `changes[]` item whose `field` is in the lists above, parse and call `applyCommentChange`. Entries that carry `messaging` instead of `changes` are spec 02's; skip them.

**Hook into spec 02's processor.** In the function in `webhooks-meta.ts` that processes one stored event inside a transaction (and in the worker function that retries stored `source = 'meta'` events for that webhook), add: `if (isCommentEvent(payload)) await ingestCommentChanges(tx, payload);` next to the messaging ingestion, so a payload that mixes both is handled once and the event is marked processed only when both succeed.

`applyCommentChange` for `upsert` (all inside the transaction):

1. `select pg_advisory_xact_lock(hashtext('social-comment:' || network || ':' || externalId))`.
2. Upsert the post: `INSERT INTO social_post_ref (account_id, network, external_id, permalink_url, is_ad) … ON CONFLICT (network, external_id) DO UPDATE SET permalink_url = coalesce(social_post_ref.permalink_url, excluded.permalink_url) RETURNING id`. A new row has `fetched_at NULL`; the worker fills it (6.1).
3. `fromBusiness = authorExternalId === account.externalId || authorExternalId === account.pageId`.
4. **Adopt a suite reply (rule R9):** if `fromBusiness`, look for a row with the same `post_id`, `external_id IS NULL`, `send_status IN ('queued','unknown')`, `message = change.message`, `created_at > now() - interval '15 minutes'`, oldest first. If found, set its `external_id`, `send_status = 'sent'`, `commented_at`, and stop.
5. Find the root. `parentExternalId === null` → this row is a root. Otherwise look up the parent by `(network, parentExternalId)`: root is `parent.root_id ?? parent.id`. Parent unknown → insert a **placeholder root**: `external_id = parentExternalId`, `message = NULL`, `needs_fetch = true`, `commented_at = change.commentedAt`, `work_state = 'open'`, `kind = change.kind`; use it as root.
6. `INSERT INTO social_comment (…) ON CONFLICT (network, external_id) DO UPDATE SET message = excluded.message, attachment_url = coalesce(excluded.attachment_url, social_comment.attachment_url), author_name = coalesce(excluded.author_name, social_comment.author_name), author_username = coalesce(excluded.author_username, social_comment.author_username), author_external_id = coalesce(excluded.author_external_id, social_comment.author_external_id), needs_fetch = false, edited_at = CASE WHEN <edited> THEN now() ELSE social_comment.edited_at END, payload = excluded.payload RETURNING id, (xmax = 0) AS created`. A row whose `status = 'deleted'` is **not** brought back: add `WHERE social_comment.status <> 'deleted'` to the `DO UPDATE`.
7. Thread state on the root row, only when `created` is true:
   - Customer comment (`fromBusiness = false`), `source` `webhook` or `poll`: `work_state = 'open'`, `done_at = NULL`, `done_by_user_id = NULL`, `unread_count = unread_count + 1`, `last_activity_at = greatest(last_activity_at, commentedAt)`, `last_preview = left(message, 140)` (or `'Photo or video'` when the message is empty).
   - Customer comment, `source = 'backfill'`: same, but when `commentedAt` is more than 48 hours old set `work_state = 'done'` and do not touch `unread_count` (rule R21).
   - Business comment: `last_activity_at` and `last_preview` only (preview prefixed `You: `). If the row is itself a root (the business commented on its own post), `work_state = 'done'`.
   - `kind = 'live'`: `work_state = 'done'`, no unread (rule R16).
8. When an edit changed the text of a customer comment (`created = false`, `edited`, text differs), set the root's `last_activity_at = now()` and `last_preview` to the new text; do not change `work_state` or `unread_count`.
9. Publish: `publishInboxEvent(db, { event: created ? "comment.created" : "comment.updated", id: rootId, phoneNumberId: account.id, assigneeId: root.assignee_id, direction: fromBusiness ? "out" : "in" })`.

For `status`: find the row by `(network, externalId)`; unknown → nothing (count as ignored). `deleted` → `status = 'deleted'`, `status_changed_at = at`; if it is a root, `work_state = 'done'`, `unread_count = 0`. `hidden` → `status = 'hidden'`, and `hidden_source = 'outside'` **unless** the row already has `hidden_source = 'suite'` with `status = 'hidden'`. `visible` → `status = 'visible'`, `hidden_source = NULL`. Never change a row that is already `deleted`. Publish `comment.updated`.

For `mention_ref` (Instagram): if `commentExternalId` is null (caption mention) → ignore in Phase A. Otherwise upsert the post ref for `mediaExternalId` and insert a root row `kind = 'mention'`, `external_id = commentExternalId`, `needs_fetch = true`, `work_state = 'open'`, `unread_count = 1`, `last_preview = 'Mentioned you in a comment'`. The worker fills the text with fact I5.

### 5.4 Graph calls (`comments.ts`)

Every function takes `(cfg: MetaConfig, account: ChannelAccount, …)`, gets the token with `pageAccessToken(cfg, account.pageId!)`, and calls the exported `graph()` with that token. They throw `MetaApiError` unchanged.

```ts
export interface RemoteComment { externalId: string; parentExternalId: string | null; authorExternalId: string | null;
  authorName: string | null; authorUsername: string | null; message: string | null; commentedAt: Date;
  hidden: boolean | null; likeCount: number | null; likedByBusiness: boolean | null; attachmentUrl: string | null }
export interface RemotePost { externalId: string; message: string | null; permalinkUrl: string | null; pictureUrl: string | null;
  mediaType: string | null; postedAt: Date | null; commentCount: number | null; updatedAt: Date | null }

export function fetchPost(cfg, account, postExternalId: string): Promise<RemotePost>;
export function listRecentPosts(cfg, account, opts: { since: Date; limit: number }): Promise<RemotePost[]>;
export function listPostComments(cfg, account, postExternalId: string, opts: { maxPages: number }): Promise<RemoteComment[]>;
export function fetchComment(cfg, account, commentExternalId: string, kind: "comment" | "mention"): Promise<RemoteComment & { replies: RemoteComment[] }>;
export function publishReply(cfg, account, toCommentExternalId: string, message: string): Promise<string>; // new comment id
export function setCommentHidden(cfg, account, commentExternalId: string, hidden: boolean): Promise<void>;
export function deleteRemoteComment(cfg, account, commentExternalId: string): Promise<void>;
export function setCommentLiked(cfg, account, commentExternalId: string, liked: boolean): Promise<void>; // facebook only
export function sendPrivateReply(cfg, account, commentExternalId: string, text: string): Promise<{ recipientId: string | null; messageId: string | null }>;
export function ensurePageSubscribed(cfg, account): Promise<{ changed: boolean }>;
```

Exact requests (`network` is `facebook` when `account.kind === "messenger"`, `instagram` when `"instagram"`):

| Function | Facebook | Instagram |
|---|---|---|
| `fetchPost` | `GET {postId}?fields=id,message,story,created_time,updated_time,permalink_url,full_picture,status_type` (F15). `message = message ?? story` | `GET {mediaId}?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count` (I13). `pictureUrl = media_type === "VIDEO" ? thumbnail_url : (media_url ?? thumbnail_url)` |
| `listRecentPosts` | `GET {pageId}/feed?fields=id,message,created_time,updated_time,permalink_url,full_picture&limit={limit}&since={unix}` (F16) | `GET {igId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit={limit}&since={unix}` (I14) |
| `listPostComments` | `GET {postId}/comments?filter=stream&order=reverse_chronological&limit=100&fields=id,message,created_time,from,parent,is_hidden,like_count,user_likes,attachment` then follow `paging.next`, at most `maxPages` (F8, F11) | `GET {mediaId}/comments?limit=50&fields=id,text,timestamp,username,from,hidden,like_count,parent_id,replies{id,text,timestamp,username,from,hidden,like_count,parent_id}` then `paging.next`, at most `maxPages`; flatten `replies` (I7, I8) |
| `fetchComment` | `GET {commentId}?fields=id,message,created_time,from,parent,is_hidden,like_count,user_likes,attachment,comments.limit(100){id,message,created_time,from,parent,is_hidden,like_count,user_likes}` | comment: `GET {commentId}?fields=id,text,timestamp,username,from,hidden,like_count,parent_id,replies{…same…}`. mention: `GET {igId}?fields=mentioned_comment.comment_id({commentId}){id,text,timestamp,like_count,media{id,permalink}}` (I5) |
| `publishReply` | `POST {commentId}/comments` body `{message}` (F9) | `POST {commentId}/replies` body `{message}` (I9) |
| `setCommentHidden` | `POST {commentId}` body `{is_hidden: hidden}` (F12) | `POST {commentId}?hide={true|false}` no body (I10) |
| `deleteRemoteComment` | `DELETE {commentId}` (F13) | `DELETE {commentId}` (I11) |
| `setCommentLiked` | `POST` or `DELETE {commentId}/likes` (F14) | throws `Error("not supported")` |
| `sendPrivateReply` | `POST {pageId}/messages` body `{recipient: {comment_id}, message: {text}}` (F17) | `POST {igId}/messages` same body (I15) |
| `ensurePageSubscribed` | `GET {pageId}/subscribed_apps`; if this app's `subscribed_fields` lacks `feed` or `mention`, `POST {pageId}/subscribed_apps` with `subscribed_fields` = the existing list plus `feed,mention` (F7). Never send a shorter list than the one read | no call; return `{changed: false}` |

Error classes (one function, used by routes and jobs):

```ts
export type MetaProblem = "config" | "temporary" | "gone" | "refused" | "unknown";
export function classifyMetaError(err: unknown): MetaProblem;
```

`unknown` when `err.delivery === "unknown"`. `config` for codes `190`, `10`, `200`, `299`, `283`. `temporary` for `4`, `17`, `32`, `613`, `80001`, `80002`, `80006`, `80007`, HTTP 429, HTTP 5xx with a structured error. `gone` for code `100` when the message matches `/does not exist|cannot be loaded|unsupported get request/i` (L4). Everything else `refused`.

### 5.5 Actions (`comments.ts`)

```ts
export class CommentActionError extends Error {
  constructor(public readonly code: "not_found" | "not_allowed" | "already_sent" | "too_old" | "not_configured",
              message: string) { super(message); }
}
export function replyToComment(db: DbClient, cfg: MetaConfig | null, input: { commentId: string; userId: string; message: string }): Promise<SocialCommentRow>;
export function hideComment(db, cfg, input: { commentId: string; userId: string; hidden: boolean }): Promise<SocialCommentRow>;
export function deleteComment(db, cfg, input: { commentId: string; userId: string }): Promise<SocialCommentRow>;
export function likeComment(db, cfg, input: { commentId: string; userId: string; liked: boolean }): Promise<SocialCommentRow>;
export function privateReplyToComment(db, cfg, input: { commentId: string; userId: string; text: string }): Promise<SocialCommentRow>;
```

`cfg === null` → throw `CommentActionError("not_configured", "Facebook and Instagram are not set up on this server")`.

**`replyToComment`** (foundation rule 9):
1. Load the target; must exist, `status = 'visible'`, `kind = 'comment'`, `external_id IS NOT NULL`. Otherwise `not_allowed` with the text from rule R5, R6 or R16.
2. Insert the reply row first: `external_id NULL`, `parent_external_id = target.external_id`, `root_id = target.root_id ?? target.id`, `from_business = true`, `sent_by_user_id`, `message`, `send_status = 'queued'`, `commented_at = now`.
3. `publishReply`. Success → in one transaction take the lock from 5.3 step 1 for the new ID; `DELETE FROM social_comment WHERE network = $1 AND external_id = $2 AND id <> $ours AND sent_by_user_id IS NULL` (a webhook copy that won the race); set ours `external_id`, `send_status = 'sent'`; set the root `work_state = 'done'`, `done_by_user_id`, `done_at = now`, `unread_count = 0`, `last_activity_at = now`, `last_preview = 'You: ' || left(message, 135)`.
4. `MetaApiError`: `classifyMetaError` → `unknown` sets `send_status = 'unknown'`; anything else `send_status = 'failed'`; both store `error_code`, `error_message`. `config` also calls `raiseCommentsConfigAlert` (5.6). Return the row; the route answers 502 with it.
5. Publish `comment.updated` for the root.

**`hideComment` / `deleteComment` / `likeComment`** are harmless twice, so no queued row: check the target (rules R6, R7, R8), call Meta, then update the row (`status`, `hidden_source = 'suite'` or `NULL`, `status_changed_at`; `liked_by_business`). `deleteComment` on `gone` counts as success. Deleting a root sets `work_state = 'done'`, `unread_count = 0`. On any other error nothing changes locally and the error is rethrown for the route to map.

**`privateReplyToComment`:**
1. Target must be a customer comment (`from_business = false`), `external_id` set, `status <> 'deleted'`, `kind IN ('comment','live')`. `commented_at` older than 7 days → `too_old`.
2. Claim it: `UPDATE social_comment SET private_reply_status = 'queued', private_reply_body = $text, private_reply_by_user_id = $user, private_reply_at = now(), private_reply_error = NULL, private_reply_error_code = NULL WHERE id = $id AND (private_reply_status IS NULL OR private_reply_status IN ('failed','unknown')) RETURNING id`. No row → `already_sent`.
3. `sendPrivateReply`. On error: `unknown` → `private_reply_status = 'unknown'`; else `'failed'`; store code and message; `config` raises the alert. Return the row (route answers 502).
4. On success, in one transaction:
   - `identityExternal = recipientId ?? target.author_external_id`. If null → set `private_reply_status = 'sent'`, `private_reply_message_id`, leave `conversation_id` NULL, done (rule R19).
   - `findOrCreateCustomerByIdentity(tx, { channel: account.kind === "instagram" ? "instagram" : "messenger", accountExternalId: account.externalId!, externalId: identityExternal, displayName: target.author_name, username: target.author_username })`.
   - `findOrOpenConversation(tx, customerId, account.id)`. If it returned `created: true`, `UPDATE inbox_conversation SET channel = $channel WHERE id = $id` (harmless if spec 02 already sets it).
   - `INSERT INTO inbox_message (conversation_id, direction, type, body, wa_message_id, status, sender_user_id, channel, payload, created_at) VALUES (…, 'out', 'text', $text, $messageId, 'sent', $user, $channel, $payload, now()) ON CONFLICT (wa_message_id) DO NOTHING` where `payload = {"comment_ref": {"thread_id": <root id>, "comment_id": <comment id>, "network": <network>, "excerpt": <first 140 chars of the comment>}}`. The conflict clause covers the echo webhook spec 02 may store for the same `mid` first; in that case `UPDATE inbox_message SET payload = coalesce(payload,'{}') || $payload, sender_user_id = $user WHERE wa_message_id = $messageId`.
   - `touchConversation(tx, conversationId, { preview: text })`. **Do not pass `inboundWa`**: the reply window opens only when the customer answers (F17, I15), which spec 02's ingestion records.
   - Set the comment: `private_reply_status = 'sent'`, `private_reply_message_id`, `conversation_id`.
   - `publishInboxEvent(tx, signalFor("message.created", conversation, messageId))` and `comment.updated` for the root.
5. A private reply does **not** change the thread's `work_state`; the staff member decides (rule R20).

### 5.6 Owner alert

```ts
/** One alert per account per 24 hours, through outbox_event, like alertUnknownNumbers. */
export function raiseCommentsConfigAlert(db: DbExecutor, account: ChannelAccount, err: { code: string | null; message: string }): Promise<void>;
```

Inserts `outbox_event` `{eventType: "social.comments_config", payload: {account_id, label, code, message}}` unless one exists for that `account_id` in the last 24 hours. Also writes `last_error_code`, `last_error`, `last_error_at` on `social_comment_account`.

### 5.7 Routes: `apps/api/src/routes/social-comments.ts`

All under `/v1/social/comments`. `r.use("*", requireAuth())`, then a middleware that 403s without `social.comments` and loads `const viewer = await loadViewer(db, auth.userId, auth.capabilities)`. **Who sees what:** a person with `social.comments` sees comments on the channel accounts they may use: every query adds `canUseNumber(viewer, account_id)` as SQL (`viewer.numberIds === "all" ? true : account_id = ANY(numberIds)`). This reuses the existing per-line access table; it is not a second rule. A thread on an account the viewer cannot use answers 404.

Responses use `{ data: … }`. Errors use `BusinessError(code, message, status)`.

```ts
interface ThreadSummary { id: string; network: SocialNetwork; account_id: string; account_label: string;
  kind: "comment" | "live" | "mention"; author_name: string | null; author_username: string | null;
  preview: string | null; status: "visible" | "hidden" | "deleted"; hidden_source: "suite" | "outside" | null;
  work_state: "open" | "done"; unread: number; assignee_id: string | null; assignee_name: string | null;
  last_activity_at: string; reply_count: number;
  post: { id: string; message: string | null; picture_url: string | null; permalink_url: string | null; posted_at: string | null; is_ad: boolean } }
interface CommentItem { id: string; external_id: string | null; is_root: boolean; from_business: boolean;
  author_name: string | null; author_username: string | null; sent_by_name: string | null;
  message: string | null; attachment_url: string | null; status: "visible" | "hidden" | "deleted";
  hidden_source: "suite" | "outside" | null; edited: boolean; send_status: "queued" | "sent" | "failed" | "unknown" | null;
  error_message: string | null; liked_by_business: boolean; like_count: number | null; commented_at: string;
  private_reply: { status: "queued" | "sent" | "failed" | "unknown"; body: string; by_name: string | null; at: string;
                   error: string | null; conversation_id: string | null } | null;
  actions: { reply: boolean; hide: boolean; unhide: boolean; delete: boolean; like: boolean; unlike: boolean; private_reply: boolean } }
```

`actions` is computed by `commentActionsFor(comment, network, caps, now)` in `packages/shared/src/social.ts`, so the screen never guesses. `private_reply.conversation_id` is returned only when the viewer has `inbox.view` and `canSeeConversation` passes for that conversation; otherwise `null`.

| Method and path | Extra permission | Request | Response and behaviour | Audit |
|---|---|---|---|---|
| `GET /accounts` | — | — | `{data: [{id, label, network, comments_ready: boolean, backfilled_at, last_error: string | null}]}` for accounts of kind `messenger` and `instagram` the viewer may use. `comments_ready` = a `social_comment_account` row exists with `backfilled_at` set | — |
| `GET /unread` | — | — | `{data: {threads: number}}` = roots with `work_state = 'open'` and `unread_count > 0` | — |
| `GET /threads` | — | query: `state` (`open` default, `done`, `all`), `view` (`all` default, `mine`, `unassigned`), `network`, `account` (uuid), `kind` (`comment` default, `mention`, `live`, `all`), `hidden` (`1` = only roots with `status='hidden'`), `q` (matches author name, username or any comment text in the thread, `ILIKE`, escaped like `inbox.ts`), `before` (ISO), `limit` (1 to 100, default 50) | `{data: ThreadSummary[], has_more, next_before}` ordered `last_activity_at DESC`. Placeholder roots (`needs_fetch`) are included with `preview` = the latest reply's text | — |
| `GET /threads/:id` | — | — | `{data: {thread: ThreadSummary, comments: CommentItem[]}}`, root first, replies by `commented_at ASC`, at most 300. If `refreshed_at` is null or older than 60 s and `cfg` is set, first run `refreshThread` (rule R13) with a 5 s budget; a failure is swallowed and reported as `thread.refresh_error: string | null` | — |
| `POST /threads/:id/read` | — | — | sets `unread_count = 0`; `{ok: true}`; publishes `comment.updated` | — |
| `PATCH /threads/:id` | — | `{assignee_id?: uuid | null, work_state?: "open" | "done"}` (strict) | the updated `ThreadSummary`. `assignee_id` must be an active user holding `social.comments`, else 400 "That person can't work on comments". `done` sets `done_by_user_id`, `done_at`, `unread_count = 0` | `social.comment_assign` / `social.comment_state`, entity `social_comment`, before and after |
| `POST /comments/:id/reply` | — | `{message: string 1..1000 trimmed}` | 201 `{data: CommentItem}`; 502 with `{data: CommentItem}` when Meta failed (row is `failed` or `unknown`); 409 for `not_allowed` with the plain reason | `social.comment_reply`, after `{network, post_external_id, to_comment: external_id, message, result: send_status, meta_code}` |
| `POST /comments/:id/hide` and `/unhide` | — | — | `{data: CommentItem}` | `social.comment_hide` / `social.comment_unhide` |
| `DELETE /comments/:id` | — | — | `{data: CommentItem}` (status `deleted`) | `social.comment_delete`, before `{message, author_name}` |
| `POST /comments/:id/like`, `DELETE /comments/:id/like` | — | — | `{data: CommentItem}`; 409 "Likes can't be given from here on Instagram" for Instagram | `social.comment_like` / `social.comment_unlike` |
| `POST /comments/:id/private-reply` | `inbox.reply` | `{text: string 1..1000 trimmed}` | 201 `{data: CommentItem}`; 409 `already_sent` "A private message was already sent for this comment"; 409 `too_old` "This comment is more than 7 days old, so a private message can't be sent"; 502 with the row on a Meta failure | `social.comment_private_reply`, after `{network, comment: external_id, text, result, conversation_id, meta_code}` |
| `POST /sync` | `channels.manage` | `{account_id: uuid}` | 202 `{ok: true}`; clears `backfilled_at`, `backfill_started_at`, `paused_until` on the account row so the worker runs the back-fill again (it only inserts what is missing) | `social.comment_resync` |

All audits use `writeAudit(db, c, {action, entityType: "social_comment", entityId, before, after, notify: false})`.

Meta failures on hide, delete and like are mapped by one helper to `BusinessError` with these messages (`{network}` is "Facebook" or "Instagram"):

| `classifyMetaError` | HTTP | Message |
|---|---|---|
| `config` | 502 | "The suite has lost its permission for this account. Ask the owner to check Channels. Nothing was changed." |
| `temporary` | 503 | "{network} is busy or is limiting how often we can ask. Nothing was changed. Try again in a few minutes." |
| `gone` | 409 | "This comment no longer exists on {network}." (and the row is marked `deleted`) |
| `unknown` | 504 | "No answer from {network}, so we can't tell if it worked. Open the comment again in a minute to see." |
| `refused` | 409 | "{network} refused this: {Meta's message} (code {code})." |

Routes for Phase B rules are in 5.8.

### 5.8 Phase B (optional, build only when asked): comment-to-message rules

A rule says: "when a comment on our posts contains **PRICE**, send the person this private message". It is an unattended send, so foundation rule 7 applies: **the owner switch is the rule's own "Turn on" button, and only a user whose role is `owner` may press it** (`auth.role === "owner"`, checked on the server; `is_active`, `activated_by_user_id`, `activated_at` record it).

- Routes: `GET /rules`, `POST /rules` `{account_id: uuid | null, keyword: 2..40 chars, match: "contains" | "exact", reply_text: 1..1000}`, `PATCH /rules/:id` (same fields; editing `keyword` or `reply_text` sets `is_active = false`), `POST /rules/:id/activate` and `/deactivate` (owner only), `DELETE /rules/:id`. All audited (`social.rule_*`).
- Matching, in `applyCommentChange` after a **newly created**, **webhook-sourced** customer comment of `kind = 'comment'`: lower-case the text; `contains` matches whole words (`\b`), `exact` matches the trimmed text. First active rule by `created_at` wins. The send runs after commit by calling `privateReplyToComment` with `userId = rule.activated_by_user_id`; it obeys the one-per-comment claim, so a retry cannot send twice.
- Guards: never for back-filled or polled comments older than 10 minutes; at most 1 automatic private message per person per account per 24 hours; at most 30 per hour per account; stop the rule (`is_active = false`, owner alert) after 5 `refused` or `config` failures in a row.
- Screen: a "Rules" tab on the Comments page, with a preview of the message and the line "Sent automatically, without anyone checking, to people who comment this word."

### 5.9 Live updates

In `shouldDeliver` in `apps/api/src/inbox/realtime.ts`, before the conversation rule: `if (s.event.startsWith("comment.")) return viewer.capabilities.includes("social.comments") && !!s.phoneNumberId && canUseNumber(viewer, s.phoneNumberId);`. The stream itself still needs `inbox.view` (it is opened by the inbox routes); staff with `social.comments` but without `inbox.view` get no live events, which is why the screen also refetches every 30 seconds (section 7).

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts` (each already runs under `withJobLock`):

| Job name | Every | Function in `apps/worker/src/jobs/social-comments.ts` |
|---|---|---|
| `social_comment_fill` | 15 s | `fillCommentDetails(db, log)` |
| `social_comment_backfill` | 60 s | `backfillComments(db, log)` |
| `social_comment_poll` | 5 min | `pollComments(db, log)` |

All three return `0` at once when `metaConfigFromEnv()` is null. All three skip an account whose `paused_until` is in the future.

**6.1 `fillCommentDetails`.** (a) Up to 10 `social_post_ref` rows with `fetched_at IS NULL AND fetch_attempts < 5`, oldest first: `fetchPost`, write `message`, `permalink_url`, `picture_url`, `media_type`, `posted_at`, `remote_comment_count`, `remote_updated_at`, `fetched_at = now()`. (b) Up to 10 posts that have an open thread and `fetched_at < now() - interval '24 hours'`: the same (refreshes the picture address). (c) Up to 10 `social_comment` rows with `needs_fetch`: `fetchComment`, write the fields, set `needs_fetch = false`; for a Facebook placeholder whose remote `parent` is a comment, re-root (rule R11). On error: `gone` → post: `fetch_error = 'no longer available'`, `fetch_attempts = 5`; comment: `status = 'deleted'`, `needs_fetch = false`. `temporary` → `fetch_attempts + 1` and pause the account 15 minutes. `config` → `raiseCommentsConfigAlert`, pause 60 minutes. Publish `comment.updated` for affected roots.

**6.2 `backfillComments`** (the first load on connect, and after `POST /sync`). For every active account of kind `messenger` or `instagram`: ensure a `social_comment_account` row (`INSERT … ON CONFLICT DO NOTHING`). Where `backfilled_at IS NULL` and (`backfill_started_at IS NULL` or older than 30 minutes): set `backfill_started_at = now()`; call `ensurePageSubscribed`; `listRecentPosts(since = now − 30 days, limit = 50)`; upsert each post ref with its details; for each post `listPostComments(maxPages = 3)` (so at most 300 Facebook or 150 Instagram top-level comments per post) and `applyCommentChange(…, {source: "backfill"})` for each, **oldest first** so parents exist before replies; then `backfilled_at = now()`. One account per tick. A `temporary` error stops the run, sets `paused_until = now() + 60 minutes` and leaves `backfilled_at` NULL so it resumes (upserts make the repeat harmless). Cost: at most 1 + 50 + 150 calls per account.

**6.3 `pollComments`** exists because Instagram comment webhooks need advanced access (I2) and as a safety net for missed Facebook webhooks. For each account with `backfilled_at` set: skip if `last_polled_at` is newer than 5 minutes (Instagram) or 30 minutes (Facebook); `listRecentPosts(since = now − 14 days, limit = 25)` (one call); for each post whose `commentCount` (Instagram) or `updatedAt` (Facebook) differs from the stored `remote_comment_count` / `remote_updated_at`, or which is new: `listPostComments(maxPages = 1)` and `applyCommentChange(…, {source: "poll"})` oldest first; then also mark `hidden` changes from the `hidden` / `is_hidden` values read (`hidden_source = 'outside'` unless already `suite`); store the new count and time; set `last_polled_at`. Quiet account: 288 Instagram calls and 48 Facebook calls a day. Errors as in 6.1.

**Retry rules in one place:** `temporary` → pause the account (15 min for fill, 60 min for back-fill and poll) and try again; `config` → one owner alert per 24 h, pause 60 min, banner on the screen; `gone` → mark and stop; `refused` → store `last_error`, do not retry that item; `unknown` (timeout) → treat as `temporary`. Queued replies (`send_status = 'queued'` older than 2 minutes, which means the API process died mid-send) are set to `unknown` by `fillCommentDetails`; the worker never re-sends a reply or a private message.

## 7. Screens

All new files in `apps/suite/src/features/comments/`:

| File | Holds |
|---|---|
| `CommentsPage.tsx` | The page: filters, list, thread pane. Exports `CommentsPage({ threadId?: string })` |
| `ThreadList.tsx`, `ThreadView.tsx`, `PostCard.tsx`, `CommentRow.tsx`, `ReplyBox.tsx` | Parts |
| `PrivateReplyDialog.tsx`, `ConfirmSendDialog.tsx` | Dialogs, built on `@admin/components/ConfirmModal.js` |
| `comments-api.ts` | `commentsApi` and `commentKeys` (all keys start `["comments", …]`), built on `api()` from `@admin/lib/api.js`, same style as `inbox-api.ts` |
| `comments-logic.ts`, `comments-logic.test.ts` | Pure rules: `statusChip()`, `threadTitle()`, `privateReplyState()`, `shouldAlertForComment()`, `emptyText()` |
| `comments-types.ts` | `ThreadSummary`, `CommentItem` (copy of 5.7) |
| `comments.css` | Styles, prefix `cmt-` |

**Routing** (`apps/suite/src/router.tsx`): routes `/comments` and `/comments/$threadId`, lazy-loaded with `lazyNamed`. Replace the `NeedsInbox` gate with a check that passes when the user holds **any** suite permission: add `export const SUITE_CAPS: Capability[] = ["inbox.view", "social.comments"]` and `export function hasSuiteAccess(caps)` to `apps/suite/src/nav.ts` (if spec 01 already added this, only add `"social.comments"` to the list; if a per-page gate `Needs({ cap })` already exists in `router.tsx`, as spec 09 describes, wrap these two routes in `<RequireAuth><Needs cap="social.comments">` instead and leave `NeedsInbox` alone). Either way the Comments pages must open for a person who has `social.comments` but not `inbox.view`. Each page still checks its own permission. **Menu** (`SuiteShell.tsx`): widen `NavItem["to"]` with `"/comments"`; add `{ to: "/comments", label: "Comments", Icon: MessageCircle, cap: "social.comments" }` under "Conversations" after Inbox; show a badge from `GET /v1/social/comments/unread` (`refetchInterval: 60_000`, `aria-label` "`{n}` comments waiting") using the existing `suite-nav__badge` class.

**Layout.** Desktop: a filter bar, then two columns: thread list (360 px) and the open thread. At 390 px: the list fills the screen; opening a thread replaces it, with a "Back to comments" link at the top.

**Filter bar.** Tabs: "Needs a reply" (`state=open`), "Mine" (`view=mine`), "Done" (`state=done`), "Hidden" (`hidden=1&state=all`), "Mentions" (`kind=mention&state=all`). A select "All accounts" listing the accounts from `GET /accounts` (label plus "Facebook" or "Instagram"). A search box, placeholder "Search by name or words".

**List row.** Network icon; author (`author_name`, else `@author_username`, else "Someone on Facebook" / "Someone on Instagram"); preview (one line); time (`listTime` from `@admin/lib/inbox-logic.js`); a 40 px post thumbnail; unread dot when `unread > 0`; chips from `statusChip()`:

| Condition | Chip text |
|---|---|
| `status = 'hidden'`, `hidden_source = 'suite'` | "Hidden by us" |
| `status = 'hidden'`, `hidden_source = 'outside'` | "Hidden on Facebook" / "Hidden on Instagram" |
| `status = 'deleted'` | "Deleted" |
| `kind = 'mention'` | "Mention" |
| `kind = 'live'` | "Live video" |
| `post.is_ad` | "On an advert" |
| assigned | the assignee's first name |

**Thread pane.** Top: `PostCard`: picture (hidden on load error), the first 280 characters of the post text with "Show more", the date, "On an advert" when `is_ad`, and a link "Open on Facebook" / "Open on Instagram" (`permalink_url`, new tab). If the post has no details yet: "Loading the post…"; if `fetch_error`: "This post is no longer available on Facebook." Below: header actions: an "Assign" select (people from `GET /v1/inbox/staff` when the user has `inbox.view`, else only "Me" and "Nobody"), and a button "Mark as done" / "Reopen". Then the comments: the root, then replies indented once. Each `CommentRow` shows author, time, text (deleted: the text struck through and greyed with "Deleted by the customer or on {network}"; hidden: greyed with the chip), "Edited" when `edited`, a heart with `like_count` when over 0, and for business replies "You" or the staff name (`sent_by_name`), with the send state:

| `send_status` | Shown under the reply |
|---|---|
| `queued` | "Sending…" |
| `failed` | red: "Not posted. {error_message}" and a "Try again" link (opens the reply box with the text) |
| `unknown` | amber: "Not confirmed. It may have been posted. Check on {network} before trying again." |

Buttons on a row, each shown only when `actions.<name>` is true: "Reply", "Message privately", "Hide" / "Show again", "Like" / "Unlike", "Delete". Under a comment with a private reply, a box: "Private message sent by {by_name}, {time}: “{body}”" with "Open the chat" (link to `/inbox/{conversation_id}`) when present, else "The chat will appear in the Inbox when the customer answers."; `failed`: "Private message not sent. {error}" with "Try again"; `unknown`: "Private message not confirmed. Check the Inbox before trying again."

**Reply box** (bottom of the pane, or under the comment being answered): a textarea, placeholder "Write a public reply…", a counter "`{n}` / 1000", and a button "Reply publicly". Quick replies from `GET /v1/inbox/quick-replies` appear under a "Saved replies" button when the user has `inbox.view`. Pressing the button opens `ConfirmSendDialog`.

**Dialogs (exact wording):**

| Dialog | Title | Body | Confirm / busy |
|---|---|---|---|
| Public reply | "Post this reply?" | "Everyone who can see the post will see this reply. It will be posted as **{account label}** on {network}." then the text in a quote box, then "Replying to {author}: “{first 140 chars}”" | "Post reply" / "Posting…" |
| Hide | "Hide this comment?" | "Other people will no longer see it under the post. You can show it again later." (Who exactly still sees a hidden comment differs between Facebook and Instagram and is [unverified]; do not promise more than this on screen.) | "Hide comment" / "Hiding…" |
| Show again | "Show this comment again?" | "Everyone who can see the post will see it again." | "Show comment" / "Showing…" |
| Delete (tone danger) | "Delete this comment?" | "This removes the comment from {network} for everyone. It cannot be undone." then the comment text | "Delete comment" / "Deleting…" |
| Private message | "Send a private message" | A textarea (placeholder "Write your message…", counter to 1000), then: "This goes to {author} as a private message from **{account label}**, with a link to their comment. You can send **one** message per comment. You can write again only after they answer." For Instagram add: "If they don't follow you, it arrives in their message requests." | "Send message" / "Sending…" |

Like and Unlike need no dialog (not public text, undoable). After any action the thread is refetched; success toasts: "Reply posted", "Comment hidden", "Comment shown again", "Comment deleted", "Private message sent". On a 502 from reply or private reply, no error toast from `api()` (`silentError: true`); the row shows the state, plus a toast "That didn't go through normally. Check how it's marked before sending again."

**States.**

| State | What shows |
|---|---|
| Loading | `DataState` loader |
| Load error | `DataState` error with "Try again" |
| No permission | `<div className="empty">`: title "No access", text "Ask the owner if you need to answer comments." |
| No Page or Instagram account connected (`GET /accounts` empty) | title "No Facebook Page or Instagram account yet", text "Connect one in Channels and comments will appear here." with a link to `/channels` for `channels.manage` holders |
| Connected, first load not finished (`comments_ready` false for every account) | banner: "Fetching the last 30 days of comments. This can take a few minutes." |
| `last_error` set on an account | red banner: "Comments from {label} are not updating. {last_error}" and, for `channels.manage`, a button "Try again" (`POST /sync`) |
| Empty "Needs a reply" | title "All caught up", text "No comments are waiting for a reply." |
| Empty other tabs | title "Nothing here", text "No comments match this view." |
| Empty search | title "No matches", text "Try a different name or word." |
| No thread selected (desktop) | "Choose a comment on the left to read and answer it." |

**Refreshing.** List and badge queries: `refetchInterval: 30_000`, and invalidated at once when the live stream (`@admin/lib/inbox-stream.js`) delivers `comment.created` or `comment.updated`. Opening a thread calls `POST /threads/:id/read`.

**Notifications.** In `SuiteShell.tsx`, when the user has `social.comments`, a small hook `useCommentNotifier()` (file `apps/suite/src/features/comments/useCommentNotifier.ts`) listens for `comment.created` with `direction === "in"` and, when `shouldAlertForComment(e, ctx)` is true, plays `playMessageSound()` from `@admin/lib/inbox-notify.js` and shows the same desktop pop-up helper `useInboxNotifier` uses, with title "New comment" and body "Open Comments to read it." (the signal carries no text). `shouldAlertForComment`: false when the saved notify level is `none`; false when level is `assigned` and the thread is assigned to someone else; false when the tab is active and that thread is open; otherwise true.

**Inbox timeline (shared screen, in `apps/admin/src/components/inbox/Timeline.tsx`).** When a message has `payload.comment_ref`, show above the bubble, small and grey: "Private reply to a comment: “{excerpt}”". In the suite it links to `/comments/{thread_id}`. The timeline route in `apps/api/src/routes/inbox.ts` adds `comment_ref: payload->'comment_ref'` to each message item (null otherwise).

## 8. Rules and edge cases

- **R1.** The same webhook processed twice creates no second row and does not raise `unread_count` twice (`created` is false the second time).
- **R2.** A `feed` change whose `item` is not `comment` is ignored and the event is still marked processed.
- **R3.** A webhook for a Page or Instagram ID with no active channel account changes nothing and is reported in `unknownAccounts`.
- **R4.** A comment written by the Page or the Instagram account itself in Meta's own apps is stored with `from_business = true`, never raises unread, never reopens a thread, and shows as "You".
- **R5.** Reply to a deleted comment → 409 "This comment was deleted, so it can't be answered."
- **R6.** Reply to a hidden comment → 409 "Show this comment again before answering it." (Instagram refuses replies to hidden comments, I9; the suite applies the same rule on Facebook for one behaviour.) Hiding the business's own comment is not offered (`actions.hide = false` when `from_business`; I10).
- **R7.** Delete is offered on any comment that is not already deleted. Like is offered only on Facebook, only on visible customer comments.
- **R8.** Hide, show, delete and like are refused locally (409 "Wait until this reply has been posted") for a suite reply whose `external_id` is still NULL.
- **R9.** A suite reply and its own webhook never make two rows: whichever arrives second is merged (5.3 step 4, 5.5 step 3).
- **R10.** A reply whose send timed out is `unknown`, shown amber, and is never re-sent by the system. If the matching business comment later arrives by webhook or poll within 15 minutes, the `unknown` row becomes `sent`.
- **R11.** A reply that arrives before its parent creates a placeholder root. When the worker fetches the placeholder and Meta says it has a parent comment P: find or create P's row as the real root, set `root_id = P.id` on the placeholder and on every row whose `root_id` was the placeholder, copy `work_state`, `unread_count`, `assignee_id`, `last_activity_at`, `last_preview` from the placeholder to P when P is new, and reset them on the placeholder. On Instagram a reply to a reply is attached to the top-level comment by Meta (I9), so this is Facebook-only.
- **R12.** An edit by the customer updates the text, shows "Edited", moves the thread up, and does not reopen a done thread or raise unread.
- **R13.** `refreshThread(db, cfg, rootId)`: `fetchComment` for the root (with replies); upsert what came back through `applyCommentChange` with `source: "poll"`; set `hidden` state from `hidden` / `is_hidden`; `gone` → root `status = 'deleted'`; for Instagram, any stored reply of that root not in the returned `replies` and older than 2 minutes is marked `deleted` (the only way to learn of Instagram deletions, I6); set `refreshed_at = now()`.
- **R14.** `gone` on any action marks the row `deleted` and tells the user "This comment no longer exists on {network}."
- **R15.** A comment on an advert (`is_ad`, or a Facebook comment whose post cannot be fetched because it is an ad post) is shown with "On an advert"; the post card may have no text or picture.
- **R16.** Live-video comments (`kind = 'live'`): stored, listed only under `kind=live`, start as done; actions: only "Message privately" (Meta allows it only during the broadcast, I15; after that the failure shows as "Instagram refused this: …"). Reply, hide and delete are not offered (I9, I10, I11).
- **R17.** Mentions (`kind = 'mention'`): shown in the Mentions tab with the text and a link to the post. Phase A actions: "Mark as done" and assign only.
- **R18.** One private reply per comment. A second attempt after `sent` → 409 `already_sent` without calling Meta. After `failed` or `unknown` a retry is allowed; if Meta refuses it, the row is `failed` with Meta's message.
- **R19.** If Meta's answer has no `recipient_id` and the comment has no author ID, the private reply is `sent` with no conversation; the chat is created by spec 02 when the customer answers.
- **R20.** A private reply does not mark the thread done and does not start the 24-hour window (`last_inbound_wa_at` is untouched).
- **R21.** Back-filled comments older than 48 hours arrive as done with no unread; newer ones as open.
- **R22.** A comment whose text is empty (photo, sticker, GIF) shows "Photo or video" as its text and a link "Open on {network}".
- **R23.** `config` errors raise at most one owner alert per account per 24 hours.
- **R24.** A viewer without access to an account gets 404 for its threads and never receives its live events.
- **R25.** A deactivated account (`isActive = false`) is skipped by all jobs; its stored comments stay readable, every action answers 409 "This account is switched off in Channels."
- **R26.** Text longer than 1,000 characters is rejected by the server (400) and the Send button is disabled on screen.
- **R27.** No Page access token is ever stored, logged or returned; `picture_url` and `attachment_url` are the only Meta URLs kept, and no token is in them.

## 9. Tests

`packages/domain/src/meta/comments.test.ts` (unit, no database):
- `parsePageChange: comment add becomes a top-level upsert when parent_id equals post_id`
- `parsePageChange: comment add with a comment parent becomes a reply`
- `parsePageChange: edited sets edited true`
- `parsePageChange: remove, hide and unhide become status changes`
- `parsePageChange: reaction and post items are ignored`
- `parsePageChange: created_time as a number and as an ISO string both parse`
- `parsePageChange: mention with comment_id becomes kind mention; without is ignored`
- `parseInstagramChange: reads the id from value.id and from value.comment_id`
- `parseInstagramChange: parent_id makes a reply; ad_id sets isAd`
- `parseInstagramChange: live_comments sets kind live`
- `parseInstagramChange: mentions with and without comment_id`
- `isCommentEvent: true for feed and comments, false for a messaging payload`
- `classifyMetaError: 190/200/283 config, 80001/80002/613/429 temporary, 100 "does not exist" gone, timeout unknown, anything else refused`

`packages/shared/src/social.test.ts`:
- `commentActionsFor: hidden comment offers unhide and delete only`
- `commentActionsFor: instagram never offers like`
- `commentActionsFor: live comment offers private reply only`
- `canPrivateReply: false after 7 days, false when already sent, true after failed`

`apps/suite/src/features/comments/comments-logic.test.ts`:
- `statusChip: hidden by us, hidden on Facebook, deleted, mention, advert`
- `shouldAlertForComment: none never alerts; assigned skips other people's threads; open thread in an active tab is silent`

`apps/api/test/integration/social-comments.test.ts` (copy the set-up of `inbox-whatsapp.test.ts`; the Graph stub must answer by URL: `/comments` POST → `{id: "c_out_N"}`, `/replies` → `{id}`, `/messages` → `{recipient_id: "PSID1", message_id: "m_out_N"}`, GET post → details, and a switch to make the next call fail with a given code or time out). Seed a `messenger` and an `instagram` channel account as spec 01's tests do.
- `webhook: a Page comment creates a thread, a post ref and one unread`
- `webhook: the same payload twice changes nothing the second time`
- `webhook: a reply before its parent creates a placeholder root`
- `webhook: remove marks the comment deleted and closes its thread`
- `webhook: hide from outside sets hidden_source outside`
- `webhook: an Instagram comment creates a thread on the instagram account`
- `webhook: a comment by the Page itself raises no unread`
- `webhook: an unknown page id stores the event and creates nothing`
- `list: a user without social.comments gets 403; a user without the account gets an empty list and 404 on the thread`
- `reply: posts to {comment}/comments, stores the id, marks the thread done, writes an audit row`
- `reply: Meta refusal returns 502 with a failed row; nothing is retried`
- `reply: timeout leaves the row unknown; a later webhook for the same text adopts it`
- `reply: webhook arriving before the send result leaves exactly one row`
- `hide, unhide, delete, like: call the right endpoints and update the row`
- `like on instagram returns 409`
- `private reply: sends recipient.comment_id, creates the identity, the conversation and one outbound message, and does not set last_inbound_wa_at`
- `private reply: a second one returns 409 and makes no Graph call`
- `private reply: comment older than 7 days returns 409 and makes no Graph call`
- `private reply: needs inbox.reply`
- `private reply: echo with the same mid already stored does not duplicate the message`

`apps/worker` test `social-comments.test.ts` (same stub): `backfill: loads posts and comments oldest first and marks old ones done`, `backfill: running twice inserts nothing new`, `poll: only fetches comments for posts whose count changed`, `fill: gone post is marked unavailable`, `temporary error pauses the account`.

## 10. Manual check

With a tester Facebook account and a tester Instagram account that hold roles on the Meta app, on a non-production server:

1. Sign in to the suite as the owner. Open **Comments**. Expect the "Fetching the last 30 days" banner, then existing comments.
2. From the tester Facebook account, comment "Do you deliver to Ikeja?" on a Page post. Within a few seconds the thread appears under "Needs a reply" with the post picture; the menu badge shows 1.
3. Reply "Yes, we deliver to Ikeja every day." Check the confirm dialog shows that exact text and the Page name. Confirm. On Facebook, the reply is under the comment. In the suite the thread moves to "Done".
4. As the tester, edit the comment. The suite shows "Edited" and the new text; the thread stays done.
5. Hide the comment. On Facebook, signed in as a third person, it is not visible. Show it again.
6. Like the comment; check the like on Facebook. Unlike.
7. Press "Message privately", send "Hello, here is our delivery price list." The tester receives it in Messenger. In the suite, "Open the chat" leads to an Inbox conversation holding that message with "Private reply to a comment" above it. Try a second private message on the same comment: refused with "A private message was already sent for this comment".
8. As the tester, answer in Messenger. The answer appears in the same Inbox conversation and a normal reply can be sent.
9. As the tester, delete the comment on Facebook. The suite shows it struck through as deleted.
10. Delete a different test comment from the suite; it disappears on Facebook.
11. Repeat 2, 3, 5, 7, 8 and 10 on an Instagram post. Until advanced access, the comment appears within 5 minutes (polling), not seconds.
12. Comment on the post from the Page itself in Facebook's app: it shows as "You" and no badge appears.
13. Phone check at 390 px: list, thread, reply box, each dialog.
14. Sign in as a manager without access to the Page's account: Comments is empty. Sign in as branch staff: no Comments menu line.

## 11. Done when

- [ ] Migration 0073, journal entry and Drizzle schema match; `pnpm typecheck` and `pnpm lint` pass.
- [ ] `social.comments` exists; owner, admin and manager hold it by default.
- [ ] Every test in section 9 exists and passes; no test calls the real Meta API.
- [ ] Facebook comments arrive by webhook; Instagram comments arrive by webhook or by polling within 5 minutes.
- [ ] Reply, hide, show, delete, like and private reply each show a confirmation (except like), call Meta once, and write an audit row.
- [ ] A private reply produces exactly one Inbox message in the right conversation and never opens the 24-hour window by itself.
- [ ] A Meta refusal is readable on screen with Meta's code kept in the row; no route answers 500 for a Meta error.
- [ ] No reply or private message is ever sent twice or re-sent by a job.
- [ ] The Comments menu line, badge, filters, empty states and wording match section 7; the screen works at 390 px.
- [ ] The manual check passes on Facebook and on Instagram.
- [ ] The pull request lists every [unverified] fact checked and what was found.

## 12. Out of scope

Comments on posts the business does not own; visitor posts and reviews on the Page; reactions; replying to mentions and to caption mentions; photo, GIF or sticker replies; editing a reply after posting; turning comments off on a post; story replies and story mentions (spec 02); statistics about comments (spec 11); push notifications to the phone app; Phase B rules unless the owner asks for them.

## 13. Work order

1. Migration 0073, journal, `social.ts` schema, shared types, permission, event names. Build packages; type-check.
2. `parsePageChange`, `parseInstagramChange`, `isCommentEvent`, `classifyMetaError` with their unit tests.
3. `packages/shared/src/social.ts` (`commentActionsFor`, `canPrivateReply`) with tests.
4. `applyCommentChange` and `ingestCommentChanges`; hook into the Meta webhook processor and its retry; webhook integration tests.
5. Graph call functions in 5.4 (verify each [unverified] fact they depend on first).
6. Read routes (`/accounts`, `/unread`, `/threads`, `/threads/:id`, `/read`, `PATCH`) with the access rule; tests.
7. `replyToComment` and its route; tests including the race and timeout cases.
8. Hide, show, delete, like; tests.
9. `privateReplyToComment` and its route; the `comment_ref` field in the timeline route; tests.
10. Worker jobs: fill, back-fill, poll; owner alert and the `outbox.ts` case; tests.
11. `realtime.ts` rule for `comment.*`.
12. Suite screens: api and logic files with tests, then page, list, thread, dialogs; router, menu line, badge, `hasSuiteAccess`.
13. Notifier hook; Timeline caption in `apps/admin`.
14. Manual check; screencast for app review; pull request.
15. (Only if asked) Phase B rules.

## 14. Open questions

| # | Question | Default so work is not blocked |
|---|---|---|
| Q1 | Meta's pages show `v27.0`; the code default is `v23.0`. | Build against whatever `META_GRAPH_VERSION` is set to; note in the pull request which version the manual check ran on |
| Q2 | **Foundation D10 omits rate-limit codes `80001`, `80002`, `80006`** (verified on the rate-limiting page) and permission code `283`. | This spec treats the first three as temporary and `283` as configuration. Suggest adding them to D10 |
| Q3 | **Foundation section 4 says every spec must work end to end with app-role accounts. Instagram `comments` webhooks contradict this: Meta says they need advanced access and a Live app** (I2). | The polling job (6.3) makes Instagram comments work before review, up to 5 minutes late. Keep it after review as a safety net at the same interval |
| Q4 | Foundation section 6 lists two tables for 0073; this spec adds `social_comment_account` (sync state) and `social_comment_rule` (Phase B). | Keep all four in 0073. They are additive and follow the `social_` prefix |
| Q5 | The names of spec 02's stored-event processor and its retry job are not known here. | Hook `ingestCommentChanges` into whatever function processes one stored `/v1/webhooks/meta` event in a transaction; the contract is in 5.3 |
| Q6 | The exact shape of the exported `graph()` token argument (D7) is not fixed in the foundation. | Use what spec 01 exported; this spec only needs "call with this Page token". Also: `graph()`'s network-failure messages say "WhatsApp"; they should say "Meta" once it serves other channels |
| Q7 | Is a commenter's `from.id` on Facebook the same ID Messenger uses (F19)? | Do not depend on it; use `recipient_id` from the private-reply response. If F18 turns out false too, rule R19 applies and the chat links up when the customer answers |
| Q8 | Should staff without `inbox.view` get live comment events? | No for now (the stream is opened by the inbox routes); they get the 30-second refresh |
| Q9 | Should a public reply require a second permission (for example managers only)? | No: `social.comments` covers it, with the confirm dialog and audit row |
| Q10 | How long to keep comments? | Forever, like messages. Erasing a customer's inbox history (`inbox.erase`) does not touch comments, which are public; raise with the owner if that should change |
