# Suite build specs — 09: Publishing posts to Facebook and Instagram

Read `00-foundation.md` first. Size M. Suggested model: Sonnet. Migration `0078_social_posts.sql`. Permission `social.publish`.

---

## 1. Outcome

When this is finished a staff member with the "publish posts" permission can say:

- "I open **Posts** in the suite, write a post, add pictures or a video, and choose whether it goes to our Facebook Page, our Instagram account, or both."
- "Before anything goes out I see exactly what each network will show, and anything a network will refuse is flagged in plain English before I press the button."
- "I can save a draft, post now, or pick a day and time. Scheduled posts sit in a calendar and a list, and I can change or cancel them until they go out."
- "A post never goes out twice. If something fails I am told why and can try again. If we cannot tell whether it went out, the suite says so and asks me to check, instead of guessing."
- "For a post that is already out I can fix the wording on Facebook, or take it down, where Facebook and Instagram allow it."
- "Every post shows who approved it and when."

## 2. Depends on

| Needs | Why |
|---|---|
| Spec 01 merged (`0071`) | `listChannelAccounts`, `pageAccessToken`, the exported `graph()` with a per-call token, rows of kind `messenger` (the Page) and `instagram` in `inbox_phone_number` |
| Spec 03 (optional) | If merged, each published post is registered in `social_post_ref` so its comments attach to it. This spec works without it (section 5.7) |
| Spec 11 (optional) | Reads `social_post_target.external_id` to show figures per post. Nothing to build here for it |
| R2 configured (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) on API **and worker** | Pictures and videos are stored there and handed to Meta by short-lived link (D11) |
| A person, in Meta | (a) The Page is assigned to the system user with **Content** (create content) rights, not only messaging. (b) The Instagram account is a professional account linked to that Page (already true). (c) If the Page demands "Page Publishing Authorization", the Page admin completes it in Facebook, or Instagram publishing is refused |
| A person, in the suite | The owner turns on "Let scheduled posts go out by themselves" (section 7.6) before scheduling can be used |

## 3. Meta reference

How these were checked: each page below was fetched on 19 Nov 2026 through an automated reader that summarises the page. Treat wording as paraphrase and re-read the page before coding (foundation section 4). The pages show `v27.0` as the latest Graph version; this codebase defaults to `v23.0`. Nothing below is known to need a version above v23.0, but that was not tested.

### 3.1 Facebook Page posts

| # | Fact | Status |
|---|---|---|
| F1 | Publish text or a link: `POST /{page-id}/feed` with `message` and/or `link`; one of the two is required. Response `{"id":"<page_post_id>"}` | [verified: https://developers.facebook.com/docs/graph-api/reference/page/feed, 19 Nov 2026] |
| F2 | Needs a **Page access token** from someone who can do the `CREATE_CONTENT` task, with `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` | [verified: https://developers.facebook.com/docs/graph-api/reference/page/feed, 19 Nov 2026] |
| F3 | Native scheduling exists: `published=false` plus `scheduled_publish_time`. The allowed lead time is stated three different ways: "between 10 minutes and 30 days" (Pages API guide), "between 10 minutes and 75 days" (feed reference), "between 10 minutes and 6 months" (videos reference) | [verified: https://developers.facebook.com/docs/pages-api/posts, https://developers.facebook.com/docs/graph-api/reference/page/feed and https://developers.facebook.com/docs/graph-api/reference/page/videos, 19 Nov 2026] |
| F4 | Publish one photo: `POST /{page-id}/photos` with `url` (a picture already on the internet) and `caption`. Response `{"id":"<photo_id>","post_id":"<page_post_id>"}`. Accepted types .jpeg .bmp .png .gif .tiff, at most 10 MB | [verified: https://developers.facebook.com/docs/graph-api/reference/page/photos, 19 Nov 2026] |
| F5 | Several photos in one post: upload each with `POST /{page-id}/photos` and `published=false` (kept about 24 hours), then `POST /{page-id}/feed` with `message` and `attached_media[n]={"media_fbid":"<photo_id>"}` | [verified: https://developers.facebook.com/docs/graph-api/reference/page/photos, 19 Nov 2026] |
| F6 | Publish a video: `POST /{page-id}/videos` accepts `file_url` ("an accessible URL for the video file"), `description`, `title`; response includes `id` (the video ID). The Video API guide uses the host `https://graph-video.facebook.com` and an upload handle; `file_url` on that host is not shown in the guide | [verified: https://developers.facebook.com/docs/graph-api/reference/page/videos and https://developers.facebook.com/docs/video-api/guides/publishing, 19 Nov 2026]; using `file_url` on `graph-video.facebook.com` [unverified] |
| F7 | Page video size, length and format limits | [unverified] (neither page states them) |
| F8 | Edit a post: `POST /{page_post_id}` with the fields to change (`message` is listed); response `{"success":true}`. "An app can only update a Page post if the post was made using that app." | [verified: https://developers.facebook.com/docs/pages-api/posts and https://developers.facebook.com/docs/graph-api/reference/page-post, 19 Nov 2026] |
| F9 | Delete a post: `DELETE /{page_post_id}`, response `{"success":true}`. The Pages API guide states no restriction; the Page Post reference says "Only select developers can perform this operation using the API." The `pages_manage_posts` permission is described as allowing create, edit **and delete** | [verified, sources disagree: https://developers.facebook.com/docs/pages-api/posts, https://developers.facebook.com/docs/graph-api/reference/page-post, https://developers.facebook.com/docs/permissions, 19 Nov 2026] |
| F10 | Reading back: `GET /{page-id}/feed` returns `id`, `message`, `created_time`, `permalink_url`, `is_published`; `limit` at most 100 | [verified: https://developers.facebook.com/docs/graph-api/reference/page/feed, 19 Nov 2026] |
| F11 | Longest allowed Facebook post text | [unverified] (commonly quoted as 63,206 characters; we cap at 5,000) |
| F12 | Reading a Page video's link: `GET /{video-id}?fields=permalink_url,description,created_time` and listing `GET /{page-id}/videos` | [unverified] |

### 3.2 Instagram content publishing

| # | Fact | Status |
|---|---|---|
| I1 | Two steps. `POST /{ig-id}/media` creates a **container** and returns its ID; `POST /{ig-id}/media_publish` with `creation_id` publishes it and returns the media ID | [verified: https://developers.facebook.com/docs/instagram-platform/content-publishing, 19 Nov 2026] |
| I2 | Container parameters: `image_url` or `video_url`, `caption`, `media_type` (`REELS`, `STORIES`, `CAROUSEL`; omitted for a single picture), `is_carousel_item=true` for carousel children, `children` (comma-separated container IDs), `alt_text` (pictures only, up to 1,000 characters), `share_to_feed`, `thumb_offset`, `cover_url` | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media, 19 Nov 2026] |
| I3 | "The media must be on a publicly accessible server when the publish attempt is made." Meta fetches it itself | [verified: https://developers.facebook.com/docs/instagram-platform/content-publishing, 19 Nov 2026] |
| I4 | Meta's fetcher accepts a signed link with a query string (an R2 presigned GET) | [unverified] (section 14, Q1) |
| I5 | Container `status_code`: `EXPIRED` (not published within 24 hours), `ERROR`, `FINISHED` (ready), `IN_PROGRESS`, `PUBLISHED`. Read with `GET /{container-id}?fields=status_code`. Meta's advice: query once a minute for no more than 5 minutes | [verified: https://developers.facebook.com/docs/instagram-platform/content-publishing, 19 Nov 2026] |
| I6 | Rate limit: the guide says 100 API-published posts per account per rolling 24 hours (a carousel counts as one); the same guide's carousel section and the limit reference say 50. Read the real figure at run time: `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` returns `data[0].quota_usage` and `data[0].config.quota_total` / `quota_duration` (86400) | [verified, sources disagree: https://developers.facebook.com/docs/instagram-platform/content-publishing and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit, 19 Nov 2026] |
| I7 | An account may create 400 containers per rolling 24 hours | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media, 19 Nov 2026] |
| I8 | Caption: at most 2,200 characters, 30 hashtags, 20 @mentions. No caption on carousel children | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media, 19 Nov 2026] |
| I9 | Picture: JPEG only, at most 8 MB, aspect ratio between 4:5 and 1.91:1, width 320 to 1440 px (scaled otherwise), sRGB | [verified: same page, 19 Nov 2026] |
| I10 | Reel: MP4 or MOV, H.264 or HEVC, AAC audio, 23 to 60 fps, at most 1920 px wide, 3 seconds to 15 minutes, at most 300 MB, 9:16 recommended | [verified: same page, 19 Nov 2026] |
| I11 | Story: picture JPEG at most 8 MB; video 3 to 60 seconds, at most 100 MB; stories vanish after 24 hours; no caption field is used | [verified: same page, 19 Nov 2026] |
| I12 | Carousel: the guide and the reference say up to 20 items; error subcode 2207028 still says "at least 2 … and no more than 10". Reels cannot be carousel items | [verified, sources disagree: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes, 19 Nov 2026] |
| I13 | Permissions (Facebook Login path, which a Page token uses): `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`; the person behind the token needs `MANAGE` or `CREATE_CONTENT` on the linked Page | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media, 19 Nov 2026] |
| I14 | A caption cannot be edited after publishing: the only update on IG Media is `comment_enabled` | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media, 19 Nov 2026] |
| I15 | Delete: `DELETE /{ig-media-id}` on `graph.facebook.com`, needs `instagram_basic` and **`instagram_manage_contents`** (a permission the blueprint does not list on our token) | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media and https://developers.facebook.com/docs/permissions, 19 Nov 2026] |
| I16 | Reading back: `GET /{ig-media-id}?fields=id,permalink,media_type,media_product_type,timestamp,caption`; listing `GET /{ig-id}/media` | [verified for the fields: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media, 19 Nov 2026]; the `/{ig-id}/media` list edge [unverified] |
| I17 | Not supported through the API: shopping tags, filters. Page Publishing Authorization or missing two-factor on the Page makes requests fail | [verified: https://developers.facebook.com/docs/instagram-platform/content-publishing, 19 Nov 2026] |
| I18 | Whether a system-user Page token works for content publishing to the business's own Instagram account under **standard** access | [unverified] (the blueprint lists `instagram_content_publish` as needing app review) |

### 3.3 Instagram publishing errors we map (all HTTP 400)

[verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes, 19 Nov 2026]

| Code / subcode | Meta's meaning | We treat as | Staff wording |
|---|---|---|---|
| 9 / 2207042 | Daily publishing limit reached | temporary, retry in 1 hour | "Instagram's daily posting limit has been reached. We will try again in an hour." |
| 9007 / 2207027 | Media not ready | temporary, back to waiting | (not shown; we keep waiting) |
| 24 / 2207008 | Container missing or expired | temporary, make a new container | (not shown unless it fails 4 times) |
| -2 / 2207003, -1 / 2207001, -1 / 2207032, -1 / 2207053 | Download timed out / server error / create failed / unknown upload error | temporary | "Instagram had a problem receiving the file. We are trying again." |
| 9004 / 2207052 | Media could not be fetched from the link | refusal | "Instagram could not download the file from our storage. Try again; if it keeps failing tell the technical team." |
| 36000 / 2207004 | Picture too large | refusal | "Instagram refused this: the picture is larger than 8 MB." |
| 36001 / 2207005 | Picture format not supported | refusal | "Instagram refused this: the picture must be a JPEG." |
| 36003 / 2207009 | Aspect ratio not allowed | refusal | "Instagram refused this: the picture is too tall or too wide. Crop it to between 4:5 and 1.91:1." |
| 36004 / 2207010 | Caption too long | refusal | "Instagram refused this: the caption is too long (2,200 characters, 30 hashtags, 20 mentions at most)." |
| 352 / 2207026 | Video format not supported | refusal | "Instagram refused this: the video must be MP4 or MOV." |
| 100 / 2207028 | Carousel size wrong | refusal | "Instagram refused this: an album needs 2 to 10 items." |
| 25 / 2207050 | Account restricted | configuration | "Instagram has restricted the account. Open the Instagram app and follow its instructions." |
| 4 / 2207051 | Flagged as spam | refusal | "Instagram blocked this as suspected spam. Wait a while before posting again." |

Everything else follows D10: `190`, `10`, `200`, `299` are configuration problems; `4`, `17`, `32`, `613`, `80007`, HTTP 429 and 5xx are temporary; the rest are refusals.

### 3.4 App review

| Permission | Why we ask | Status |
|---|---|---|
| `pages_manage_posts` | Create, edit and delete Page posts | [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026] |
| `pages_read_engagement`, `pages_show_list` | Required companions of the above | [verified: same page, 19 Nov 2026] |
| `instagram_basic`, `instagram_content_publish` | Publish to the Instagram account | [verified: same page, 19 Nov 2026] |
| `instagram_manage_contents` (optional) | Only if "take down from Instagram" is wanted | [verified: same page, 19 Nov 2026] |

Whether review is needed at all when the only Page and Instagram account are owned by the business itself is [unverified]; build and test with standard access first (foundation section 4).

**What the screencast must show**, in one take, signed in as a real staff account: (1) the suite sign-in; (2) Channels showing the connected Page and Instagram account by name; (3) Posts → New post, typing a caption, adding a picture, ticking Facebook and Instagram; (4) the "Check before posting" dialog showing both previews; (5) pressing "Post now"; (6) the post's page in the suite turning to "Posted" with both links; (7) opening each link so the reviewer sees the post on facebook.com and instagram.com; (8) editing the Facebook text from the suite and showing the change on Facebook; (9) taking the Facebook post down from the suite. In the submission notes state that the app is used only by the business's own staff through a system user, so there is no Facebook Login screen.

## 4. Data

### 4.1 Migration `packages/db/migrations/0078_social_posts.sql`

```sql
-- Publishing posts to Facebook and Instagram (spec 09). Additive only: two new tables.
-- A post is written once and sent to one row per network in social_post_target.
-- Undo: DROP TABLE "social_post_target"; DROP TABLE "social_post"; (nothing else refers to them).

CREATE TABLE IF NOT EXISTS "social_post" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('text','link','photo','album','video','story')),
  "caption" text DEFAULT '' NOT NULL,
  "link_url" text,
  "media" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft','scheduled','publishing','published','partly_published','failed','needs_check','missed')),
  "scheduled_at" timestamptz,
  "status_note" text,
  "approved_by" uuid REFERENCES "admin_user"("id"),
  "approved_at" timestamptz,
  "approved_hash" text,
  "caption_source" text DEFAULT 'person' NOT NULL,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_status_sched" ON "social_post" ("status","scheduled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_created" ON "social_post" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_post_target" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "social_post"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "network" text NOT NULL CHECK ("network" IN ('facebook','instagram')),
  "caption_override" text,
  "status" text DEFAULT 'pending' NOT NULL CHECK ("status" IN ('pending','publishing','published','failed','unknown','removed')),
  "step" text DEFAULT 'start' NOT NULL CHECK ("step" IN ('start','media','container','wait','publish','done')),
  "container_id" text,
  "child_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "external_id" text,
  "external_kind" text,
  "permalink" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "reconcile_checks" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "wait_started_at" timestamptz,
  "locked_at" timestamptz,
  "error_code" text,
  "error_subcode" text,
  "error_message" text,
  "published_at" timestamptz,
  "removed_at" timestamptz,
  "removed_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_post_target_account" ON "social_post_target" ("post_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_post_target_external" ON "social_post_target" ("network","external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_target_due" ON "social_post_target" ("status","next_attempt_at");
```

Journal entry to append to `packages/db/migrations/meta/_journal.json` (use the next free `idx`; `when` must be larger than the previous entry's):

```json
{ "idx": <next>, "version": "7", "when": <previous when + 100000000>, "tag": "0078_social_posts", "breakpoints": true }
```

Column notes:

- `social_post.media` is an array of `{ "key": string, "mime": string, "bytes": number, "width": number, "height": number, "duration_s": number | null, "alt_text": string | null }`, in display order. `key` is the R2 object key (section 5.2). Never a Meta URL.
- `social_post.scheduled_at` null means "post as soon as approved".
- `social_post.approved_hash` is the fingerprint of exactly what the person confirmed (section 5.3). The worker refuses to publish if the fingerprint no longer matches.
- `social_post.caption_source` is the hook for AI caption help (out of scope): `'person'` today; a later spec may write `'ai'` or `'ai_edited'`. Nothing reads it yet.
- `social_post_target.child_ids`: Facebook unpublished photo IDs for an album, or Instagram child container IDs for a carousel, in order.
- `social_post_target.external_id`: Facebook Page post ID (`<pageid>_<postid>`) or video ID, or Instagram media ID. `external_kind` is `'post'`, `'video'`, `'media'`.
- No foreign key to spec 03's `social_post_ref`: that table may not exist when this migration runs.

### 4.2 Drizzle: new file `packages/db/src/schema/social.ts` (create it, or append if spec 03 already created it)

```ts
export interface SocialPostMedia {
  key: string; mime: string; bytes: number; width: number; height: number;
  duration_s: number | null; alt_text: string | null;
}
export const socialPost = pgTable("social_post", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  caption: text("caption").notNull().default(""),
  linkUrl: text("link_url"),
  media: jsonb("media").$type<SocialPostMedia[]>().notNull().default([]),
  status: text("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  statusNote: text("status_note"),
  approvedBy: uuid("approved_by").references(() => adminUser.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedHash: text("approved_hash"),
  captionSource: text("caption_source").notNull().default("person"),
  createdBy: uuid("created_by").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxStatusSched: index("idx_social_post_status_sched").on(t.status, t.scheduledAt),
  idxCreated: index("idx_social_post_created").on(t.createdAt),
}));
```

`socialPostTarget` mirrors the SQL column for column in the same style (camelCase property, snake_case column name), with `uniqueIndex("uq_social_post_target_account").on(t.postId, t.accountId)`, `uniqueIndex("uq_social_post_target_external").on(t.network, t.externalId).where(sql\`external_id IS NOT NULL\`)` and `index("idx_social_post_target_due").on(t.status, t.nextAttemptAt)`. Export both from `packages/db/src/schema/index.ts`.

### 4.3 Owner switch

Stored in the existing `app_settings` table, key `social_publishing`, value `{ "scheduled_enabled": boolean }`. Missing row means `false`. Add to `packages/db/src/schema/app-setting.ts`:

```ts
export interface SocialPublishingValue { scheduled_enabled: boolean }
export const SOCIAL_PUBLISHING_KEY = "social_publishing";
```

### 4.4 Permission

In `packages/shared/src/permissions.ts` add `"social.publish"` to `CAPABILITIES` (after the inbox block, with the comment `// Create, schedule and publish posts to Facebook and Instagram (suite spec 09).`) and to `ADMIN_CAPS`. Not to `MANAGER_CAPS` or `BRANCH_STAFF_CAPS`. The owner gets it through `[...CAPABILITIES]`. If another spec already added it, do not add it twice.

## 5. Server

### 5.1 Decision: we schedule in our own worker, for both networks

Facebook can hold a scheduled post itself (F3); Instagram's container and publish endpoints have no scheduling parameter (I1, I2). We therefore keep every scheduled post in our own database and a worker job publishes it at its time, on both networks. Reasons:

1. One behaviour for both networks: one calendar, one way to edit and cancel, one audit trail.
2. Facebook's own lead-time limits are documented three contradictory ways (F3); ours is whatever we choose (10 minutes to 90 days).
3. A post that exists only in our database until its minute can be edited or cancelled with no call to Meta, and cannot be published by Meta after we believe we cancelled it.
4. A token or permission problem is seen at publish time and reported, not hidden inside Meta.

Cost: if the worker is down at the scheduled minute the post is late. Rule 8.6 covers it (up to 60 minutes late still goes out; later than that it is marked "Missed" and a person decides).

### 5.2 Files to add or change

| File | Change |
|---|---|
| `packages/shared/src/social-post.ts` (new, exported from the package index) | Types and the pure validator (5.4) |
| `packages/domain/src/meta/publishing.ts` (new, re-exported from `packages/domain/src/index.ts`) | Graph calls and the step engine (5.5, 5.6) |
| `apps/api/src/lib/r2.ts` | Add `presignSocialPut`, `SOCIAL_UPLOAD_TYPES` (below) |
| `apps/api/src/routes/social-posts.ts` (new) | Routes (5.8) |
| `apps/api/src/test-app.ts` | `app.route("/v1/social", socialPostRoutes(db));` beside the inbox routes |
| `apps/worker/src/jobs/social-publish.ts` (new) | Jobs (section 6) |
| `apps/worker/src/jobs/social-media-url.ts` (new) | Signs a GET link for Meta (section 6.4) |
| `apps/worker/package.json` | Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, both pinned to `3.696.0` (the versions `apps/api` uses) |
| `apps/worker/src/inbox-loop.ts` | Two entries in `jobs` |

Upload helper in `r2.ts`:

```ts
export const SOCIAL_UPLOAD_TYPES: Record<string, { kind: "image" | "video"; maxBytes: number }> = {
  "image/jpeg": { kind: "image", maxBytes: 8 * 1024 * 1024 },
  "video/mp4": { kind: "video", maxBytes: 100 * 1024 * 1024 },
  "video/quicktime": { kind: "video", maxBytes: 100 * 1024 * 1024 },
};
/** Presigned PUT under social/posts/YYYY/MM/<uuid>.<ext>, valid 15 minutes. */
export async function presignSocialPut(args: { filename: string; contentType: string; sizeBytes: number }):
  Promise<PresignPutResult & { kind: "image" | "video" }>;
```

Copy `presignInboxPut` exactly, changing the key prefix to `social/posts/`, `expiresIn` to `900`, and the two error texts to `"This file type can't be used in a post. Use a JPEG picture or an MP4 or MOV video."` and `"File is too large (max ${n} MB)"`. Pictures are always JPEG because the browser converts them before upload (section 7.2). 100 MB is our own limit, below Instagram's 300 MB for reels (I10), so that uploads from a phone finish.

Key format, enforced by zod everywhere a key is accepted: `/^social\/posts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|jpeg|mp4|mov)$/`.

### 5.3 The fingerprint (`approved_hash`)

```ts
// packages/domain/src/meta/publishing.ts
export function postFingerprint(post: {
  kind: string; caption: string; linkUrl: string | null; media: SocialPostMedia[]; scheduledAt: Date | null;
}, targets: { accountId: string; network: string; captionOverride: string | null }[]): string;
```

Returns the lower-case hex SHA-256 of `JSON.stringify` of this object, built in exactly this key order: `{ kind, caption, link_url, media: media.map(m => [m.key, m.alt_text ?? ""]), targets: targets.slice().sort(by accountId).map(t => [t.accountId, t.network, t.captionOverride ?? ""]), scheduled_at: scheduledAt ? scheduledAt.toISOString() : null }`. The API returns it as `content_hash` on every post it serves. The confirm dialog sends back the `content_hash` it displayed; the server recomputes and compares. So what the person saw is, provably, what is sent.

### 5.4 Validation (pure, shared by API and screen)

```ts
// packages/shared/src/social-post.ts
export type SocialNetwork = "facebook" | "instagram";
export type SocialPostKind = "text" | "link" | "photo" | "album" | "video" | "story";
export interface PostDraftShape {
  kind: SocialPostKind; caption: string; linkUrl: string | null;
  media: { mime: string; bytes: number; width: number; height: number; durationS: number | null }[];
}
export interface PostProblem { code: string; message: string; blocking: boolean }
export function effectiveCaption(base: string, override: string | null | undefined): string; // override if it is a string (even ""), else base; trimmed
export function countHashtags(text: string): number;  // matches /(^|\s)#[\p{L}\p{N}_]+/gu
export function countMentions(text: string): number;  // matches /(^|\s)@[A-Za-z0-9._]+/g
export function validatePostForNetwork(post: PostDraftShape, network: SocialNetwork, caption: string): PostProblem[];
export function validateSchedule(scheduledAt: Date, now: Date): PostProblem[];
```

Rules for `validatePostForNetwork` (each `code` is tested by name; `blocking` is true unless stated):

| Code | Network | Condition | Message |
|---|---|---|---|
| `empty` | both | kind `text` and caption empty | "Write something to post." |
| `media_count` | both | `photo`, `video`, `story` need exactly 1 file; `album` needs 2 to 10; `text`, `link` need 0 | "A photo post needs one picture.", "An album needs 2 to 10 pictures.", "A video post needs one video.", "A story needs one picture or one video." |
| `media_type` | both | `photo`/`album` item not `image/jpeg`; `video` item not `video/mp4` or `video/quicktime` | "Pictures must be JPEG." / "Videos must be MP4 or MOV." |
| `link_missing` | facebook | kind `link` and `linkUrl` not an `https://` URL | "Add the full web address, starting with https://." |
| `fb_caption_long` | facebook | caption over 5,000 characters | "Facebook text is limited to 5,000 characters here. This has {n}." |
| `fb_story` | facebook | kind `story` | "Stories can only be posted to Instagram from the suite." |
| `fb_photo_big` | facebook | a picture over 10 MB | "Facebook pictures can be at most 10 MB." |
| `ig_needs_media` | instagram | kind `text` or `link` | "Instagram posts need a picture or a video." |
| `ig_caption_long` | instagram | caption over 2,200 characters | "Instagram captions can be at most 2,200 characters. This has {n}." |
| `ig_hashtags` | instagram | more than 30 hashtags | "Instagram allows at most 30 hashtags. This has {n}." |
| `ig_mentions` | instagram | more than 20 mentions | "Instagram allows at most 20 @mentions. This has {n}." |
| `ig_photo_big` | instagram | a picture over 8 MB | "Instagram pictures can be at most 8 MB." |
| `ig_ratio` | instagram | `photo`/`album` item with `width/height` below 0.8 or above 1.91 | "Instagram needs pictures between 4:5 (tall) and 1.91:1 (wide). Crop picture {i}." |
| `ig_narrow` | instagram | picture width under 320 | "Picture {i} is too small for Instagram (at least 320 pixels wide)." |
| `ig_video_length` | instagram | `video` with `durationS` under 3 or over 900; `story` video under 3 or over 60 | "Instagram videos must be between 3 seconds and 15 minutes." / "Story videos must be between 3 and 60 seconds." |
| `ig_link_in_caption` | instagram | caption contains `http://` or `https://`; **not blocking** | "Links in an Instagram caption cannot be tapped." |
| `ig_story_caption` | instagram | kind `story` and caption not empty; **not blocking** | "Instagram stories posted from the suite have no caption. The text will not appear." |

`validateSchedule`: blocking `too_soon` if `scheduledAt < now + 10 minutes` ("Pick a time at least 10 minutes from now."); blocking `too_far` if more than 90 days ahead ("Pick a time within the next 90 days.").

### 5.5 Graph calls (`packages/domain/src/meta/publishing.ts`)

Every function takes `cfg: MetaConfig` and the Page token (`await pageAccessToken(cfg, pageId)`); pass the token through spec 01's per-call token option on `graph()`. If spec 01's option has a different shape than `{ token }`, follow spec 01. All bodies are JSON.

```ts
export async function fbPublishFeed(cfg, pageToken, pageId: string, body: { message?: string; link?: string; attached_media?: { media_fbid: string }[] }): Promise<{ id: string }>;
export async function fbPublishPhoto(cfg, pageToken, pageId: string, body: { url: string; caption?: string; published: boolean }): Promise<{ id: string; post_id?: string }>;
export async function fbPublishVideo(cfg, pageToken, pageId: string, body: { file_url: string; description?: string }): Promise<{ id: string }>; // POST https://graph-video.facebook.com/{version}/{pageId}/videos, 120 s timeout
export async function fbUpdatePostMessage(cfg, pageToken, postId: string, message: string): Promise<void>;       // POST /{postId} { message }
export async function fbDeleteObject(cfg, pageToken, id: string): Promise<void>;                                  // DELETE /{id}
export async function fbRecentPosts(cfg, pageToken, pageId: string): Promise<{ id: string; message?: string; created_time: string; permalink_url?: string }[]>; // GET /{pageId}/feed?fields=id,message,created_time,permalink_url&limit=25
export async function fbPostPermalink(cfg, pageToken, id: string): Promise<string | null>;                       // GET /{id}?fields=permalink_url ; null on any error

export async function igCreateContainer(cfg, pageToken, igId: string, body: Record<string, unknown>): Promise<string>;   // POST /{igId}/media -> id
export async function igContainerStatus(cfg, pageToken, containerId: string): Promise<"EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED">; // GET /{containerId}?fields=status_code
export async function igPublishContainer(cfg, pageToken, igId: string, containerId: string): Promise<string>;           // POST /{igId}/media_publish { creation_id } -> id
export async function igMediaInfo(cfg, pageToken, mediaId: string): Promise<{ permalink: string | null }>;              // GET /{mediaId}?fields=permalink
export async function igRecentMedia(cfg, pageToken, igId: string): Promise<{ id: string; caption?: string; timestamp: string; permalink?: string }[]>; // GET /{igId}/media?fields=id,caption,timestamp,permalink&limit=10
export async function igPublishingQuota(cfg, pageToken, igId: string): Promise<{ used: number; total: number }>;        // GET /{igId}/content_publishing_limit?fields=quota_usage,config
export async function igDeleteMedia(cfg, pageToken, mediaId: string): Promise<void>;                                    // DELETE /{mediaId}

/** D10 sorting, plus section 3.3. `subcode` comes from Meta's error_subcode. */
export function classifyPublishError(err: MetaApiError, subcode: string | null): { kind: "temporary" | "configuration" | "refusal"; staffMessage: string; retryAfterMs: number | null };
```

`MetaApiError` does not carry `error_subcode` today. Add an optional sixth constructor field `subcode: string | null = null` to `MetaApiError` in `packages/domain/src/inbox/meta.ts` and set it in `graph()` from `err?.error_subcode`. This is additive; existing callers are unaffected.

For an Instagram account `igId` is `ChannelAccount.externalId` and the Page for the token is `ChannelAccount.pageId`. For Facebook, the account is the row of kind `messenger`; `pageId` is its `externalId`.

### 5.6 What is sent, per kind

`{url(n)}` is a freshly signed GET link for media item `n`, valid 1 hour (section 6.4). "Risky call" is the single call after which a post exists in public.

| Kind | Facebook | Instagram |
|---|---|---|
| `text` | Risky: `fbPublishFeed({ message })` | not allowed |
| `link` | Risky: `fbPublishFeed({ message, link })` | not allowed |
| `photo` | Risky: `fbPublishPhoto({ url: url(0), caption, published: true })`; `external_id` = `post_id` if present, else `id`; `external_kind` `'post'` | Step `container`: `igCreateContainer({ image_url: url(0), caption, alt_text? })`. Step `wait` until `FINISHED`. Risky: `igPublishContainer` |
| `album` | Step `media`: for each item not yet in `child_ids`, `fbPublishPhoto({ url, published: false })`, append the returned `id` to `child_ids` and save **after each one**. Risky: `fbPublishFeed({ message, attached_media })` | Step `media`: per item `igCreateContainer({ image_url, is_carousel_item: true, alt_text? })`, append to `child_ids`, save after each. Step `container`: `igCreateContainer({ media_type: "CAROUSEL", children: child_ids.join(","), caption })`. `wait`. Risky: publish |
| `video` | Risky: `fbPublishVideo({ file_url: url(0), description: caption })`; `external_kind` `'video'` | Step `container`: `igCreateContainer({ media_type: "REELS", video_url: url(0), caption, share_to_feed: true })`. `wait`. Risky: publish |
| `story` | not allowed | Step `container`: `igCreateContainer({ media_type: "STORIES", image_url or video_url })`. `wait`. Risky: publish |

Before the first Instagram step of a target, call `igPublishingQuota`; if `used >= total`, set `next_attempt_at = now + 1 hour`, `error_message` to the 2207042 wording, leave `status = 'pending'`, do not count an attempt.

### 5.7 After a target is published

In one transaction: set `status='published'`, `step='done'`, `external_id`, `external_kind`, `published_at=now()`, clear the error columns; recompute the post's status (rule 8.9). Then, outside the transaction and never failing the publish: fetch the permalink (`fbPostPermalink` or `igMediaInfo`) and store it; if spec 03 is merged, call its exported upsert for `social_post_ref` with the network, the account's external ID, `external_id`, the permalink, the caption and the publish time (read the function's real name and arguments in `packages/domain/src/meta/comments.ts`; if that file does not exist, skip this and leave the comment `// spec 03: register social_post_ref here`). Statistics need nothing: spec 11 joins on `(network, external_id)`.

### 5.8 Routes: `apps/api/src/routes/social-posts.ts`, mounted at `/v1/social`

`export function socialPostRoutes(db: DbClient)`. Every route: `requireAuth()` then `requireCapability("social.publish")`, except where "owner" is stated (then also `c.get("auth").role === "owner"`, else 403 `forbidden`, "Only the owner can change this"). Errors use `BusinessError`. IDs that are not UUIDs give 404. Audit through `writeAudit(db, c, { action, entityType: "social_post", entityId, after, before, notify })`.

Shapes used below:

```ts
type PostJson = {
  id: string; kind: SocialPostKind; caption: string; link_url: string | null;
  media: (SocialPostMedia & { preview_url: string })[];        // preview_url: presignInboxGet-style signed GET, 10 minutes
  status: string; status_note: string | null; scheduled_at: string | null;
  created_by: { id: string; name: string } | null; approved_by: { id: string; name: string } | null; approved_at: string | null;
  content_hash: string; created_at: string; updated_at: string;
  targets: {
    id: string; account_id: string; account_label: string; network: SocialNetwork;
    caption_override: string | null; status: string; external_id: string | null; permalink: string | null;
    error_message: string | null; error_code: string | null; attempts: number; published_at: string | null; removed_at: string | null;
    problems: PostProblem[];                                    // validatePostForNetwork for this target
  }[];
};
const PostBody = z.object({
  kind: z.enum(["text","link","photo","album","video","story"]),
  caption: z.string().max(5000),
  link_url: z.string().url().max(2000).nullable().optional(),
  media: z.array(z.object({ key: KeyRegex, upload_token: z.string().min(16).max(128), mime: z.string().max(100), bytes: z.number().int().positive(),
    width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000),
    duration_s: z.number().positive().max(3600).nullable(), alt_text: z.string().max(1000).nullable() })).max(10),
  targets: z.array(z.object({ account_id: z.string().uuid(), caption_override: z.string().max(5000).nullable().optional() })).min(1).max(4),
});
```

| Method and path | Does | Response | Audit |
|---|---|---|---|
| `GET /accounts` | Active channel accounts of kind `messenger` (shown as network `facebook`) and `instagram`. For each Instagram account also `quota: { used, total } \| null` (null if the call fails; never an error) | `{ data: { id, label, network, quota }[] , scheduling_enabled: boolean }` | none |
| `POST /uploads` | Body `{ filename, content_type, size_bytes }` → `presignSocialPut`. Returns `upload_token` = HMAC-SHA256 of `social-upload:${userId}:${key}` with `env.JWT_SIGNING_KEY`, base64url (same idea as `uploadToken` in `inbox.ts`) | `{ data: { upload_url, object_key, kind, upload_token } }` | none |
| `GET /posts?status=&from=&to=&limit=&cursor=` | List, newest first by `coalesce(scheduled_at, created_at)`. `status` one of `draft`, `scheduled`, `posted` (= `published`, `partly_published`), `problems` (= `failed`, `needs_check`, `missed`), `all` (default). `from`/`to` are Lagos days (`YYYY-MM-DD`, `to` inclusive) on the same coalesce. `limit` default 30, max 100. Cursor = the last row's ISO timestamp plus id | `{ data: PostJson[], next_cursor: string \| null }` | none |
| `GET /posts/:id` | One post | `{ data: PostJson }` | none |
| `POST /posts` | Create a draft from `PostBody`. Each `upload_token` must verify for this user and key (400 "That upload isn't yours to use" otherwise). Each `account_id` must be an active `messenger` or `instagram` account (400 "Pick a connected Facebook Page or Instagram account"). Blocking validation problems do **not** stop a draft being saved | 201 `{ data: PostJson }` | `social.post_create` |
| `PATCH /posts/:id` | Replace the draft with `PostBody` (media items already on the post need no `upload_token`). Allowed when status is `draft`, `scheduled`, `missed` or `failed` with no target published. A `scheduled` post goes back to `draft` and `approved_*` are cleared (rule 8.3). Otherwise 409 "This post has already gone out. Edit it on the post's page." Targets: delete rows not in the body, insert new ones, keep existing rows' ids | `{ data: PostJson }` | `social.post_update` (before and after captions and target list) |
| `DELETE /posts/:id` | Only when no target has ever reached `publishing`, `published`, `unknown` or `removed`. Deletes the rows. R2 files are left (cleanup is out of scope). Otherwise 409 "This post has gone out, so it is kept for the record." | `{ ok: true }` | `social.post_delete`, notify |
| `POST /posts/:id/approve` | Body `{ when: "now" \| "schedule", scheduled_at?: string (ISO), content_hash: string }`. Checks, in order: status is `draft`, `missed` or `failed`-with-nothing-published (else 409 "This post is not waiting to be approved"); no target has a blocking problem (422 `validation_failed` with the problems); for `schedule`: owner switch on (409 "Scheduling is switched off. Ask the owner to turn it on in Posts settings.") and `validateSchedule` passes; set `scheduled_at` (null for now), recompute the fingerprint and compare with `content_hash` (409 "This post changed while you were looking at it. Check it again." on mismatch). Then set `approved_by`, `approved_at`, `approved_hash`, status `scheduled` or `publishing`, and reset every non-published target to `status='pending', step='start', attempts=0, next_attempt_at=now(), error_*=null, container_id=null, child_ids='[]'` | `{ data: PostJson }` | `social.post_approve`, after `{ hash, when, scheduled_at, targets: [{ network, account_id, caption }] }`, notify |
| `POST /posts/:id/cancel` | `scheduled` → `draft`, clears `approved_*`. Uses `UPDATE … WHERE id=$1 AND status='scheduled' RETURNING`; zero rows → 409 "Too late: this post has already started going out." | `{ data: PostJson }` | `social.post_cancel` |
| `POST /posts/:id/targets/:tid/retry` | Target must be `failed`. Body `{ content_hash }` must equal `approved_hash` (the content is unchanged since approval; else 409 as above). Sets target `pending`, `step='start'`, `attempts=0`, clears errors and `container_id`/`child_ids`; post status `publishing` | `{ data: PostJson }` | `social.post_retry` |
| `POST /posts/:id/targets/:tid/check` | Target must be `unknown`. Runs `reconcileTarget` (section 6.3) once, now | `{ data: PostJson }` | none |
| `POST /posts/:id/targets/:tid/resolve` | Target must be `unknown`. Body `{ outcome: "posted" \| "not_posted", confirm?: true }`. `posted` → `published` with `external_id` null, `status_note` "Marked as posted by a person; not linked to statistics." `not_posted` requires `confirm: true` and sets `pending`, `step` as in retry | `{ data: PostJson }` | `social.post_resolve`, notify |
| `PATCH /posts/:id/targets/:tid/published` | Facebook only, target `published` with `external_kind='post'`. Body `{ message: string (1..5000) }`. Calls `fbUpdatePostMessage`; on success stores the text in `caption_override`. Instagram → 409 "Instagram does not let apps change a caption. Take the post down and post it again." A Meta refusal → 502 with `{ error: { code: "meta_refused", message: <staff wording>, meta_code } }` | `{ data: PostJson }` | `social.published_edit`, before and after text, notify |
| `DELETE /posts/:id/targets/:tid/published` | Target `published` with an `external_id`. Facebook: `fbDeleteObject`. Instagram: `igDeleteMedia`. Success → `status='removed'`, `removed_at`, `removed_by`. Refusal codes `10`, `200`, `299`, `3` → 409 "Facebook did not let the suite take this down. Delete it on the Page itself, then press 'I removed it myself'." (or "Instagram … in the Instagram app …"). Body `{ manual: true }` skips the Meta call and only marks `removed` | `{ data: PostJson }` | `social.published_delete`, notify |
| `GET /settings` | | `{ data: { scheduled_enabled } }` | none |
| `PUT /settings` | **Owner.** Body `{ scheduled_enabled: boolean }`, upsert into `app_settings` as `settingsRoutes` does. Turning it off does not touch posts; rule 8.7 applies when they fall due | `{ data: { scheduled_enabled } }` | `social.settings_update`, entity type `app_settings`, notify |

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts`:

```ts
{ name: "social_publish", everyMs: 30_000, last: 0, run: () => publishDuePosts(db, logger) },
{ name: "social_publish_reconcile", everyMs: 60_000, last: 0, run: () => reconcileUnknownTargets(db, logger) },
```

Both run under `withJobLock` like every other job. Both return at once if `metaConfigFromEnv()` is null.

### 6.1 `publishDuePosts(db, log): Promise<number>`

1. **Promote due posts.** For rows with `status='scheduled' AND scheduled_at <= now()`: if the owner switch is off → `status='missed'`, `status_note='Scheduling was switched off when this post fell due.'`; else if `now() - scheduled_at > 60 minutes` → `status='missed'`, `status_note='The suite was not running at the scheduled time.'`; else `status='publishing'`. Use one `UPDATE … WHERE id=$1 AND status='scheduled'` per row.
2. **Fingerprint check.** For each post just promoted, recompute `postFingerprint`; if it differs from `approved_hash` → `status='failed'`, `status_note='The post changed after it was approved, so it was not sent.'`, log an error. (Cannot happen through the routes; this is the backstop.)
3. **Pick targets:** `status='pending' AND next_attempt_at <= now()` whose post is `publishing`, oldest first, limit 5.
4. For each, run `advanceTarget` until it either finishes, schedules a later attempt, or fails. One target's error never stops the others (try/catch per target).

### 6.2 `advanceTarget` (in `packages/domain/src/meta/publishing.ts`)

```ts
export async function advanceTarget(db: DbClient, cfg: MetaConfig, targetId: string, signUrl: (key: string) => Promise<string>, now?: Date): Promise<"published" | "waiting" | "retry" | "failed" | "unknown">;
```

- **Safe steps** (`start`, `media`, `container`, `wait`) may be repeated without harm: unpublished photos and unpublished containers are invisible and expire by themselves. After each successful Graph call, write its result (`child_ids`, `container_id`, `step`) before making the next call.
- **`wait`** (Instagram): set `wait_started_at` on entering. Read `igContainerStatus`. `FINISHED` → go to publish now. `IN_PROGRESS` → `next_attempt_at = now + 30 s`, return `"waiting"`; give up after 10 minutes for pictures and 30 minutes for videos (measured from `wait_started_at`) with a refusal "Instagram took too long to get this ready. Try again." `ERROR` or `EXPIRED` → clear `container_id` and `child_ids`, `step='start'`, treat as a temporary error.
- **The risky call**, exactly this order (foundation rule 9):
  1. `UPDATE social_post_target SET status='publishing', step='publish', locked_at=now(), attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='pending' RETURNING *`. Zero rows → return `"waiting"` (someone else has it).
  2. Make the one Graph call.
  3. Success → section 5.7.
  4. `MetaApiError` with `delivery === "unknown"` (timeout, dropped connection, bare 5xx) → `status='unknown'`, store the message. **Never retry automatically.** Return `"unknown"`.
  5. `MetaApiError` with `delivery === "not_sent"` → `classifyPublishError`:
     - `temporary`: if `attempts >= 4` → `failed` with the staff message plus " (tried 4 times)". Otherwise `status='pending'`, `step` unchanged, `next_attempt_at = now + (retryAfterMs ?? [60 s, 5 min, 15 min][attempts-1])`.
     - `configuration`: `failed`; insert one `outbox_event` `{ eventType: "social.publish_config_error", payload: { network, account_id, code, message } }` unless one with the same `account_id` was created in the last 24 hours (the `alertUnknownNumbers` pattern).
     - `refusal`: `failed` with the staff message. Keep Meta's code, subcode and message in `error_code`, `error_subcode`, `error_message` (the staff wording goes first, then " — Meta said: …").
- Errors in safe steps go through the same `classifyPublishError` branches, counting `attempts` the same way, with `status` staying `pending` for temporary ones.
- After any change to a target, recompute the post status (rule 8.9).

### 6.3 `reconcileUnknownTargets(db, log)` and `reconcileTarget`

Picks targets with `status='unknown'` and `reconcile_checks < 3`, plus targets stuck in `status='publishing'` with `locked_at < now() - 5 minutes` (a crash between the claim and the result; set these to `unknown` first). For each, increment `reconcile_checks` and:

- **Instagram with a `container_id`:** `igContainerStatus`. `PUBLISHED` → find the media: `igRecentMedia`, keep items with `timestamp >= locked_at - 60 s`; if exactly one, or exactly one whose `caption` equals the sent caption, mark published with that ID (section 5.7). If none can be picked, mark published with `external_id` null and `status_note` "Posted, but we could not link it to statistics." `FINISHED` → not published: `status='pending'`, `step='wait'` (the publish call is safe to make). `IN_PROGRESS` → same. `ERROR`/`EXPIRED` → not published: `status='pending'`, `step='start'`, clear containers.
- **Facebook `text`, `link`, `photo`, `album`:** `fbRecentPosts`; candidates have `created_time >= locked_at - 60 s` and `message` equal to the sent caption after trimming (for an empty caption, any candidate in the time window). Exactly one → mark published with its `id` and `permalink_url`. None or several → leave `unknown`.
- **Facebook `video`:** leave `unknown` (no verified way to look it up, F12).
- When `reconcile_checks` reaches 3 and it is still `unknown`, set the post `status='needs_check'`. Only a person moves it on (routes `check` and `resolve`).

### 6.4 Links for Meta: `apps/worker/src/jobs/social-media-url.ts`

```ts
/** A GET link Meta can fetch for 1 hour. Throws if R2 is not configured. */
export function socialUrlSignerFromEnv(env?: NodeJS.ProcessEnv): ((key: string) => Promise<string>) | null;
```

Build an `S3Client` exactly as `getClient()` in `apps/api/src/lib/r2.ts` does and return `getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 })`. Refuse keys that do not start with `social/posts/`. If it returns null (R2 not configured), `publishDuePosts` fails media targets with "File storage is not set up on the server." Text and link posts still publish.

## 7. Screens

All files in `apps/suite/src/features/posts/`. They use `Frame` from `@admin/lib/app-frame.js`, `Modal`, `ConfirmModal`, `DataState` from `@admin/components/`, `api()` from `@admin/lib/api.js`, `useCan` from `@admin/lib/auth.js`, and `lagosDayKey` / `dayLabel` from `@admin/lib/inbox-logic.js`.

| File | What |
|---|---|
| `posts-api.ts` | Typed calls for section 5.8; query keys `postsKeys = { all: ["posts"], list: (f) => ["posts","list",f], one: (id) => ["posts","one",id], accounts: ["posts","accounts"], settings: ["posts","settings"] }` |
| `posts-logic.ts` + `posts-logic.test.ts` | Pure helpers: `statusLabel`, `statusTone`, `targetLine`, `calendarWeeks`, `lagosInputToIso`, `isoToLagosInput`, `prepareImageSize` |
| `image-prep.ts` | `prepareImageForPost(file: File): Promise<{ blob: Blob; width: number; height: number }>` |
| `PostsPage.tsx` | List and calendar |
| `PostComposer.tsx` | New and edit |
| `PostPreview.tsx` | The per-network preview card |
| `ConfirmPostDialog.tsx` | "Check before posting" |
| `PostDetailPage.tsx` | One post, its results and actions |
| `PostsSettingsDialog.tsx` | The owner switch |
| `posts.css` | Styles; imported by `PostsPage.tsx` |

Router (`apps/suite/src/router.tsx`): routes `/posts` → `PostsPage`, `/posts/new` → `PostComposer`, `/posts/$postId` → `PostDetailPage`, `/posts/$postId/edit` → `PostComposer` with the id. These pages must not require `inbox.view`. If a capability gate other than `NeedsInbox` already exists in `router.tsx`, use it; otherwise add `function Needs({ cap, children })` beside `NeedsInbox` that renders the children when the user has `cap`, else a `suite-note card` with the heading "You don't have access to this part of the suite" and the text "Ask the owner if you need it." and wrap these pages with `<RequireAuth><Needs cap="social.publish">…`.

Menu (`apps/suite/src/SuiteShell.tsx`): widen `NavItem["to"]` to include `"/posts"`; add a heading `"Marketing"` between "Conversations" and "Insight" (reuse it if another spec added it) with `{ to: "/posts", label: "Posts", Icon: CalendarClock, cap: "social.publish" }`.

### 7.1 Posts (`/posts`)

- Title "Posts". Header button "New post" (primary). A gear button "Settings", shown to the owner only.
- Tabs: "Scheduled", "Drafts", "Posted", "Needs attention" (with a count badge when not zero), and a view switch "List | Calendar".
- **List row:** first picture as a 48 px thumbnail (or an icon for text and video), the first 90 characters of the caption (or "No text"), network icons with a state each, the time line, the creator's name. Time line wording: scheduled "Goes out {Tue 24 Nov, 9:00 am}"; posted "Posted {…}"; draft "Edited {…}".
- **Status labels** (`statusLabel`): `draft` "Draft"; `scheduled` "Scheduled"; `publishing` "Going out now…"; `published` "Posted"; `partly_published` "Posted to some, not all"; `failed` "Did not post"; `needs_check` "Please check"; `missed` "Missed its time".
- **Calendar:** a month grid in Lagos time, Monday first; each day lists its posts as chips "9:00 am · Caption start…" coloured by status; clicking a chip opens the post; clicking an empty future day opens the composer with that date and 9:00 am filled in. At 390 px the calendar becomes a list grouped by day.
- States: loading → `DataState`; error → `DataState` retry; empty per tab: "Nothing scheduled" / "Schedule a post and it will show here."; "No drafts" / "Drafts you save show here."; "Nothing posted yet" / "Posts you send from the suite show here."; "Nothing needs attention" / "Posts that fail or need checking show here."
- If `GET /accounts` returns no accounts: a banner "No Facebook Page or Instagram account is connected yet. Connect one in Channels." with a link to `/channels`.
- Refetch the list every 20 seconds while any shown post is `publishing`.

### 7.2 Composer (`/posts/new`, `/posts/$postId/edit`)

Two columns on desktop (form left, previews right), one column at 390 px with previews below the form.

1. **"Where should this go?"** One checkbox per account from `GET /accounts`: "Facebook — {label}", "Instagram — {label}". For Instagram show "{used} of {total} posts used in the last 24 hours" when the quota is known.
2. **"What kind of post?"** Buttons: "Text", "Link", "Photo", "Album", "Video", "Story". Choosing "Text" or "Link" with Instagram ticked shows the `ig_needs_media` problem under the Instagram preview.
3. **"Text"** textarea, label "What do you want to say?", with live counters under it: "{n} characters · {h} hashtags · {m} mentions". A slot `captionTools?: ReactNode` is rendered to the right of the label and is empty today (the hook for AI help).
4. **"Use different text for Instagram"** checkbox (shown when both networks are ticked) reveals a second textarea; it sets `caption_override` on the Instagram target. The same exists as "Use different text for Facebook".
5. **Link** (kind `link`): input "Web address", placeholder "https://www.mrssamuel.com/…".
6. **Media:** a drop area "Add pictures" / "Add a video" with the hint "JPEG pictures up to 8 MB. MP4 or MOV videos up to 100 MB." Each picture runs through `prepareImageForPost`: draw to a canvas, scale down so the width is at most 1440 px, export `image/jpeg` at quality 0.9; if the result is still over 8 MB, lower quality in steps of 0.1 down to 0.5, then show "This picture is too large even after shrinking. Use a smaller one." This turns PNG, WebP and HEIC (where the browser can decode it) into JPEG. Videos are uploaded as they are; read `duration`, `videoWidth`, `videoHeight` from a hidden `<video>` element. Upload: `POST /uploads`, then `PUT` to `upload_url` with the `content-type` header, showing a progress bar per file ("Uploading… 40%"); failure text "Upload failed. Check your connection and try again." Thumbnails can be dragged to reorder and removed with an ✕. Each picture has an "Describe this picture (for people who cannot see it)" field (`alt_text`).
7. **Problems:** under each network's preview list its problems, blocking ones in red with a ✕ icon, non-blocking in amber with a ! icon.
8. **Footer buttons:** "Save draft" (always enabled when something is filled in), "Schedule…" and "Post now…". The last two are disabled while any ticked network has a blocking problem, with the tooltip "Fix the problems shown in red first." "Schedule…" is also disabled when `scheduling_enabled` is false, with the text under it: "Scheduling is switched off. The owner can turn it on in Posts → Settings."
9. Leaving with unsaved changes asks: "Leave without saving? Your changes will be lost." Buttons "Stay" and "Leave".

Both "Schedule…" and "Post now…" first save the draft (`POST` or `PATCH`), then open the confirm dialog with the saved `PostJson`.

### 7.3 Preview (`PostPreview.tsx`)

One card per ticked network, headed "On Facebook" / "On Instagram", showing the account label, the effective caption with line breaks kept, hashtags and mentions coloured, the pictures (Instagram: cropped to the first picture's shape, with dots for an album; Facebook: a grid), the video's first frame with a play mark, and for a link post the web address in a grey box with the note "Facebook adds the link's own picture and title when it posts." Under the card: "This is a close likeness. The apps may crop or wrap slightly differently."

### 7.4 "Check before posting" (`ConfirmPostDialog.tsx`, built on `ConfirmModal`, `maxWidth` 720)

- Title: "Check before posting".
- Body: the sentence "This will be public. Please read it as a customer would." Then, for each target, a block: "**Facebook — {label}**" (or Instagram), the exact caption in a bordered box, the media thumbnails in order, and for a link the address. Then the timing: "Goes out: **now**" or a date and time picker labelled "Day and time (Lagos time)" (min now + 10 minutes, max now + 90 days) and the line "Goes out: **Tue 24 Nov 2026, 9:00 am**".
- A checkbox the person must tick: "I have read this and it is ready to go out."
- Confirm label "Post now" / busy "Posting…", or "Schedule" / "Scheduling…". Cancel label "Go back".
- It sends `content_hash` from the `PostJson` it is showing. On the 409 "changed while you were looking" answer, reload the post and show that message in the dialog.
- After success: toast "Your post is going out now." or "Scheduled for Tue 24 Nov, 9:00 am." and go to the post's page.

### 7.5 Post page (`/posts/$postId`)

- Header: status label, "Created by {name}", and when approved "Approved by {name}, {date time}".
- The caption and media as posted.
- One row per target: network icon, account label, a state, and actions.

| Target state | Shown | Actions |
|---|---|---|
| `pending` or `publishing` | "Going out…" with a spinner (page refetches every 5 s) | none |
| `published` with link | "Posted {time}" and "View on Facebook" / "View on Instagram" | Facebook: "Edit text", "Take down". Instagram: "Take down" |
| `published` without `external_id` | "Posted (not linked to statistics)" | "I removed it myself" |
| `failed` | "Did not post: {error_message}" | "Try again", "Edit post" |
| `unknown` | "We could not tell whether this posted. Please look at the {Page / Instagram account} before doing anything." | "Check again", "It is there", "It is not there — post it again" |
| `removed` | "Taken down {time} by {name}" | none |

- Post-level actions: `scheduled` → "Change" (to the composer; saving returns it to draft, rule 8.3) and "Cancel schedule" (confirm: "Stop this post going out? It will go back to your drafts." Buttons "Keep it scheduled" / "Cancel schedule"); `missed` → "Post now…" and "Pick a new time…" (both open the confirm dialog); `draft` → "Edit", "Delete draft" (confirm: "Delete this draft? This cannot be undone.").
- "Edit text" dialog (Facebook): a textarea with the current text, note "This changes the text on Facebook straight away. Pictures cannot be changed.", buttons "Cancel" / "Save to Facebook".
- "Take down" confirm (`tone="danger"`): "Take this post down from {Facebook / Instagram}? Its comments and likes go with it. This cannot be undone." Buttons "Keep it" / "Take down". On the 409 refusal show the server's message and a button "I removed it myself".
- "It is not there — post it again" confirm (`tone="danger"`): "Only do this after looking at the {Page / account}. If the post is already there, this will post it a second time." Buttons "Go back" / "Post it again".
- No permission (403): the `Needs` note. Not found: "This post no longer exists." with a link "Back to posts".

### 7.6 Settings dialog (owner only)

Title "Posts settings". One switch: "Let scheduled posts go out by themselves", with the explanation "When this is on, a post that someone has checked and scheduled is sent at its time without anyone pressing a button. When it is off, nothing can be scheduled and posts already scheduled will not go out." Buttons "Cancel" / "Save". Non-owners never see the gear.

## 8. Rules and edge cases

1. **Nothing goes out without a person.** A target is only ever set to `pending` by the `approve`, `retry` or `resolve` routes, each called by a signed-in person with `social.publish`, each audited.
2. **What was confirmed is what is sent.** `approve` compares `content_hash`; the worker compares the fingerprint again before the first call. A mismatch never publishes.
3. **Editing a scheduled post un-schedules it.** `PATCH` on a `scheduled` post returns it to `draft` and clears the approval; it must be confirmed again.
4. **Never twice.** The risky call is made only after an atomic claim (`status='pending'` → `'publishing'`). A timeout or crash leaves `unknown`, never `pending`. Only reconciliation that proves "not published" (Instagram container `FINISHED`, `ERROR`, `EXPIRED`) or a person's explicit "post it again" re-arms a target.
5. **Unknown is not failure.** `unknown` targets are never retried by the worker. After 3 checks the post shows "Please check".
6. **Late posts.** A scheduled post found up to 60 minutes late is published; later than that it becomes `missed`.
7. **Owner switch off** at the due time → `missed`, not sent. Turning the switch back on does not send missed posts.
8. **Per-network independence.** One network failing never blocks or undoes the other.
9. **Post status from its targets** (`recomputePostStatus(db, postId)`), ignoring `removed` rows unless all are removed: any `pending`/`publishing` → `publishing`; else any `unknown` → `needs_check`; else all `published`/`removed` → `published`; else all `failed` → `failed`; else `partly_published`.
10. **Instagram quota** exhausted → the target waits an hour at a time, without counting attempts, for at most 24 hours from `approved_at`, then fails with "Instagram's daily posting limit stayed full for a day."
11. **Container expiry.** A container older than 23 hours is discarded and rebuilt (`step='start'`).
12. **Media links** are signed at the moment of each call and never stored. A retry signs a new one.
13. **Time zone.** The picker shows and accepts Lagos time; `lagosInputToIso("2026-11-24T09:00")` returns `2026-11-24T08:00:00.000Z`. All storage is `timestamptz`.
14. **Two people editing.** The `PATCH` body is `PostBody` plus a required `base_updated_at: string` (the `updated_at` of the version the person opened). If the row's `updated_at` differs → 409 "Someone else changed this post. Reload to see their version." Every write to `social_post` sets `updated_at = now()`.
15. **Deleting.** Posts that have gone out are never deleted from our database; "Take down" only marks the target `removed`.
16. **Account switched off.** If a target's channel account is inactive at publish time → `failed` with "This account is switched off in Channels."
17. **Double click.** `approve` uses `UPDATE … WHERE status IN ('draft','missed','failed')`; a second call finds no row and gets 409.
18. **Phone width.** Every screen is usable at 390 px: no horizontal scroll, buttons at least 40 px tall.
19. **No token anywhere.** Page tokens are fetched per run through `pageAccessToken` and never written to a row, a log line, an audit entry or a response.

## 9. Tests

`packages/shared/src/social-post.test.ts`
- `validatePostForNetwork: text post is refused for instagram (ig_needs_media)`
- `validatePostForNetwork: caption of 2201 characters blocks instagram, not facebook`
- `validatePostForNetwork: 31 hashtags blocks instagram`
- `validatePostForNetwork: 21 mentions blocks instagram`
- `validatePostForNetwork: 3:5 picture gives ig_ratio; 4:5 and 1.91:1 pass`
- `validatePostForNetwork: album needs 2 to 10 pictures`
- `validatePostForNetwork: story is refused for facebook`
- `validatePostForNetwork: link in instagram caption is a warning, not blocking`
- `validateSchedule: 9 minutes ahead is too_soon, 91 days is too_far`
- `effectiveCaption: empty-string override wins over base`
- `countHashtags / countMentions: ignore # and @ inside words and emails`

`packages/domain/src/meta/publishing.test.ts` (stub `globalThis.fetch`)
- `postFingerprint: same input gives same hash; changing caption, media order, a target, or the time changes it`
- `classifyPublishError: 2207042 is temporary with a one-hour wait`
- `classifyPublishError: 190 is configuration; 36003 is a refusal with the crop wording`
- `advanceTarget: instagram photo creates container, waits, publishes, stores media id`
- `advanceTarget: instagram IN_PROGRESS returns waiting and schedules 30 s later`
- `advanceTarget: facebook album uploads each photo unpublished then posts once with attached_media`
- `advanceTarget: album resumes after a crash without re-uploading photos already in child_ids`
- `advanceTarget: timeout on the risky call leaves status unknown and makes no second call`
- `advanceTarget: second caller finds the target claimed and makes no Graph call`
- `advanceTarget: temporary error four times ends failed`
- `reconcileTarget: instagram PUBLISHED container marks published; FINISHED re-arms the publish step`
- `reconcileTarget: facebook feed with exactly one matching post marks published; two matches stays unknown`

`apps/api/test/integration/social-posts.test.ts` (copy the set-up of `inbox-whatsapp.test.ts`; `installGraphStub` extended to answer `/feed`, `/photos`, `/media`, `/media_publish`, `/content_publishing_limit`, `?fields=status_code`)
- `403 without social.publish on every route`
- `create draft, list it under Drafts, edit it, delete it`
- `upload token from another user is rejected`
- `approve with a stale content_hash returns 409`
- `approve with a blocking problem returns 422 and lists it`
- `schedule is refused while the owner switch is off`
- `PUT /settings is refused for an admin, allowed for the owner`
- `approve now sets targets pending and writes social.post_approve to the audit log`
- `editing a scheduled post returns it to draft and clears approval`
- `cancel after publishing started returns 409`
- `edit published facebook text calls POST /{post-id} and audits before/after`
- `take down marks removed; a Meta permission refusal returns 409 with the manual wording`
- `responses and audit rows never contain the string "itest-token"`

`apps/worker/src/jobs/social-publish.test.ts`
- `publishDuePosts: promotes a due post, leaves a future one`
- `publishDuePosts: a post 61 minutes late becomes missed`
- `publishDuePosts: owner switch off makes a due post missed`
- `publishDuePosts: fingerprint mismatch fails the post and calls nothing`
- `reconcileUnknownTargets: after 3 checks the post is needs_check`

`apps/suite/src/features/posts/posts-logic.test.ts`
- `lagosInputToIso / isoToLagosInput round-trip`
- `calendarWeeks: November 2026 starts on Monday 26 Oct and has 6 rows`
- `statusLabel covers every status`

## 10. Manual check

With an app-role account, the test Page and the test Instagram account, R2 configured, the worker running:

1. Sign in as the owner. Posts → Settings → turn on scheduled posts.
2. New post → tick Facebook only → "Text" → type "Suite test 1" → "Post now…" → tick the box → "Post now". Within a minute the post page says "Posted" with a link; the link opens the post on Facebook.
3. New post → tick both → "Photo" → add a PNG screenshot. Confirm it uploads as JPEG. Use a very tall picture: Instagram shows the red crop message and "Post now…" is disabled. Replace with a square picture, post. Both links work.
4. New post → both → "Album" with 3 pictures → schedule 12 minutes ahead. It appears in the calendar. Open it, "Change", alter the text, save: it is back in Drafts. Schedule again. At its time it goes out on both.
5. Schedule another, then "Cancel schedule". It never goes out.
6. New post → Instagram → "Video" with a 10-second MP4. It shows "Going out…" for up to a few minutes, then "Posted" as a reel.
7. On a posted Facebook target: "Edit text" → change → check Facebook. Then "Take down" → check Facebook.
8. Stop the worker, schedule a post 11 minutes ahead, start the worker 80 minutes later: the post shows "Missed its time".
9. Sign in as a manager (no `social.publish`): the Posts menu line is absent and `/posts` shows the no-access note.
10. Admin app → Audit log: entries for create, approve, edit, take down, settings, with the right names.
11. Repeat steps 2 and 3 on a phone at 390 px.

## 11. Done when

- [ ] Migration `0078` applies twice without error; journal and Drizzle match it.
- [ ] `social.publish` exists; owner and admin have it; manager and branch staff do not.
- [ ] All routes in 5.8 exist, each checked for permission, each write audited.
- [ ] Text, link, photo, album and video publish to Facebook; photo, album, video (reel) and story publish to Instagram, with app-role accounts.
- [ ] A timeout on the risky call produces "Please check", never a second post (test proves it).
- [ ] Scheduling works only with the owner switch on; late and switched-off cases become "Missed".
- [ ] Every blocking rule in 5.4 is shown in the composer before the buttons enable.
- [ ] The confirm dialog shows the exact text, media and time, and the server rejects a changed post.
- [ ] Edit text and take down work on Facebook; Instagram take-down works or shows the manual wording.
- [ ] All tests in section 9 pass; lint and type-check are clean; the suite builds.
- [ ] Checked at 390 px.
- [ ] The pull request lists every **[unverified]** fact and what was found when it was checked.

## 12. Out of scope

- AI caption help (the hooks are `social_post.caption_source` and the composer's `captionTools` slot).
- Comments and replies on posts (spec 03). Statistics (spec 11). Boosting a post as an advert (spec 12).
- Facebook stories, Facebook reels as a separate format, live video, events, polls, product tags, location tags, collaborators, trial reels, branded-content labels.
- Videos over 100 MB and resumable (chunked) upload to Meta.
- Importing or managing posts made outside the suite.
- Deleting unused files from R2.
- A separate "writer" permission with a second person approving (section 14, Q3).
- WhatsApp Status and WhatsApp channels.

## 13. Work order

1. Permission: add `social.publish` (4.4). Run the shared tests.
2. Migration `0078`, journal entry, Drizzle schema, `SOCIAL_PUBLISHING_KEY`. Build packages; apply the migration to a local database twice.
3. `packages/shared/src/social-post.ts` with its tests.
4. `MetaApiError.subcode` (5.5) and the Graph functions in `packages/domain/src/meta/publishing.ts`, with `classifyPublishError` and `postFingerprint`, and their unit tests.
5. `advanceTarget`, `recomputePostStatus`, `reconcileTarget` with their unit tests (fetch stubbed).
6. `presignSocialPut` in `r2.ts`.
7. Routes file and registration; integration test file.
8. Worker: dependencies, `social-media-url.ts`, `social-publish.ts`, the two job entries, worker tests.
9. Suite: `posts-api.ts`, `posts-logic.ts` + tests, `image-prep.ts`.
10. Suite: `PostsPage.tsx` (list first, then calendar), router entries, `Needs` gate, menu line.
11. Suite: `PostComposer.tsx`, `PostPreview.tsx`, uploads.
12. Suite: `ConfirmPostDialog.tsx`, `PostDetailPage.tsx`, `PostsSettingsDialog.tsx`.
13. Check the **[unverified]** facts I4, F6, F12, I16, I18 against the live test Page and Instagram account; adjust and note differences.
14. Manual check (section 10), desktop and 390 px.
15. Pull request per foundation section 8.

## 14. Open questions

| # | Question | Recommended default so work is not blocked |
|---|---|---|
| Q1 | Will Meta's fetchers accept an R2 presigned link (long query string, host `*.r2.cloudflarestorage.com`) for `image_url`, `video_url`, `url` and `file_url`? (I4) | Build with presigned links as D11 says. Test at work-order step 13. If Meta refuses them, add env `R2_PUBLIC_BASE_URL` for a public custom domain on the bucket limited to the `social/posts/` prefix, and have `socialUrlSignerFromEnv` return `${base}/${key}`; random UUID keys make the links unguessable |
| Q2 | Does taking a post down work for our app? The docs disagree for Facebook (F9), and Instagram needs `instagram_manage_contents` (I15), which may not be on the token | Ship the buttons; on refusal show the manual wording and "I removed it myself" |
| Q3 | Should people who may write posts be different from people who may approve them? D8 defines only `social.publish` | One permission. The approval step is the "Check before posting" dialog, by the same or another person with the permission. A separate `social.draft` permission can be added later without a migration |
| Q4 | Does publishing to the business's own Page and Instagram account need app review, or does standard access cover it? (I18) | Try with standard access. Prepare the review submission from section 3.4 anyway |
| Q5 | Instagram's daily limit: 50 or 100? Carousel limit: 10 or 20? (I6, I12) | Read the limit from `content_publishing_limit` at run time; cap albums at 10 |
| Q6 | Facebook Page video limits are not in the docs we could read (F7) | Our 100 MB cap; show Meta's refusal text if it objects |
| Q7 | **Foundation contradiction:** the foundation makes rule 7 ("no such action runs unattended unless its spec says so and names the owner switch") apply to public posts. Scheduled publishing is unattended at the moment of sending | This spec says so explicitly and names the switch: `app_settings` key `social_publishing.scheduled_enabled`, off by default, owner only (4.3, 7.6) |
| Q8 | **Foundation gap:** D11 says "Meta is given a short-lived public URL", but the worker (which does the publishing) has no URL signer; only `apps/api` does | This spec adds a signer to the worker (6.4) and two dependencies |
| Q9 | **Foundation gap:** the docs now show Graph `v27.0`; the foundation's default is `v23.0` | Keep `META_GRAPH_VERSION` as it is; note in the pull request which version the manual check ran on |

---

## Built differently

Departures made while building this spec on `work/olu/suite-09-posts` (stacked on `work/olu/suite-05-wa-profile`, 19 Nov 2026). Work-order tasks 13 (checking the unverified facts on a live test Page and Instagram account), 14 (the manual check, desktop and 390 px) and 15 (the pull request) were not done: no Meta account, R2 credentials or browser was available. Facts I4, F6, F7, F11, F12, I16 (the list edge) and I18 are therefore still **unchecked**. The migration has **not been executed** and the API and worker database tests have **not been run** (no Docker on the build machine); they were type-checked and traced by hand.

1. **Foreign keys follow ruling 9.2.8.** `social_post.approved_by` and `.created_by`, and `social_post_target.removed_by`, are `ON DELETE SET NULL`. `social_post_target.account_id` is **nullable** and `ON DELETE SET NULL` (the spec has `NOT NULL` with no rule). So removing a person or a channel account never fails on these tables and never deletes the record of a post that went out (rule 15). A target whose account is gone cannot publish: it fails with "This account is switched off in Channels." and shows as "Removed account".
2. **Journal.** `idx` 73, `when` `1786900000000`, as the integration instructions asked (not "previous + 100000000").
3. **The engine works through a small store.** `advanceTarget(db, …)` and `reconcileTarget(db, …)` keep the spec's signatures and call `advanceTargetIn(store, …)` / `reconcileTargetIn(store, …)` with `dbPublishStore(db)`. The unit tests in `packages/domain` use an in-memory store, so the never-twice rules are tested without a database (that package has no database tests). `signUrl` may be `null` (file storage not set up); `advanceTarget` then fails media posts itself with the spec's wording.
4. **The fingerprint is checked before every attempt**, inside `advanceTarget`, not only when a scheduled post is promoted. A "Post now" post is never promoted, so the spec's check in `publishDuePosts` alone would not have covered it. A mismatch sets the post to `failed` with the spec's note and sends nothing.
5. **`approve` compares `content_hash` with the post as it was shown** (its stored `scheduled_at`, which is null for a draft), then stores `approved_hash` computed with the chosen time. The spec's order (set the time, then compare) cannot be met by a browser that only holds the hash the server gave it. The time is in the request and in the audit row. A post that goes back to draft (edit or cancel) has its `scheduled_at` cleared.
6. **Editing the text of a published Facebook post re-stamps `approved_hash`.** The new text is stored in `caption_override` as the spec says, which changes the fingerprint; without the re-stamp "Try again" on the other network would be refused for ever. The person, the old text and the new text are in the `social.published_edit` audit row (written for saved, refused and unconfirmed attempts).
7. **Post status follows rule 9 only.** A post shows "Please check" as soon as a target is `unknown` and nothing else is still going out, not only after the third look (section 6.3's last line). The worker still looks three times, then leaves it to a person.
8. **More checks before anything is sent.** `approve` also refuses (422, code `account_off`) when a target's account is switched off, missing or of the wrong kind, and (503) for "Post now" when Meta is not connected on the server. `retry` and "It is not there — post it again" also need Meta connected. `advanceTarget` re-runs `validatePostForNetwork` and the media key pattern as a backstop, and only touches a target when the post is `publishing` (the claim's SQL checks this too): a draft's targets are `pending` by default and must never move.
9. **Error sorting.** `classifyPublishError(err, subcode, network?)` takes an optional third argument for the wording ("Facebook refused this: …"). Besides table 3.3 and D10: `283` and `no_page_token` are configuration (C2); `80000`–`80009`, `80014`, `1`, `2` and "never connected" are temporary (C3). When Meta sends only the top-level code of a row in 3.3 (for example `36003` with no subcode) the row still applies. Not being able to read the Instagram quota does not block a post unless the error is a configuration one.
10. **Instagram details.** A container that reports `PUBLISHED` before we published it becomes `unknown` (never published again). A carousel child and a single picture send `alt_text` only when one was written. Empty text is left out of the call (`message`, `caption`, `description`) instead of being sent as `""`.
11. **Routes.** HTTP codes the API does not have a name for use `service_unavailable` with `details.reason` (`meta_refused` 502, `unknown` 504), as specs 05 and 10 do; there is no `meta_refused` error code. `PostJson` also carries `external_kind` and `removed_by` on targets, `preview_url` may be `null` (file storage not set up), and `account_id` may be `null`. The list's "scheduled" filter includes posts that are going out now (`publishing`), which otherwise appear under no tab. `problems` are only listed for targets that are `pending` or `failed`. `DELETE /posts/:id` also refuses a post that is `publishing`. A take-down or text edit that gets no answer from Meta is 504 "We could not tell…" and marks nothing. Taking down a target that has no `external_id` needs `{ manual: true }`. `PUT /settings` takes a strict body.
12. **Upload keys** take their extension from the file type (`.jpg`, `.mp4`, `.mov`), not from the file name, so a key always fits the key pattern. `presignSocialPreview` (10-minute link, null when storage is not set up) was added beside `presignSocialPut`.
13. **Owner alert.** `social.publish_config_error` carries `account` as well as `account_id` (so the API's `alertOnce`, which keys on `account`, and the worker's own 24-hour check see the same alert), plus `label`. `alertOnce`'s type list and `outbox.ts` gained the type in the same change (ruling 9.2.10). The API raises it for a configuration refusal while editing text, and for code 190 while taking down; a permission refusal on take-down is expected (Q2) and does not alert.
14. **Screens.** The dialogs are built on `Modal`, not `ConfirmModal`, because `ConfirmModal`'s cancel button always reads "Cancel" and the spec wants "Go back", "Stay", "Keep it" and so on; changing the shared component was avoided while other specs are being built beside this one. The text edit and take-down buttons send their request once (no automatic retry on 502 or 504), like specs 04, 05 and 10. Thumbnails can be dragged to reorder and also have "move earlier / move later" buttons, because dragging does not work on phones. The calendar's "+" on a future day opens `/posts/new?day=YYYY-MM-DD`. The "Needs attention" count is the number of rows in that list (up to "99+"). A `failed` target shows "Try again" only when the post was approved; `missed` posts also get "Edit post". The post page shows the worker's `status_note`. `admin`'s permission editor (`GateEditor.tsx`) gained a label for `social.publish` because its label table must cover every permission.
15. **Menu.** The heading is "Marketing", between "Conversations" and "Insight", as written; `SUITE_PAGES` has `/posts` second, so someone who may only publish lands on Posts.
16. **Spec 03 (comments) is not built.** The hook is the comment `// spec 03: register social_post_ref here` at the end of `advanceTargetIn` in `packages/domain/src/meta/publishing.ts`, where the network, the account's external ID, the post's external ID, the permalink, the caption and the publish time are in scope. A post linked later by reconciliation (`reconcileTargetIn`, two `publishResult` calls) and one marked "It is there" (no external ID) would need the same call or a backfill from `social_post_target`. No comments table was created.
17. **Spec 11 (statistics)** needs nothing built here: it reads `social_post_target (network, external_id, external_kind, published_at, permalink)`, unique on `(network, external_id)` where the ID is known. Targets marked posted by a person, or posted but not matched, have a null `external_id` and cannot be joined.
18. **Extra tests** beyond section 9: fingerprint, quota, refusals, per-network independence, reels, stories and albums in the domain; the signer, the alert wording and "a timeout is never followed by a second call" in the worker; accounts, retry, check and resolve in the API; time wording, the picker's limits and picture sizes in the suite.
