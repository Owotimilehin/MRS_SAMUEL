# Customer-content backend assets — structure & schema delta

Source: the new customer frontend **`fruit-splash-showcase`** (TanStack Start, Lovable).
All content below was *retrieved* from that repo's hardcoded data and reshaped into
backend-ready assets. **No existing files were modified.** These are seed/spec assets
only — wiring them in is a follow-up step.

> **Catalog truth:** the flavour list on the frontend repo is up to date. The 20
> products in `catalog.json` are canonical and **supersede** the 17 in the root
> `menu.json` (which still lists retired/renamed items: Tropical Swirl, Immune
> Booster, Ultimate Detox, Ginger Fireball, Watermelon Juice, Blood Booster, Pink
> Paradise, Mrs. Samuel Fruit Punch). Treat `menu.json` as stale.

## Asset files in this folder

| File | Rows | Target |
|---|---|---|
| `catalog.json` | 20 products (13 regular, 7 special) + variants/prices | `product` + `product_variant` + `product_price` |
| `bundles.json` | 4 bundles | **new** `product_bundle` |
| `subscription-plans.json` | 3 plans + how-it-works | **new** `subscription_plan` |
| `blog-posts.json` | 6 posts (body flattened to markdown) | `blog_post` (+ 3 new columns) |
| `faqs.json` | 4 FAQs + contact-form spec | **new** `faq`, **new** `contact_message` |

---

## A. Reuses existing tables (with small additions)

### `product` — add marketing-content columns
The public catalog (`/v1/public/catalog/products`) and the `product` table currently
expose only `name, slug, category, ingredients[], image_url`. The frontend renders far
more on `/juices/$id`. Add (all nullable so existing rows are unaffected):

| Column | Type | From `catalog.json` |
|---|---|---|
| `tagline` | `text` | `tagline` |
| `story` | `text` | `story` |
| `pairing` | `text` | `pairing` |
| `benefits` | `jsonb` (`string[]`) | `benefits` |
| `best_for` | `jsonb` (`string[]`) | `best_for` |
| `ingredient_details` | `jsonb` (`{name,benefit}[]`) | `ingredient_details` |

`category` enum already supports the needed values: **Classic → `regular`, Special → `special`**.
`cluster` and `note` are frontend hints — carry `note` only if "preorder required" (lemon-sip)
should be surfaced; `cluster` can stay client-side.

Then extend `publicCatalogRoutes` `/products` (and add a `/products/:slug` detail route)
to return these fields.

### `product_variant` / `product_price` — seed sizes & prices
Each product gets one variant per `size_ml` in `catalog.json.variants` (most have 330 + 650;
`lemon-sip` is 330 only) with the matching `product_price.price_ngn`. SKU convention already
exists (`uq_product_variant_sku`) — generate e.g. `MS-<SLUG>-330`.

### `blog_post` — add 3 columns, seed 6 posts
Table exists (`body_md`, `excerpt`, `cover_url`, `published_at`). The frontend also shows
author, category and read-time, which have no columns. Add nullable:

| Column | Type | From `blog-posts.json` |
|---|---|---|
| `author_name` | `text` | `author_name` |
| `category` | `text` | `category` (`Story`/`Wellness`/`Behind the Scenes`/`Recipes`) |
| `read_mins` | `integer` | `read_mins` |

Body arrays were flattened to markdown (`p`→paragraph, `h`→`##`, `quote`→`>`). `cover_hint`
is a cluster name, **not** a real asset URL — supply real `cover_url`s before publishing.

---

## B. Net-new tables + public endpoints

### `product_bundle`  ← `bundles.json`
`id uuid pk · slug text unique · name text · badge text · description text ·
items_label text · price_ngn integer · is_active boolean default true ·
display_order integer · timestamps · deleted_at`
New route: **`GET /v1/public/shop/bundles`** → active bundles ordered by `display_order`.
(Composition is copy-only today; itemising into variants is a later enhancement.)

### `subscription_plan`  ← `subscription-plans.json`
`id uuid pk · slug text unique · name text · period text (week|month) ·
bottles_label text · price_ngn integer · description text · perks jsonb(string[]) ·
is_popular boolean · is_active boolean default true · display_order integer · timestamps`
New route: **`GET /v1/public/subscriptions/plans`**.
> Note: this is **catalog only**. Actual recurring billing/fulfilment (signup, schedule,
> charge) is a separate system not covered here — the frontend currently hands off to
> WhatsApp.

### `contact_message`  ← `faqs.json.contact_form`
`id uuid pk · name text · email text · phone text · subject text · message text ·
created_at · handled_at (nullable)`
New route: **`POST /v1/public/contact`** (rate-limited + Turnstile, mirroring
`public-orders`). Optionally emit an `outbox_event` (`contact.received`) so the owner is
notified, same pattern as `sale.online_placed`.

### `faq`  ← `faqs.json` *(optional)*
`id uuid pk · question text · answer text · display_order integer · is_active boolean`
New route: **`GET /v1/public/faqs`**. Low value — these 4 entries can just as well stay
static in the frontend. Include only if FAQs should be owner-editable from admin.

---

## Suggested migration order (when you green-light building)
1. `00XX_product_marketing_fields.sql` — add 6 columns to `product`.
2. `00XX_blog_post_meta.sql` — add `author_name`, `category`, `read_mins`.
3. `00XX_product_bundle.sql`
4. `00XX_subscription_plan.sql`
5. `00XX_contact_message.sql` (+ `faq` if wanted)
6. Extend `packages/db/src/seed.ts` to load these JSON assets (it already reads
   `menu.json` from root — same pattern), and align the catalog seed to `catalog.json`
   instead of stale `menu.json`.
7. Add the new public routes in `apps/api/src/routes/` and mount them in `test-app.ts`
   under `/v1/public/*`.

## Still NOT covered by any asset here (genuine product decisions)
- **Payment methods**: frontend offers transfer / pay-on-delivery / card; backend
  `POST /public/orders` is OPay-card-only. Reconciling this is a checkout decision, not
  a content asset.
- **Recurring subscription billing & fulfilment** (see note above).
- **Bundle → stock decrement** (how a 6-pack draws down inventory).
