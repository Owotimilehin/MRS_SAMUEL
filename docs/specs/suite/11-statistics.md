# Suite build specs — 11: Statistics (Page, Instagram, posts, WhatsApp)

Read `00-foundation.md` first. Size M. Suggested model: Sonnet. Migration `0079_insights.sql`. Permission `insights.view`.

---

## 1. Outcome

When this is finished a staff member with the "see statistics" permission can say:

- "I open **Insights** and see, for any dates I pick, how many times our Facebook and Instagram content was seen, how many followers we have and how that changed, and how many WhatsApp messages were delivered and what they cost."
- "I can see which posts did best, with a link to each."
- "I can see how each WhatsApp template performed: sent, delivered, read, button taps."
- "When a number is missing the page says why, in plain English, and never shows a made-up zero."
- "Each chart tells me which clock its days follow, because Facebook's day is not our day."
- "I can download the figures as a spreadsheet."
- "Numbers from Meta and numbers from our own inbox are shown side by side and labelled. They are never added together."

Nothing in this spec sends anything to a customer or changes anything public. The one change made at Meta (turning on template statistics) is an owner-only button with a confirmation.

## 2. Depends on

| Needs | Why |
|---|---|
| Spec 01 merged (`0071`) | `listChannelAccounts`, `pageAccessToken`, `graph()` with a per-call token; Page and Instagram rows in `inbox_phone_number` |
| Spec 09 (optional) | Posts made in the suite are marked "Posted from the suite" in the top-posts table by matching `social_post_target.external_id`. Works without it |
| Existing `apps/api/src/routes/inbox-reports.ts` | The suite's own message counts; called from the screen, not changed |
| A person, in Meta | The Page is assigned to the system user with **Insights** (analyse) rights. The token holds `read_insights`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights`, `whatsapp_business_management` (the blueprint says it holds everything; confirm these five by name in work-order step 12) |
| A decision by the owner | Whether to turn on WhatsApp template statistics. It cannot be turned off again and it switches on link tracking in templates (W8) |

## 3. Meta reference

How these were checked: each page was fetched on 19 Nov 2026 through an automated reader that summarises the page. Treat wording as paraphrase and re-read the page before coding. The pages show `v27.0` as latest; this codebase defaults to `v23.0`.

### 3.1 Facebook Page insights

| # | Fact | Status |
|---|---|---|
| P1 | `GET /{page-id}/insights?metric=a,b&period=day&since=YYYY-MM-DD&until=YYYY-MM-DD` with a **Page access token** from someone with the ANALYZE task; permissions `read_insights` and `pages_read_engagement` | [verified: https://developers.facebook.com/docs/graph-api/reference/insights, 19 Nov 2026] |
| P2 | Response: `data[]` of `{ name, period, values: [{ value, end_time }], title, description, id }`. A lifetime post metric has `values: [{ value }]` only | [verified: https://developers.facebook.com/docs/platforminsights/page, 19 Nov 2026] |
| P3 | Page insights are only available for Pages with **100 or more likes**. Most metrics update once every 24 hours. Only the last 2 years are kept. A `since`/`until` query may span at most **90 days** | [verified: https://developers.facebook.com/docs/graph-api/reference/insights, 19 Nov 2026] |
| P4 | Time zone of a "day": the docs do not name one. Their examples have `end_time` at `07:00:00+0000` and say a `since` date gives an `end_time` "at 8:00 GMT", which is midnight US Pacific time (summer and winter). With `since` and `until`, "the first `end_time` is the `since` date plus one day" | [verified as an observation: https://developers.facebook.com/docs/platforminsights/page, 19 Nov 2026]; that the zone is always US Pacific and never the Page's own [unverified] |
| P5 | A missing `read_insights` permission returns an **empty data set with no error**. A wrong metric name returns code `100` "The value must be a valid insights metric". No metric at all returns code `3001` subcode `1504028` | [verified: https://developers.facebook.com/docs/platforminsights/page, 19 Nov 2026] |
| P6 | **Deprecated, do not use** (the API answers "invalid metric"): `page_impressions`, `page_impressions_unique`, `page_impressions_paid`, `page_impressions_viral`, `page_impressions_nonviral` and their `_unique` forms, every `page_posts_impressions*`, `page_fans`, `page_fans_locale`, `page_fans_city`, `page_fans_country`, `page_fan_adds`, `page_fan_adds_unique`, `page_fan_removes`, `page_fan_removes_unique`, `page_engaged_users`, `page_consumptions`, `page_positive_feedback*`, `page_views_login*`, `page_views_logout`, `post_impressions`, `post_impressions_unique`, `post_impressions_paid`, `post_impressions_fan`, `post_impressions_organic`, `post_impressions_viral`, `post_impressions_nonviral` and their `_unique` forms, `post_activity`, `post_activity_unique`. Stated replacements: `page_impressions` → `page_media_view`; `page_impressions_unique` → `page_total_media_view_unique`; `page_fans` → `page_follows`; `post_impressions` → `post_media_view`; `post_impressions_unique` → `post_total_media_view_unique` | [verified: https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics, 19 Nov 2026] |
| P7 | The insights reference says "by June 15, 2026, a number of Page Insights metrics will be deprecated for all API versions" and separately lists `page_video_views_unique`, `post_video_views_unique` and all `*_video_views_10s*` as deprecated | [verified: https://developers.facebook.com/docs/graph-api/reference/insights, 19 Nov 2026] |
| P8 | Page metrics we use, all listed with `period=day` and absent from the deprecated list: `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, `page_views_total`, `page_follows`, `page_daily_follows_unique`, `page_daily_unfollows_unique`, `page_video_views` | [verified: https://developers.facebook.com/docs/graph-api/reference/insights and the deprecated list above, 19 Nov 2026] |
| P9 | `page_follows` with `period=day` is the running total of followers on that day (not the day's change) | [unverified] |
| P10 | Post metrics we use (`period=lifetime`), `GET /{page-post-id}/insights?metric=…`: `post_media_view`, `post_total_media_view_unique`, `post_clicks`, `post_reactions_by_type_total` (value is an object keyed by reaction type), `post_video_views` | [verified: https://developers.facebook.com/docs/graph-api/reference/insights, 19 Nov 2026] |
| P11 | The Page Post object has an `insights` edge "only for Pages". Listing posts: `GET /{page-id}/feed?fields=id,message,created_time,permalink_url,is_published&limit=100` (limit at most 100; about 600 posts a year are returned) | [verified: https://developers.facebook.com/docs/graph-api/reference/page-post and https://developers.facebook.com/docs/graph-api/reference/page/feed, 19 Nov 2026] |
| P12 | `_unique` metrics are approximate; Reels interactions are not included in Page metrics; some metrics may be left out of a response, and asking for fewer per call helps | [verified: https://developers.facebook.com/docs/graph-api/reference/insights, 19 Nov 2026] |

### 3.2 Instagram insights

| # | Fact | Status |
|---|---|---|
| G1 | Account: `GET /{ig-id}/insights` with `metric` (comma list), `period` (`day`, or `lifetime` for demographics), `metric_type` (`time_series` or `total_value`), `breakdown` (only with `total_value`), `since`, `until` (Unix seconds, inclusive; if omitted the last 24 hours). Permissions `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` | [verified: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights, 19 Nov 2026] |
| G2 | Account metrics, all `period=day`, `metric_type=total_value`: `reach` (also `time_series`; breakdowns `media_product_type`, `follow_type`), `views` (breakdown `media_product_type`), `accounts_engaged`, `total_interactions`, `likes`, `comments`, `shares`, `saves` (each: breakdown `media_product_type`), `replies`, `reposts`, `follows_and_unfollows` (breakdown `follow_type`), `profile_links_taps` (breakdown `contact_button_type`) | [verified: same page, 19 Nov 2026] |
| G3 | `impressions` is deprecated for the account (since 21 Apr 2025, replaced by `views`) | [verified: same page, 19 Nov 2026] |
| G4 | Response for `total_value`: `data[]` of `{ name, period, total_value: { value, breakdowns: [{ dimension_keys: [..], results: [{ dimension_values: [..], value }] }] } }`. Asking for a breakdown a metric does not support returns "An unknown error has occurred" | [verified: same page, 19 Nov 2026] |
| G5 | Thresholds: `follows_and_unfollows` and `follower_demographics` are not returned under **100 followers**; `engaged_audience_demographics` not under 100 engagements. Missing data comes back as an **empty data set, not 0**. Data may be delayed up to **48 hours** | [verified: same page, 19 Nov 2026] |
| G6 | Longest allowed span between `since` and `until`; how far back data goes; which time zone a "day" follows; what the `follow_type` values mean for `follows_and_unfollows` (we assume `FOLLOWER` = new follows, `NON_FOLLOWER` = unfollows) | [unverified] (the page states none of these) |
| G7 | Follower count: field `followers_count` (also `media_count`, `username`) on `GET /{ig-id}` with `instagram_basic` | [verified: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user, 19 Nov 2026] |
| G8 | Media: `GET /{ig-media-id}/insights?metric=…`; response `period` is `lifetime`. Metrics by product type — FEED: `reach`, `views`, `likes`, `comments`, `shares`, `saved`, `total_interactions`, `follows`, `profile_visits`; REELS: `reach`, `views`, `likes`, `comments`, `shares`, `saved`, `total_interactions`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`; STORY: `reach`, `views`, `replies`, `shares`, `total_interactions`, `follows`, `profile_visits`, `navigation` | [verified: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights, 19 Nov 2026] |
| G9 | Media `impressions` is deprecated for media created after 2 Jul 2024; `plays` and `video_views` are not listed any more | [verified: same page, 19 Nov 2026] |
| G10 | Media limits: no insights for items inside an album; story metrics are available for **24 hours** only; a story metric with a value under 5 returns error code `10` "Not enough viewers for the media to show insights"; data delayed up to 48 hours; kept up to 2 years | [verified: same page, 19 Nov 2026] |
| G11 | Listing media `GET /{ig-id}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=50` and stories `GET /{ig-id}/stories?fields=id,media_type,permalink,timestamp`; insights on an album's parent ID | [unverified] (fields verified on the IG Media reference; the two list edges were not read) |

### 3.3 WhatsApp analytics

All on `GET /{waba-id}` with the system-user token. [verified unless marked: https://developers.facebook.com/docs/whatsapp/business-management-api/analytics, 19 Nov 2026]

| # | Fact | Status |
|---|---|---|
| W1 | Messages: `?fields=analytics.start(<unix>).end(<unix>).granularity(DAY)`; granularity `HALF_HOUR`, `DAY`, `MONTH`; optional `phone_numbers`, `country_codes`, `product_types` (`0` template messages, `2` non-template messages, `100` incoming). Response `analytics.data_points[]` of `{ start, end, sent, delivered }` | verified |
| W2 | Exact spelling of an optional filter inside the field expression, e.g. `.product_types([0])` | [unverified] |
| W3 | `conversation_analytics` is **gone**: conversation-based pricing ended 30 Jun 2025 and "the field will be unavailable starting November 1, 2026" | verified. Do not call it |
| W4 | Pricing: `?fields=pricing_analytics.start(..).end(..).granularity(DAILY).dimensions([..])`; granularity `HALF_HOUR`, `DAILY`, `MONTHLY`; dimensions `COUNTRY`, `PHONE`, `PRICING_CATEGORY`, `PRICING_TYPE`, `TIER`; categories `AUTHENTICATION`, `AUTHENTICATION_INTERNATIONAL`, `MARKETING`, `MARKETING_LITE`, `SERVICE`, `UTILITY`, `REFERRAL_CONVERSION`; types `FREE_CUSTOMER_SERVICE`, `FREE_ENTRY_POINT`, `REGULAR`. Response `data_points[]` of `{ start, end, pricing_category, pricing_type, volume, cost }` | verified |
| W5 | Currency of `cost` | [unverified] (assumed to be the WhatsApp account's billing currency, read with `GET /{waba-id}?fields=currency`, itself [unverified]) |
| W6 | Templates: `GET /{waba-id}/template_analytics?start=&end=&granularity=DAILY&template_ids=[..]&metric_types=[..]`; `granularity` must be `DAILY`; at most **10** template IDs per call; `metric_types` `SENT`, `DELIVERED`, `READ`, `CLICKED`, `COST`. Response `data[0].data_points[]` of `{ template_id, start, end, sent, delivered, read, clicked: [{ type, button_content, count }], cost: [{ type, value }] }` | verified |
| W7 | Template data defaults to **UTC** days; non-midnight timestamps are moved back to 00:00 UTC. `use_waba_timezone=true` exists (then dates are `YYYY-MM-DD`) | verified |
| W8 | Template analytics must be **confirmed first**: `POST /{waba-id}?is_enabled_for_insights=true` (or in WhatsApp Manager). "Once confirmed, template analytics cannot be disabled." It also enables link tracking and anonymised chat-data collection | verified |
| W9 | Look-back: messaging and pricing analytics **1 year** (since 1 Dec 2025); template analytics **90 days**. Template read and click data is available for **7 days** after sending | verified |
| W10 | Click figures only for `MARKETING` and `UTILITY` templates. Analytics are approximate and may differ from invoices. Accounts tied to the EU or Japan are not supported | verified |
| W11 | Time zone of `analytics` and `pricing_analytics` day buckets | [unverified] (we treat as UTC, like W7) |
| W12 | Permission needed for these reads | [unverified] (the page names none; we assume `whatsapp_business_management`) |
| W13 | Template IDs: `GET /{waba-id}/message_templates?fields=id,name,language,status&limit=100` | [unverified] (the existing `listTemplates` uses this edge without `id`) |

### 3.4 App review

`read_insights`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights` [verified: https://developers.facebook.com/docs/permissions, 19 Nov 2026]. Whether review is needed when the only Page and account belong to the business is [unverified]; build with standard access. **Screencast must show:** signing in to the suite; Channels listing the Page and Instagram account; opening Insights; changing the date range; the Facebook and Instagram tiles and charts filling in; the top-posts table with a link opened to the real post; the note under a chart naming its time zone. State in the notes that the figures are shown only to the business's own staff.

## 4. Data

### 4.1 Migration `packages/db/migrations/0079_insights.sql`

```sql
-- Statistics from Meta, one row per figure per day (spec 11). Additive only: two new tables.
-- Undo: DROP TABLE "insight_metric_daily"; DROP TABLE "insight_subject"; (nothing else refers to them).

CREATE TABLE IF NOT EXISTS "insight_metric_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('facebook_page','facebook_post','instagram_account','instagram_media','whatsapp','whatsapp_template')),
  "account_key" text NOT NULL,
  "account_id" uuid REFERENCES "inbox_phone_number"("id"),
  "subject_id" text DEFAULT '' NOT NULL,
  "metric" text NOT NULL,
  "day" date NOT NULL,
  "day_zone" text NOT NULL,
  "breakdown" text DEFAULT '' NOT NULL,
  "value" numeric(20,4) NOT NULL,
  "is_running_total" boolean DEFAULT false NOT NULL,
  "fetched_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_insight_metric_daily" ON "insight_metric_daily" ("source","account_key","subject_id","metric","day","breakdown");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_insight_metric_day" ON "insight_metric_daily" ("source","metric","day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_insight_metric_subject" ON "insight_metric_daily" ("source","subject_id") WHERE "subject_id" <> '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_subject" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('facebook_post','instagram_media','whatsapp_template')),
  "account_key" text NOT NULL,
  "subject_id" text NOT NULL,
  "kind" text,
  "title" text,
  "permalink" text,
  "published_at" timestamptz,
  "gone_at" timestamptz,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_insight_subject" ON "insight_subject" ("source","subject_id");
```

Journal entry: `{ "idx": <next>, "version": "7", "when": <previous when + 100000000>, "tag": "0079_insights", "breakpoints": true }`.

What the columns mean:

| Column | Meaning |
|---|---|
| `source` | Where the figure comes from (table 4.2) |
| `account_key` | The ID Meta reports on: Page ID, Instagram account ID, or WABA ID. Always set. (A WABA is not a row of `inbox_phone_number`, so the key cannot be the row ID.) |
| `account_id` | The `inbox_phone_number` row for a Page or Instagram account; null for WhatsApp |
| `subject_id` | `''` for account-level figures; a Page post ID, an Instagram media ID or a template ID otherwise |
| `metric` | Meta's own metric name, or one of ours prefixed `wa_` / `tmpl_` (table 4.2) |
| `day`, `day_zone` | The calendar day **as the source counts it**, and the IANA zone that day follows. Never converted |
| `breakdown` | `''` or `key=value` pairs joined with `;` in alphabetical key order, e.g. `media_product_type=REEL`, `category=MARKETING;type=REGULAR` |
| `value` | The figure. Counts are whole numbers; cost and watch time may have decimals |
| `is_running_total` | True when the value is "the total so far on this day" (followers, a post's lifetime figures). Such rows are never summed across days |
| `insight_subject` | A label for each post or template so the tables can show a title and a link. `gone_at` is set when Meta says it no longer exists |

No Meta media URL is stored (D11): thumbnails are not kept.

### 4.2 What is collected

| `source` | `metric` values | `breakdown` | `day_zone` | Running total |
|---|---|---|---|---|
| `facebook_page` | `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, `page_views_total`, `page_daily_follows_unique`, `page_daily_unfollows_unique`, `page_video_views` | none | `America/Los_Angeles` | no |
| `facebook_page` | `page_follows` | none | `America/Los_Angeles` | yes |
| `instagram_account` | `reach`, `views`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `shares`, `saves`, `replies`, `reposts`, `profile_links_taps` | none | `Africa/Lagos` | no |
| `instagram_account` | `views`, `reach` | `media_product_type=<POST \| REEL \| STORY \| CAROUSEL_CONTAINER \| AD>` | `Africa/Lagos` | no |
| `instagram_account` | `follows_and_unfollows` | `follow_type=<FOLLOWER \| NON_FOLLOWER \| UNKNOWN>` | `Africa/Lagos` | no |
| `instagram_account` | `followers_count`, `media_count` | none | `Africa/Lagos` | yes |
| `facebook_post` | `post_media_view`, `post_total_media_view_unique`, `post_clicks`, `post_video_views`, `post_reactions_total` (ours: the sum of the next row) | none | `Africa/Lagos` | yes |
| `facebook_post` | `post_reactions_by_type_total` | `type=<like \| love \| wow \| haha \| sorry \| anger>` | `Africa/Lagos` | yes |
| `instagram_media` | per G8 for the item's product type, except `navigation`, `follows`, `profile_visits`, `ig_reels_video_view_total_time` | none | `Africa/Lagos` | yes |
| `whatsapp` | `wa_sent`, `wa_delivered` | `''` (all), `type=template`, `type=free_form` | `UTC` | no |
| `whatsapp` | `wa_billable`, `wa_cost` | `category=<…>;type=<…>` | `UTC` | no |
| `whatsapp_template` | `tmpl_sent`, `tmpl_delivered`, `tmpl_read`, `tmpl_clicked` (sum of `clicked[].count`) | none | `UTC` | no |

For running totals fetched "now" (posts, media, follower counts) `day` is today's Lagos date at the time of the call; a second fetch on the same day overwrites the row.

### 4.3 Drizzle: new file `packages/db/src/schema/insight.ts`

```ts
export const insightMetricDaily = pgTable("insight_metric_daily", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  accountKey: text("account_key").notNull(),
  accountId: uuid("account_id").references(() => inboxPhoneNumber.id),
  subjectId: text("subject_id").notNull().default(""),
  metric: text("metric").notNull(),
  day: date("day").notNull(),
  dayZone: text("day_zone").notNull(),
  breakdown: text("breakdown").notNull().default(""),
  value: numeric("value", { precision: 20, scale: 4 }).notNull(),
  isRunningTotal: boolean("is_running_total").notNull().default(false),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uq: uniqueIndex("uq_insight_metric_daily").on(t.source, t.accountKey, t.subjectId, t.metric, t.day, t.breakdown),
  idxDay: index("idx_insight_metric_day").on(t.source, t.metric, t.day),
}));
```

`insightSubject` mirrors its SQL in the same style. Export both from `packages/db/src/schema/index.ts`. (The partial index `idx_insight_metric_subject` lives in SQL only; add it to Drizzle with `.where(sql\`subject_id <> ''\`)`.)

### 4.4 Collector state and permission

- State lives in `app_settings`, key `insights_state`. Add to `packages/db/src/schema/app-setting.ts`:

```ts
export interface InsightsStateValue {
  last_daily_run_day: string | null;            // Lagos day YYYY-MM-DD of the last completed daily run
  last_run_at: string | null;                    // ISO
  refresh_requested_at: string | null;           // ISO, set by the Refresh button
  sources: Record<string, {                      // key: `${source}:${account_key}`
    last_ok_at: string | null; backfilled: boolean;
    problem_code: string | null; problem_message: string | null;
    invalid_metrics: string[];
  }>;
  template_analytics: Record<string, { enabled_at: string; enabled_by: string }>;  // key: WABA id
}
export const INSIGHTS_STATE_KEY = "insights_state";
```

- Permission: add `"insights.view"` to `CAPABILITIES` (comment `// See statistics from Facebook, Instagram and WhatsApp (suite spec 11).`), to `ADMIN_CAPS` and to `MANAGER_CAPS`. Not to branch staff.

## 5. Server

### 5.1 Files

| File | Change |
|---|---|
| `packages/shared/src/insights.ts` (new, exported from the index) | Pure parsers and helpers (5.2) |
| `packages/domain/src/meta/insights.ts` (new, re-exported from `packages/domain/src/index.ts`) | Graph calls and the collector (5.3, section 6) |
| `apps/api/src/routes/insights.ts` (new) | Routes (5.4) |
| `apps/api/src/test-app.ts` | `app.route("/v1/insights", insightRoutes(db));` |
| `apps/worker/src/jobs/insights-collect.ts` (new), `apps/worker/src/inbox-loop.ts` | The job |

### 5.2 Pure helpers (`packages/shared/src/insights.ts`), each unit-tested

```ts
export interface MetricRow { metric: string; day: string; dayZone: string; breakdown: string; value: number; isRunningTotal: boolean }

/** "2020-03-10T07:00:00+0000" -> "2020-03-09": the Pacific calendar date of (end_time minus 24 hours). */
export function pageDayFromEndTime(endTime: string): string;
/** Page insights response -> rows. Object values (reactions by type) become one row per key with breakdown "type=<key>". Skips values that are null or not numeric. */
export function parsePageInsights(json: unknown, opts: { runningTotals: ReadonlySet<string> }): MetricRow[];
/** Post insights (lifetime) -> rows for `day`, all running totals; adds post_reactions_total. */
export function parsePostInsights(json: unknown, day: string): MetricRow[];
/** Instagram total_value response for one requested day -> rows; one row per breakdown result when breakdowns are present, else one row with breakdown "". */
export function parseIgAccountInsights(json: unknown, day: string): MetricRow[];
/** Instagram media insights -> rows for `day`, running totals. Reads total_value.value, else values[0].value. */
export function parseIgMediaInsights(json: unknown, day: string): MetricRow[];
/** analytics.data_points -> wa_sent / wa_delivered rows; day = UTC date of `start`. */
export function parseWaAnalytics(json: unknown, breakdown: string): MetricRow[];
/** pricing_analytics.data_points -> wa_billable / wa_cost rows with breakdown "category=X;type=Y". */
export function parseWaPricing(json: unknown): MetricRow[];
/** template_analytics -> { templateId, rows }[]. */
export function parseTemplateAnalytics(json: unknown): { templateId: string; rows: MetricRow[] }[];
/** Unix seconds for 00:00 and 24:00 of a Lagos day (UTC+1, no daylight saving). */
export function lagosDayBounds(day: string): { since: number; until: number };
/** Every day from..to inclusive with value null where no row exists. */
export function fillSeries(from: string, to: string, rows: { day: string; value: number }[]): { day: string; value: number | null }[];
/** Sum for flow metrics; last non-null value for running totals; null if every day is null. */
export function rangeTotal(points: { value: number | null }[], isRunningTotal: boolean): number | null;
/** For running totals: last non-null minus first non-null in the range; null if fewer than two points. */
export function rangeChange(points: { value: number | null }[]): number | null;
/** Metrics that count people once and so must never be added across days. */
export const UNIQUE_PEOPLE_METRICS: ReadonlySet<string>; // reach, accounts_engaged, page_total_media_view_unique, post_total_media_view_unique
export function breakdownKey(pairs: Record<string, string>): string; // sorted "k=v;k=v"
```

### 5.3 Graph calls (`packages/domain/src/meta/insights.ts`)

Page and Instagram calls use the Page token (`pageAccessToken(cfg, pageId)`), passed through spec 01's per-call token option; WhatsApp calls use the system-user token.

```ts
export async function fetchPageInsights(cfg, pageToken, pageId: string, metrics: string[], since: string, until: string): Promise<unknown>;
// GET /{pageId}/insights?metric=<csv>&period=day&since=<since>&until=<until>   (until is exclusive: pass the day after the last day wanted; span <= 90 days)
export async function listPagePosts(cfg, pageToken, pageId: string, sinceIso: string): Promise<{ id: string; message?: string; created_time: string; permalink_url?: string }[]>;
// GET /{pageId}/feed?fields=id,message,created_time,permalink_url,is_published&limit=100 ; follow paging.next up to 5 pages; keep is_published !== false and created_time >= sinceIso
export async function fetchPostInsights(cfg, pageToken, postId: string): Promise<unknown>;
// GET /{postId}/insights?metric=post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total,post_video_views
export async function fetchIgAccountInsights(cfg, pageToken, igId: string, metrics: string[], day: string, breakdown?: string): Promise<unknown>;
// GET /{igId}/insights?metric=<csv>&period=day&metric_type=total_value&since=<lagosDayBounds.since>&until=<lagosDayBounds.until>[&breakdown=<breakdown>]
export async function fetchIgProfile(cfg, pageToken, igId: string): Promise<{ followers_count?: number; media_count?: number }>;
export async function listIgMedia(cfg, pageToken, igId: string, sinceIso: string): Promise<{ id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string; timestamp: string }[]>;
export async function listIgStories(cfg, pageToken, igId: string): Promise<{ id: string; media_type?: string; permalink?: string; timestamp: string }[]>;
export async function fetchIgMediaInsights(cfg, pageToken, mediaId: string, metrics: string[]): Promise<unknown>;
export async function fetchWaAnalytics(cfg, wabaId: string, startUnix: number, endUnix: number, productType?: 0 | 2): Promise<unknown>;
export async function fetchWaPricing(cfg, wabaId: string, startUnix: number, endUnix: number): Promise<unknown>;
// GET /{wabaId}?fields=pricing_analytics.start(s).end(e).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])
export async function listWaTemplateIds(cfg, wabaId: string): Promise<{ id: string; name: string; language: string; status: string }[]>;
export async function fetchTemplateAnalytics(cfg, wabaId: string, templateIds: string[], startUnix: number, endUnix: number): Promise<unknown>; // <= 10 ids
export async function enableTemplateAnalytics(cfg, wabaId: string): Promise<void>; // POST /{wabaId}?is_enabled_for_insights=true

/** Upsert rows; on conflict update value and fetched_at. Returns how many rows were written. */
export async function saveMetricRows(db: DbExecutor, key: { source: string; accountKey: string; accountId: string | null; subjectId: string }, rows: MetricRow[]): Promise<number>;
export async function runInsightsCollection(db: DbClient, cfg: MetaConfig, log: Log, opts: { now?: Date; storiesOnly?: boolean }): Promise<{ written: number; problems: number }>;
```

`saveMetricRows` uses `INSERT … ON CONFLICT ("source","account_key","subject_id","metric","day","breakdown") DO UPDATE SET "value" = EXCLUDED."value", "fetched_at" = now()` in batches of 500.

### 5.4 Routes: `apps/api/src/routes/insights.ts`, mounted at `/v1/insights`

`export function insightRoutes(db: DbClient)`. All routes `requireAuth()` then `requireCapability("insights.view")` unless stated. Dates are `YYYY-MM-DD`; `from <= to`; span at most 400 days, else 400 "Pick a range of up to 400 days". The **previous period** is the same number of days ending the day before `from`.

| Method and path | Response | Notes |
|---|---|---|
| `GET /summary?from=&to=` | `{ data: { range, previous, sources: SourceStatus[], tiles: Tile[] } }` | Tiles and statuses below |
| `GET /series?source=&metric=&breakdown=&from=&to=` | `{ data: { source, metric, day_zone, is_running_total, points: { day, value: number \| null }[] } }` | Sums over all accounts of that source for the day. `breakdown` omitted means `''`; `breakdown=*` returns `{ series: { breakdown, points }[] }` instead of `points`. Unknown `source` or `metric` → 400 |
| `GET /posts?from=&to=&network=all\|facebook\|instagram&sort=views\|interactions\|reach\|date&limit=` | `{ data: PostRow[] }` | Posts whose `published_at` Lagos day is in range. Figures are each post's latest running totals. `limit` default 20, max 100 |
| `GET /whatsapp?from=&to=` | `{ data: { day_zone: "UTC", by_type: { day, template: number \| null, free_form: number \| null, delivered: number \| null }[], pricing: { category, type, volume, cost }[], cost_currency: string \| null, templates: TemplateRow[], template_analytics: "on" \| "off" \| "unknown" } }` | `pricing` is summed over the range |
| `GET /export.csv?from=&to=&source=all\|<source>` | `text/csv` with `content-disposition: attachment; filename="insights-<from>-to-<to>.csv"` | Columns: `source,account,item,item_link,metric,breakdown,day,day_time_zone,value,running_total`. Built with `toCsv` from `apps/api/src/lib/csv.ts`. Rows ordered by source, item, metric, breakdown, day. At most 200,000 rows, else 400 "That is too much to export at once. Pick a shorter range or one source." Audit `insights.export` (entity type `insight`, entity id `export`, after `{ from, to, source, rows }`), `notify: false` |
| `GET /status` | `{ data: { last_run_at, last_daily_run_day, refresh_requested_at, sources: SourceStatus[] } }` | |
| `POST /refresh` | `{ data: { requested_at } }` | Sets `insights_state.refresh_requested_at = now`. 429 "Figures were refreshed a few minutes ago. Try again shortly." if `last_run_at` or `refresh_requested_at` is under 10 minutes old. Audit `insights.refresh`, `notify: false` |
| `POST /whatsapp/template-analytics` | `{ data: { template_analytics: "on" } }` | **Owner only** (`auth.role === "owner"`, else 403 "Only the owner can turn this on"). Body `{ waba_id: string, confirm: true }`. Calls `enableTemplateAnalytics`; on success records `template_analytics[waba_id]`. A Meta refusal → 502 `{ error: { code: "meta_refused", message: "WhatsApp did not accept this: <Meta's message>", meta_code } }`. Audit `insights.template_analytics_enable`, `notify: true` |

```ts
type SourceStatus = { source: string; account_key: string; label: string; last_ok_at: string | null;
  problem: null | { code: "not_connected" | "no_permission" | "token" | "too_small" | "temporary" | "not_enabled" | "other"; message: string } };
type Tile = { key: string; label: string; value: number | null; previous: number | null; how: "sum" | "latest" | "daily_average"; note: string | null };
type PostRow = { network: "facebook" | "instagram"; subject_id: string; kind: string | null; title: string | null; permalink: string | null;
  published_at: string | null; from_suite: boolean; views: number | null; reach: number | null; interactions: number | null; comments: number | null; clicks: number | null };
type TemplateRow = { template_id: string; name: string; sent: number; delivered: number; read: number; clicked: number; read_rate: number | null };
```

Tiles returned by `/summary`, in this order (a tile whose source has no rows has `value: null`):

| `key` | `label` | Source and metric | `how` |
|---|---|---|---|
| `fb_views` | "Facebook views" | `facebook_page` `page_media_view` | sum |
| `fb_followers` | "Facebook followers" | `facebook_page` `page_follows` | latest |
| `fb_engagement` | "Facebook reactions, comments and shares" | `facebook_page` `page_post_engagements` | sum |
| `ig_views` | "Instagram views" | `instagram_account` `views`, breakdown `''` | sum |
| `ig_reach` | "Instagram accounts reached (average per day)" | `instagram_account` `reach`, breakdown `''` | daily_average |
| `ig_followers` | "Instagram followers" | `instagram_account` `followers_count` | latest |
| `ig_interactions` | "Instagram likes, comments, shares and saves" | `instagram_account` `total_interactions` | sum |
| `wa_delivered` | "WhatsApp messages delivered" | `whatsapp` `wa_delivered`, breakdown `''` | sum |
| `wa_cost` | "WhatsApp charges" | `whatsapp` `wa_cost`, all breakdowns | sum |

`PostRow` mapping — Facebook: `views` = `post_media_view`, `reach` = `post_total_media_view_unique`, `interactions` = `post_reactions_total`, `clicks` = `post_clicks`, `comments` = null. Instagram: `views` = `views`, `reach` = `reach`, `interactions` = `total_interactions`, `comments` = `comments`, `clicks` = null. `from_suite` is true when a `social_post_target` row has the same `external_id` (only if that table exists: check once at start-up with `to_regclass('social_post_target')`; otherwise always false).

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts`:

```ts
{ name: "insights_collect", everyMs: 10 * 60_000, last: 0, run: () => collectInsightsIfDue(db, logger) },
```

`collectInsightsIfDue(db, log, now = new Date())` in `apps/worker/src/jobs/insights-collect.ts`:

1. Return if `metaConfigFromEnv()` is null.
2. Read `insights_state`. A **full run** is due when `refresh_requested_at` is set and newer than `last_run_at`, **or** the Lagos hour is 10 or later and `last_daily_run_day` is not today's Lagos day. (10:00 Lagos is after midnight US Pacific in both seasons and after midnight UTC, so "yesterday" is complete for every source.)
3. If a full run is due → `runInsightsCollection(db, cfg, log, {})`; then write `last_run_at`, `last_daily_run_day` (only if it was the daily trigger), clear `refresh_requested_at`.
4. Otherwise, at most once an hour: `runInsightsCollection(db, cfg, log, { storiesOnly: true })`, which only fetches insights for Instagram stories less than 24 hours old (G10). Keep the time of the last stories-only run in a module-level variable `lastStoriesAt` (it does not need to survive a restart); skip when it is under 60 minutes old. A stories-only run does not change `last_run_at`.

`runInsightsCollection` steps. Each numbered step is wrapped in its own try/catch; a failure records a problem for that source and the run continues. Sleep 200 ms between Graph calls.

| Step | Calls | Window |
|---|---|---|
| 1. Page figures, per `messenger` account | `fetchPageInsights` with all P8 metrics minus that source's `invalid_metrics` | First successful run: the last 90 days. Later runs: the last 7 days |
| 2. Page posts | `listPagePosts` for the last 90 days → upsert `insight_subject` (`kind='post'`, `title` = first 120 characters of `message`); `fetchPostInsights` for each | Running totals for today |
| 3. Instagram figures, per `instagram` account | Per day: three `fetchIgAccountInsights` calls — (a) the eleven no-breakdown metrics; (b) `views,reach` with `breakdown=media_product_type`; (c) `follows_and_unfollows` with `breakdown=follow_type`. Then `fetchIgProfile` once | First run: the last 30 days. Later: the last 3 days (figures settle for 48 hours, G5) |
| 4. Instagram media | `listIgMedia` for the last 90 days and `listIgStories` → upsert `insight_subject` (`kind` = `media_product_type` lower-cased, `title` = first 120 characters of `caption`); `fetchIgMediaInsights` with the metric list for its product type | Running totals for today. Stories only while under 24 hours old |
| 5. WhatsApp messages, per distinct `waba_id` among active phone rows | `fetchWaAnalytics` three times (all, `0`, `2`), `fetchWaPricing` once | First run: 90 days. Later: 7 days |
| 6. WhatsApp templates, only if `template_analytics[waba]` is recorded | `listWaTemplateIds` → upsert `insight_subject` (`kind='template'`, `title` = `"<name> (<language>)"`); `fetchTemplateAnalytics` in groups of 10 | First run: 90 days. Later: 7 days |

Error handling per call (D10), with what is recorded in `sources[key]`:

| What happens | Recorded | Retried |
|---|---|---|
| Code `190` | `token`: "The connection to Meta has expired. Tell the technical team." Raise one `outbox_event` `insights.config_error` per 24 hours (the `alertUnknownNumbers` pattern) and stop the whole run | next run |
| Codes `10`, `200`, `299` | `no_permission`: "Meta has not given the suite permission to read these figures." One alert per 24 hours per source. Exception: code `10` on a story's insights is G10 (too few viewers) and is silently skipped | next run |
| Code `100` naming an invalid metric (P5) on a multi-metric call | Retry that call once per metric; add each metric that fails alone with code `100` to `invalid_metrics`; log a warning `insights metric no longer valid` | the metric is skipped from then on |
| Page insights `data` empty for every metric on a successful call | `too_small`: "Facebook only shares these figures once the Page has 100 likes, and only with permission to read them." (P3, P5 — the two cannot be told apart) | next run |
| Instagram account: `follows_and_unfollows` missing | no problem recorded; the tile note covers it (section 7) | next run |
| `4`, `17`, `32`, `613`, `80007`, HTTP 429, 5xx, timeout | `temporary`: "Meta was busy. We will try again on the next run." Stop calling that source for this run | next run |
| Code `100` on a post or media (deleted) | set `insight_subject.gone_at`; skip it from then on | no |
| Anything else | `other`: Meta's code and message, prefixed "Meta said: " | next run |
| Success for a source | `problem_code = null`, `last_ok_at = now`, `backfilled = true` | — |

The job never writes a zero for a figure Meta did not return.

## 7. Screens

Files in `apps/suite/src/features/insights/`:

| File | What |
|---|---|
| `insights-api.ts` | Typed calls; keys `insightKeys = { summary: (f,t) => ["insights","summary",f,t], series: (...) => […], posts: (...) => […], whatsapp: (f,t) => […], status: ["insights","status"] }`; `EXPORT_URL(from, to, source)` |
| `insights-logic.ts` + `.test.ts` | `tileText`, `deltaText`, `zoneNote`, `chartTicks`, `formatFigure` |
| `InsightsPage.tsx` | The page |
| `InsightTiles.tsx`, `TrendChart.tsx`, `TopPostsTable.tsx`, `WhatsAppPanel.tsx`, `SourceNotices.tsx` | Parts |
| `insights.css` | Styles |

Router: `/insights` → `InsightsPage`, gated on `insights.view` with the `Needs` gate (reuse it if spec 09 or another spec added it to `router.tsx`; otherwise add it as spec 09 section 7 describes). Menu: in the existing "Insight" heading of `NAV`, **above** Reports, add `{ to: "/insights", label: "Insights", Icon: LineChart, cap: "insights.view" }`; widen `NavItem["to"]`.

Charts follow `apps/admin/src/routes/inbox/reports.tsx`: `recharts` inside `ResponsiveContainer`, colours from `SERIES_COLORS`, `COLOR_GRID`, `COLOR_AXIS` and `shortDate` in `@admin/lib/analytics-theme.js`, the same `tooltipStyle`, at most 6 date marks on the axis. Tiles use `Stat` from `@admin/components/Stat.js`; the header uses `StatHero`.

### 7.1 Layout, top to bottom

1. **Header** (`StatHero`): eyebrow "Insights", title "How we are doing", sub "Figures from Facebook, Instagram and WhatsApp, with our own inbox numbers beside them."
2. **Toolbar:** "From" and "To" date inputs, preset buttons "7 days", "30 days", "90 days" (default 30 days ending yesterday), a "Refresh figures" button, a "Download spreadsheet" button, and at the right "Last updated {Thu 19 Nov, 10:04 am}" from `/status`.
3. **Notices** (`SourceNotices`): one line per source with a problem, using the `message` from `SourceStatus`, plus the fixed lines in 7.3.
4. **Tiles**, in three labelled groups: "Facebook", "Instagram", "WhatsApp". Each tile: label, value (`formatFigure`: thousands separators; charges with two decimals and the currency code, or "in your WhatsApp account's currency" when the currency is unknown), and a delta against the previous period ("+12% on the 30 days before"). No delta when either value is null or the previous value is 0. A null value shows "—" with the hint "No figure yet".
5. **Trends:** four charts, each with a small select to change the figure shown.
   - "Facebook" — bar chart of `page_media_view`; options: "Views", "People who saw our content" (`page_total_media_view_unique`), "Reactions, comments and shares", "Page visits" (`page_views_total`), "New followers" (`page_daily_follows_unique`), "Followers" (`page_follows`, line chart).
   - "Instagram" — bar chart of `views`; options: "Views", "Views by type" (stacked by `media_product_type`), "Accounts reached", "Likes, comments, shares and saves", "New followers and unfollows" (two bars), "Followers" (line).
   - "WhatsApp messages" — stacked bars: "Templates" and "Ordinary replies" (`wa_sent` by type), with a line for "Delivered".
   - "From our inbox" — shown only to people who also have `inbox.reports`: the existing `settingsApi.report({ from, to })` `messages_per_day`, bars "Customers wrote" and "We replied". Caption: "Counted by the suite from the conversations you can see. Not from Meta."
6. **Top posts** (`TopPostsTable`): columns "Post" (network icon, first 80 characters, "Posted from the suite" tag when `from_suite`), "Date", "Views", "Reached", "Likes and reactions", "Comments", "Link clicks", and a "View" link. Filters "All / Facebook / Instagram"; sort by clicking a column heading. At 390 px it becomes cards. Empty: "No posts in these dates."
7. **WhatsApp** (`WhatsAppPanel`):
   - "Charges by type of message": a table of category, type, messages, charge. Category wording: `MARKETING` "Marketing", `UTILITY` "Order and account updates", `AUTHENTICATION` and `AUTHENTICATION_INTERNATIONAL` "Sign-in codes", `SERVICE` "Customer service replies", `MARKETING_LITE` "Marketing (light)", `REFERRAL_CONVERSION` "Replies to adverts". Type wording: `REGULAR` "Charged", `FREE_CUSTOMER_SERVICE` "Free (customer wrote first)", `FREE_ENTRY_POINT` "Free (came from an advert or Page button)". Under it: "These are WhatsApp's own estimates and can differ slightly from the invoice."
   - "How each template did": table "Template", "Sent", "Delivered", "Read", "Read rate", "Button taps". If `template_analytics` is `"off"` or `"unknown"`: the text "Template figures are switched off at WhatsApp." and, for the owner only, a button "Turn on template figures…"; for others "The owner can turn them on."
   - "From our inbox" row (with `inbox.reports`): "Customers wrote: {n} · We replied: {n}" for the WhatsApp numbers the viewer can see (call `settingsApi.report` once per WhatsApp number in `inboxApi.me().numbers` and add the results), captioned "Counted by the suite. WhatsApp's 'sent' figure above also includes messages sent to customers by anything else connected to the account, so the two will not match."

### 7.2 Dialog: "Turn on template figures" (owner, `ConfirmModal`, `tone="danger"`)

Body: "This asks WhatsApp to start counting how many people receive, read and tap each template. **It cannot be turned off again.** WhatsApp will also track taps on links in your templates and use anonymous chat data to improve its service." A checkbox: "I understand this cannot be undone." Buttons "Not now" / "Turn on" (busy "Turning on…"). Success toast: "Template figures are on. They will appear after the next update."

### 7.3 Fixed notes (exact wording)

| Where | Text |
|---|---|
| Under every Facebook chart | "Facebook counts each day on United States Pacific time, which is 8 or 9 hours behind Lagos. A day here runs from about 8 or 9 in the morning Lagos time to the same time the next day." |
| Under every Instagram chart | "Days are Lagos days. Instagram can take up to two days to finish counting, so the last two days may still rise." |
| Under every WhatsApp chart | "WhatsApp counts each day from 1 am to 1 am Lagos time." |
| Tile `ig_reach` note | "This is the average for a day. People reached on different days cannot be added up, because the same person may be counted on each day." |
| Facebook group, when the problem is `too_small` | "Facebook only shares these figures once the Page has 100 likes." |
| Instagram followers chart, when `follows_and_unfollows` has no rows | "Instagram only shares new-follower figures once the account has 100 followers." |
| Any chart with a gap | Tooltip on the gap: "No figure from {Facebook / Instagram / WhatsApp} for this day." |
| Bottom of page | "Figures from Meta and figures counted by the suite are shown separately on purpose. Do not add them together." |

### 7.4 States

- Loading: `DataState` per section, so tiles can show while charts load.
- Error: `DataState` with retry per section.
- Nothing collected yet (every tile null and `last_run_at` null): a single card "Figures are collected once a day, mid-morning. Press 'Refresh figures' to fetch them now." with the button.
- No permission: the `Needs` note.
- No Page or Instagram connected: "Connect a Facebook Page or Instagram account in Channels to see their figures." with a link to `/channels`; the WhatsApp section still shows.
- "Refresh figures": on success toast "Fetching the latest figures. This takes a minute or two." and poll `/status` every 10 seconds until `last_run_at` changes (stop after 5 minutes), then refetch everything. On 429 show the server's message.

## 8. Rules and edge cases

1. **A missing figure is not zero.** No row means "no figure". `/series` returns `null` for such days; bar charts leave a gap; line charts use `connectNulls={false}`; the spreadsheet has no row for it.
2. **A real zero is zero.** If Meta returns `0`, store and show `0`.
3. **Days are never converted between time zones.** Each row keeps the source's own day and `day_zone`; the screen states the zone (7.3). A chart never mixes sources with different zones on one axis, except "WhatsApp messages" (one source) and "From our inbox" (its own chart).
4. **Running totals are never summed.** Tiles show the latest value; the delta compares the latest value in each period.
5. **Unique-people figures are never summed across days** (`UNIQUE_PEOPLE_METRICS`): tiles show a daily average; tables show per-post values only.
6. **No double counting with the suite's own numbers.** (a) A Meta figure and a suite figure are never added or subtracted. (b) The suite's inbox counts stay the source of truth for staff activity and reply times; Meta's stay the source of truth for delivery, reach and charges. (c) Account-level figures (tiles, trend charts) already include every post; post rows are a breakdown of them and are never added to them. (d) Facebook and Instagram figures are never added into one "total" figure. (e) `wa_sent` with breakdown `''` is the whole; `type=template` and `type=free_form` are its parts and are only shown stacked, never added to the whole.
7. **The suite's own numbers obey the visibility rule.** They come only from `GET /v1/inbox/reports`, which already applies `conversationScope`. This spec adds no query over `inbox_message`.
8. **Late corrections.** Re-fetched days overwrite earlier values (upsert). The newest two Instagram days and the newest Facebook day are drawn at 60% opacity.
9. **Deprecated metric at run time.** A metric Meta rejects by name is dropped for that source and logged; its tile shows "—" with the hint "No figure yet". If **every** metric of a source has been rejected, `SourceStatus.problem` is `{ code: "other", message: "Meta no longer provides these figures under the names the suite uses. Tell the technical team." }`.
10. **Thresholds.** Page under 100 likes, Instagram under 100 followers, stories under 5 viewers: no rows, a note, no error banner.
11. **Posts removed at Meta** keep their stored history and are marked `gone_at`; they stay in the table for their dates with the tag "Removed".
12. **Stories** are only measured while under 24 hours old; their last stored values stay.
13. **Ranges.** Page queries never span more than 90 days; WhatsApp never asks further back than 365 days; templates never further than 90 days. The screen can show any stored range up to 400 days.
14. **One WABA, many numbers.** WhatsApp figures are per WABA, not per phone number.
15. **Idempotent.** Running the collection twice in a row produces the same rows.
16. **Rate care.** One full run for one Page, one Instagram account and one WABA makes about 15 calls plus one per post from the last 90 days; the first run adds about 90 for the Instagram back-fill. The 200 ms pause keeps this well inside limits.
17. **No personal data.** Nothing collected here names a customer. Demographic breakdowns are not collected.
18. **Phone width.** Tiles stack two per row at 390 px; charts are 220 px tall; tables become cards.

## 9. Tests

`packages/shared/src/insights.test.ts`
- `pageDayFromEndTime: 2020-03-10T07:00:00+0000 is 2020-03-09`
- `pageDayFromEndTime: 2018-01-02T08:00:00+0000 is 2018-01-01`
- `parsePageInsights: numeric values become rows; page_follows is a running total`
- `parsePageInsights: object value becomes one row per key`
- `parsePageInsights: empty data gives no rows`
- `parsePostInsights: adds post_reactions_total as the sum of types`
- `parseIgAccountInsights: total_value without breakdown gives one row`
- `parseIgAccountInsights: media_product_type breakdown gives one row per value`
- `parseIgAccountInsights: metric missing from the response gives no row`
- `parseIgMediaInsights: reads total_value.value, falls back to values[0].value`
- `parseWaAnalytics: one sent and one delivered row per data point, day is the UTC date of start`
- `parseWaPricing: breakdown is category=…;type=…`
- `parseTemplateAnalytics: tmpl_clicked sums button counts`
- `lagosDayBounds: 2026-11-19 starts at 2026-11-18T23:00:00Z`
- `fillSeries: missing days are null, zero stays zero`
- `rangeTotal: sums flows, takes the last value for running totals, null when all null`
- `rangeChange: last minus first non-null`

`packages/domain/src/meta/insights.test.ts` (fetch stubbed)
- `runInsightsCollection: first run asks the Page for 90 days, second run for 7`
- `runInsightsCollection: an invalid metric is retried one by one and remembered`
- `runInsightsCollection: code 190 stops the run and records a token problem`
- `runInsightsCollection: empty Page data records too_small and writes no rows`
- `runInsightsCollection: a 429 on Instagram does not stop WhatsApp`
- `runInsightsCollection: running twice leaves the same number of rows`
- `runInsightsCollection: templates are skipped until template analytics is recorded as on`
- `runInsightsCollection: story with code 10 is skipped without a problem`

`apps/api/test/integration/insights.test.ts`
- `403 without insights.view on every route`
- `summary: sums flows, takes latest for followers, averages reach, null when no rows`
- `summary: previous period is the same length immediately before`
- `series: fills gaps with null and reports day_zone`
- `posts: returns latest running totals, sorted by views`
- `export.csv: has the header row, one line per stored figure, and an audit entry`
- `refresh: second call within 10 minutes is 429`
- `template-analytics: admin is refused; owner succeeds, calls POST /{waba}?is_enabled_for_insights=true, and is audited`
- `no response contains the string "itest-token"`

`apps/worker/src/jobs/insights-collect.test.ts`
- `collectInsightsIfDue: does nothing before 10:00 Lagos`
- `collectInsightsIfDue: runs once after 10:00 and not again the same day`
- `collectInsightsIfDue: a refresh request triggers a run at any hour`

`apps/suite/src/features/insights/insights-logic.test.ts`
- `deltaText: +12% / −5% / empty when previous is 0 or null`
- `formatFigure: 12345 → "12,345"; null → "—"`
- `zoneNote: returns the fixed wording for each zone`

## 10. Manual check

1. Sign in as the owner with the test Page, Instagram account and WhatsApp test number connected. Open Insights: the "figures are collected once a day" card shows.
2. Press "Refresh figures". Within two minutes tiles and charts fill for the sources that have data. For a Page under 100 likes the Facebook group shows the 100-likes note and "—", not zeros.
3. Compare three figures with Meta's own screens for the same dates: Instagram views (Instagram app → Insights), Page followers (Meta Business Suite), WhatsApp delivered (WhatsApp Manager → Insights). Expect small differences only; note them in the pull request.
4. Publish a post (spec 09 or by hand), refresh the next day: it appears in "Top posts" with a working link.
5. Pick a 7-day range, then 90 days: charts and deltas change; gaps show as gaps.
6. "Download spreadsheet": the file opens in Excel with the ten columns.
7. As owner, "Turn on template figures…": read the warning, cancel. (Only confirm if the owner has agreed; it is permanent.)
8. Sign in as a manager: Insights is visible, the template button is not. Sign in as branch staff: no Insights menu line; `/insights` shows the no-access note.
9. Set `META_SYSTEM_USER_TOKEN` to a wrong value on a test server, refresh: the notice "The connection to Meta has expired…" shows and old figures remain.
10. Repeat steps 2 and 5 at 390 px.

## 11. Done when

- [ ] Migration `0079` applies twice without error; journal and Drizzle match.
- [ ] `insights.view` exists; owner, admin and manager have it.
- [ ] The daily job fills `insight_metric_daily` for Page, posts, Instagram account, media and WhatsApp with app-role accounts, and is idempotent.
- [ ] No deprecated metric from P6, P7, G3, G9 or W3 is requested anywhere (grep the code for `page_impressions`, `page_fans`, `post_impressions`, `conversation_analytics`, `plays`).
- [ ] Every chart states its time zone; missing days are gaps; thresholds show their note.
- [ ] Tiles follow the sum / latest / daily-average rules.
- [ ] Top posts, WhatsApp charges and template tables work; CSV export works and is audited.
- [ ] Template analytics can only be turned on by the owner through the confirmation.
- [ ] Suite inbox numbers appear only for people with `inbox.reports` and are never combined with Meta's.
- [ ] All tests in section 9 pass; lint, type-check and suite build are clean; checked at 390 px.
- [ ] The pull request lists every **[unverified]** fact and what was found.

## 12. Out of scope

- Ad figures (spec 12). Comment counts per staff member (spec 03). Reply-time reports (existing Reports screen).
- Audience demographics (age, city, country, gender) and online-follower times.
- Competitor or hashtag figures. Messenger and Instagram message counts from Meta (the inbox counts them itself).
- WhatsApp call analytics, group analytics, template-group analytics, and per-country breakdowns.
- Emailing or scheduling reports. Goals and targets. The owner dashboard (blueprint stage 16).
- Re-bucketing Meta's days into Lagos days (not possible from daily totals).

## 13. Work order

1. Permission `insights.view`.
2. Migration `0079`, journal, Drizzle schema, `INSIGHTS_STATE_KEY`. Apply twice locally.
3. `packages/shared/src/insights.ts` and its tests (write the tests from the response shapes in section 3 first).
4. Graph call functions and `saveMetricRows` in `packages/domain/src/meta/insights.ts`.
5. `runInsightsCollection` with its tests, one source at a time in the order of the table in section 6.
6. Worker job `collectInsightsIfDue`, its tests, and the entry in `inbox-loop.ts`.
7. Routes `summary`, `series`, `status`, `refresh`; integration tests.
8. Routes `posts`, `whatsapp`, `export.csv`, `whatsapp/template-analytics`; integration tests.
9. Suite: `insights-api.ts`, `insights-logic.ts` + tests, page shell, toolbar, notices, tiles; route and menu line.
10. Suite: trend charts. Then top posts. Then the WhatsApp panel and the owner dialog.
11. Suite: the "From our inbox" chart and row, shown only with `inbox.reports`.
12. Against the live test assets, check every **[unverified]** fact: P4 (compare one `end_time` with the clock), P9, G6, G11, W2, W5, W11, W12, W13, and that the token really holds the five permissions in section 2. Fix and note differences.
13. Manual check (section 10), desktop and 390 px. Pull request per foundation section 8.

## 14. Open questions

| # | Question | Recommended default so work is not blocked |
|---|---|---|
| Q1 | Is Facebook's "day" always US Pacific, or the Page's own zone? (P4) | Store `America/Los_Angeles` and show the Pacific note. If step 12 shows otherwise, change the constant `PAGE_DAY_ZONE` and the note; stored rows keep their `day_zone` |
| Q2 | Does Instagram honour a Lagos-day `since`/`until` window exactly for `total_value`? (G6) | Assume yes and label days as Lagos days. If Meta snaps to its own day, change `day_zone` for new rows to what it uses and adjust the note |
| Q3 | Meaning of `follow_type` values on `follows_and_unfollows` (G6) | Show `FOLLOWER` as "New followers" and `NON_FOLLOWER` as "Unfollows". If step 12 shows the opposite, swap the labels only |
| Q4 | Currency of WhatsApp charges (W5) | Show the currency code from `GET /{waba-id}?fields=currency` if that works; otherwise the words "in your WhatsApp account's currency" |
| Q5 | Should the owner turn on template analytics? It is permanent (W8) | Leave it off until the owner agrees; the rest of the page works without it |
| Q6 | **Foundation contradiction:** section 6 reserves one table, `insight_metric_daily`, described as "account, metric, date, value, breakdown" | Kept, with extra columns (`source`, `account_key`, `subject_id`, `day_zone`, `is_running_total`) and a second small table `insight_subject` for post and template labels. Both are in migration `0079` |
| Q7 | **Foundation gap:** `account` cannot be an `inbox_phone_number` row for WhatsApp, because WhatsApp figures are per WABA and one WABA can have several rows | `account_key` (text) is the real key; `account_id` is filled for Pages and Instagram only |
| Q8 | **For other specs:** `conversation_analytics` no longer exists (W3) and most classic Page metrics (`page_impressions`, `page_fans`, `post_impressions`) are gone (P6). Anything quoting them is out of date | Use `pricing_analytics`, `page_media_view`, `page_follows`, `post_media_view` |
| Q9 | The inbox report counts messages on every channel a viewer can see; after spec 02 that includes Messenger and Instagram | The "From our inbox" chart says "all channels"; the WhatsApp panel filters by WhatsApp number. No server change |

## Built differently

Departures made while building this spec on `work/olu/suite-11-insights` (stacked on `work/olu/suite-05-wa-profile`, 20 Nov 2026). Work-order tasks 12 (checking the [unverified] facts against the live test assets) and 13 (the manual check, desktop and 390 px) were not done: no Meta account or browser was available. P4, P9, G6, G11, W2, W5, W11, W12, W13 and the five token permissions are therefore still **unchecked**. The migration has **not been executed** and the integration tests (`apps/api/test/integration/insights.test.ts`, `apps/worker/src/jobs/insights-collect-db.test.ts`) have **not been run** (no Docker). Spec 09 is not in this branch.

1. **Migration.** `insight_metric_daily.account_id` is `ON DELETE SET NULL` (ruling 9.2.8, applied to `inbox_phone_number` too): the figures stay, keyed by `account_key`. Journal `idx` is 73 (previous plus one) and `when` is `1787000000000`.
2. **`pageDayFromEndTime` steps back 12 hours, not 24.** On the day US clocks go forward the Pacific day is 23 hours long, so "end time minus 24 hours" lands on the day before and would overwrite that day's figure. The middle of the day is right on every day; both examples in section 9 give the same answers.
3. **Extra shared helpers** in `packages/shared/src/insights.ts`: the metric lists (`PAGE_METRICS`, `POST_METRICS`, `IG_ACCOUNT_METRICS`, `INSIGHT_METRICS`, `igMediaMetricsFor`), `SOURCE_DAY_ZONE`, `isRunningTotalMetric`, `rangeDailyAverage`, and day helpers (`addDays`, `daysInRange`, `dayInZone`, `lagosDayOf`, `lagosHourOf`, `isDayKey`). The WhatsApp parsers read `data_points` directly under the field or under `data[]`, and add up two points that share a day and breakdown. `parsePostInsights` writes `post_reactions_total` only when Meta returned the reactions metric. `parseTemplateAnalytics` writes `tmpl_clicked` only when Meta returned a click list.
4. **The collector writes through a small store** (`InsightsStore`, default `dbInsightsStore(db)`), so `runInsightsCollection`'s tests run with the store in memory and no database. Options gained `sleepMs` and `store`. The same job against Postgres is tested in `insights-collect-db.test.ts`.
5. **Windows.** Only complete days are stored: Page figures end on yesterday's Pacific day, Instagram on yesterday's Lagos day, WhatsApp at 00:00 UTC today. The first template read goes back 89 days, to stay inside Meta's 90. The Instagram calls run as three passes (plain figures for every day, then by type of content, then new followers) instead of three calls per day, so a refusal of a breakdown never costs the plain figures. A source is marked back-filled as soon as its long first read is stored, even if a later call in the same step fails.
6. **Errors.** `classifyInsightsError` also treats `283` and a missing Page token as "no permission" and `80000`–`80009`, `80014` as temporary (foundation C2, C3). A code 100 counts as "invalid metric" only when Meta's message names a metric; any other code 100 on a post or media marks it gone. Instagram media metrics are remembered per kind of item (`STORY:reach`). A post or media item that has left Meta's listing is asked about once more so that Meta's own answer marks it gone (otherwise rule 11 could never happen); stories are not. The hourly stories pass does not write source state or raise alerts.
7. **State.** `insights_state` also holds `currencies` (each WABA's billing currency code, read with `GET /{waba}?fields=currency`; a failure there never fails the source) and `run_claimed_at`. State is changed with single `jsonb` statements, so the API and the worker cannot overwrite each other's fields.
8. **The worker job does not run under `withJobLock`.** That helper keeps a transaction open for the whole job, and a collection talks to Meta for a minute or more. `collectInsightsIfDue` takes a marker in the state instead (`claimInsightsRun`, taken over after 30 minutes if a worker died); `Job` in `inbox-loop.ts` gained an optional `ownLock`. `last_run_at` is the time the run started. `collectInsightsIfDue` takes a fourth argument (stand-ins for tests) and returns what it did.
9. **Owner alert.** One event type, `insights.config_error`, keyed `token` for a rejected token and `<source>:<account>` for a refused permission, raised by the collector's store with the same 24-hour rule as `alertOnce` (the worker cannot import the API's helper). The type is in `alertOnce`'s list and has its case in `outbox.ts`.
10. **Routes.** `/series` only serves the three account-level sources (`facebook_page`, `instagram_account`, `whatsapp`); per-post sources answer 400, because summing posts into a series breaks rule 6c. `breakdown=*` returns the parts only, without the whole. `/summary` also returns `cost_currency`; if two WhatsApp accounts bill in different currencies the charges tile is empty with a note. `PostRow` gained `removed`. `TemplateRow` figures and `pricing` volume and cost can be `null` (no stored figure). `/whatsapp` also returns `accounts` (each WABA and whether template figures are on); `template_analytics` is `on` only when recorded for every WABA, `unknown` when there is no WABA. `SourceStatus` says `not_connected` for every source when the server has no Meta token.
11. **Template figures switch.** The API has no `meta_refused` error code, so a refusal is 502 `service_unavailable` with `details.reason = "meta_refused"` and `details.meta_code` (as specs 05 and 10 do). No answer from WhatsApp is 504, audited as `insights.template_analytics_enable_unconfirmed`, and not recorded as on. `waba_id` must be a connected WhatsApp account. If it is already recorded as on, nothing is sent. The dialog is built on `Modal` (not `ConfirmModal`, whose cancel button always reads "Cancel") so the button can read "Not now".
12. **Spreadsheet.** A title or link that starts with `=`, `+`, `-` or `@` is written with a leading apostrophe so a spreadsheet does not run it as a formula.
13. **Screen.** The browser sends "Refresh figures" and "Turn on" once (the shared `api()` retries 429 and 502). The tile shows the change as a badge ("▲ 12%") with "on the 30 days before" under it. The dimmed newest days apply to bars only. The Facebook and Instagram charts and Top posts are hidden when no such account is connected. The WhatsApp inbox row shows nothing if any number's count could not be read. `GateEditor.tsx` in the admin app gained the label for `insights.view` (its label table must list every permission).
14. **Spec 09 hook.** `from_suite` is read from `social_post_target.external_id` when that table exists (`to_regclass`, checked once per process); this branch does not create the table.
