# Wire the customer site to the live API — Design

**Date:** 2026-06-11
**Status:** Approved (design); pending implementation plan

## Problem

The customer-facing site (`apps/customer`, TanStack Start) is **100% static**. It renders
from `src/data/products.ts` (20 flavours) and `src/data/blogPosts.ts` (6 posts); the only
`fetch` in the app is in `server.ts`. Meanwhile the API already exposes rich public
endpoints under `/v1/public/*` that nothing calls, the checkout is a `localStorage` fake
that links to WhatsApp, and three pages (contact, subscription, shop/bundles) have no
backend at all.

The goal: make the API the single live source for the storefront, **shipping any
content that is richer on the static side up to the server first**, then cutting the
frontend over to the API and standing up the few missing backends.

## Audit summary (what exists today)

| Surface | Today | API today | Gap |
|---|---|---|---|
| Home / Juices / Shop / Product detail | `data/products.ts` | `GET /v1/public/catalog/products` + `/:slug` | **None** — API returns tagline/story/pairing/benefits/best_for/ingredient_details/palette/media URLs + per-variant live prices. DB seeded from `catalog.json`, a 1:1 match. |
| Blog index / post | `data/blogPosts.ts` (6 rich posts) | `GET /v1/public/blog` + `/:slug` | API missing `author`, `date`, `read_mins`, `category`, `cluster`. DB has different placeholder posts. |
| Cart | `lib/cart.tsx` (localStorage) | `GET/POST /v1/public/cart` (server cart) | Real cart unused. |
| Checkout | `checkout.tsx` — localStorage, fake order id, WhatsApp link | `/public/orders/quote` → `POST /public/orders` (stock reservation + OPay URL) → `/public/orders/:n` tracking | Entire real order+payment+delivery flow dead. |
| Branches / zones | hardcoded ₦2000 / free-over-₦20k | `/public/catalog/branches` + `/zones` | Real branches/zones/fees unused. |
| Contact | `setSent(true)`, goes nowhere | none | No backend. |
| Subscription | 3 static plans → WhatsApp | none | No backend. |
| Bundles (shop) | 4 static bundles → WhatsApp | none | No backend. |

## Decisions (locked)

- **Scope:** everything — wire all existing public APIs AND build the missing
  contact/subscription/bundle backends.
- **Single big spec** (this doc), not phased.
- **Static content → ship to server.** The static files are the *source of truth for
  seed data*. Migrate richer static content (blog fields, bundles, subscription plans)
  into the DB/seed, then delete the static files and read from the API. Products already
  match the DB, so no product-seed change.
- **Bundles & subscription plans:** served read-only from the API (DB-managed/seeded);
  order/subscribe CTA stays WhatsApp. Subscription click *also* posts a lead.
- **Contact + subscription leads:** store to a table AND emit an `outbox_event` (worker
  already fans these out to Telegram, with a generic fallback formatter).
- **Checkout:** build the real flow now, with explicit local/staging verification (dev
  uses the mock OPay URL) before any production cutover.

## Architecture

### A. API client foundation — `apps/customer/src/lib/api/`

- `config.ts` — reads `VITE_API_URL` (public; e.g. `https://api.mrssamuel.com`), default
  `http://localhost:8787` in dev.
- `client.ts` — `apiFetch<T>(path, init)` returns the `{ data }` payload, throws a typed
  `ApiError` (code, message, status) on the `{ error }` envelope or non-2xx.
- `types.ts` — interfaces mirroring API responses: `CatalogProduct`, `CatalogVariant`,
  `Branch`, `Zone`, `BlogPostSummary`, `BlogPost`, `Bundle`, `SubscriptionPlan`,
  `OrderQuote`, `PlacedOrder`, `OrderTracking`.
- `mappers.ts` — convert API shapes to existing UI types so components barely change.
  Key mapper `toUiProduct(api): Product` collapses `variants[]` → `prices: {"330ml","650ml"}`,
  maps `bottle_url`→`image`, `fruit_url`→`fruit`, `cluster_url` retained, passes `palette`
  through, derives `cluster` for `CLUSTERS`/`getFruitFor` callers.
- **Fetch strategy:** route `loader`s call TanStack `createServerFn` handlers that hit the
  API server-side (SSR'd, SEO-safe) — matches the existing loader pattern in
  `juices.$id.tsx` / `blog.$slug.tsx`. The `QueryClient` already in router context is
  reserved for client-interactive state (cart). No new dependencies.

Each unit has one purpose and a typed interface; components depend on the mapper output,
not on raw API shapes, so the API can evolve without touching the UI.

### B. Catalog wiring

- `routes/index.tsx`, `juices.index.tsx`, `juices.$id.tsx`, `shop.tsx`: replace
  `import { products }` with a server-fn loader → `/v1/public/catalog/products` (or
  `/:slug`), mapped via `toUiProduct`.
- `Hero.tsx`, `ProductCard.tsx`, `ProductDetail.tsx`: unchanged consumers of the `Product`
  type (now API-sourced).
- Branches/zones from `/catalog/branches` + `/zones` feed checkout (replaces the
  hardcoded fee logic).
- Delete `data/products.ts` once consumers are cut over (DB already mirrors it).
- Empty/error state: loader surfaces a clean "menu temporarily unavailable" UI if the API
  is unreachable (single source of truth; no static fallback).

### C. Blog wiring + schema + content migration

- **Migration `0039_blog_content_fields.sql`:** add to `blog_post` —
  `author text`, `read_mins integer`, `category text`, `cluster text`.
- **Seed:** replace current placeholder posts with the 6 real posts from `blogPosts.ts`
  (full markdown bodies + new fields). `date` maps to `published_at`.
- **API (`public-blog.ts`):** include `author`, `read_mins`, `category`, `cluster` in both
  list and detail responses.
- **Admin (`apps/admin` blog editor + `apps/api/src/routes/blog.ts`):** add the 4 fields to
  the editor + write path so owner edits don't wipe them.
- `blog.index.tsx` / `blog.$slug.tsx`: load from `/v1/public/blog`; `CLUSTERS[cover]` keeps
  working via the API `cluster` field. Delete `data/blogPosts.ts`.

### D. Cart + real checkout

- `lib/cart.tsx`: back the cart with the server cart API (`/v1/public/cart`, cookie-keyed)
  while preserving the existing `useCart()` interface (add/remove/setQty/subtotal). Hydrate
  from the server cart on load so the cart and `POST /public/orders` (which reads the
  cookie cart) agree.
- `checkout.tsx` rebuilt on the real pipeline:
  1. **Details** → as the address settles, `POST /public/orders/quote` returns live
     Shipbubble couriers + validated address; show real options (no hardcoded fee). Empty
     list → ₦0 delivery with the API's notice text.
  2. **Place order** → `POST /public/orders` with `idempotency-key` header, customer block,
     chosen `delivery_quote_id` + `delivery_fee_ngn`, optional `scheduled_delivery_at` /
     `delivery_state`, Turnstile token → `{ order_number, total_ngn, payment.authorization_url }`.
  3. **Redirect** the browser to OPay `authorization_url` (real payment). Remove the
     "card coming soon" copy and the localStorage write.
  4. **New `routes/order.$orderNumber.tsx`** tracking page → `GET /public/orders/:n?phone=…`
     (status, payment_status, totals, rider/ETA). This is the OPay `returnUrl` the API
     already builds (`/order/:orderNumber?paid=1`).
- Add the Turnstile widget to checkout (`TURNSTILE_SITE_KEY` via `VITE_`).

### E. New backends

All new tables in one migration `0040_storefront_marketing.sql`; all read endpoints under
`/v1/public/catalog/*` for consistency; all write endpoints zod-validated, rate-limited,
Turnstile-guarded, and idempotent where it matters.

- **Contact**
  - Table `contact_message` (id, name, email, phone, subject, message, created_at).
  - `POST /v1/public/contact` → insert + `outbox_event{ type: "contact.message_received",
    payload: {name, email, phone, subject} }`.
  - `contact.tsx` form does a real POST; keeps the existing success UI.
- **Subscription**
  - Table `subscription_plan` (id, slug, name, price_ngn, period, bottles_label,
    description, perks jsonb, popular bool, display_order) — seeded from the 3 static plans.
  - Table `subscription_lead` (id, name, phone, plan_slug, created_at).
  - `GET /v1/public/catalog/subscription-plans` (read).
  - `POST /v1/public/subscriptions` → insert lead + `outbox_event{ type:
    "subscription.requested" }`.
  - `subscription.tsx` loads plans from API; CTA opens WhatsApp **and** fires the lead POST.
- **Bundles**
  - Table `bundle` (id, slug, name, price_ngn, description, contents_label, badge,
    image_url, display_order) — seeded from the 4 static bundles.
  - `GET /v1/public/catalog/bundles` (read).
  - `shop.tsx` loads bundles from API; order CTA stays WhatsApp.
- **Worker (`apps/worker/src/outbox.ts`):** add explicit `format()` cases for
  `contact.message_received` and `subscription.requested` (nice Telegram messages); the
  generic fallback already covers them otherwise.

### F. Config / infra

- Add `VITE_API_URL` (and `VITE_TURNSTILE_SITE_KEY`) to customer `.env`, `.env.example`,
  `.env.production.example`, and the compose/deploy env.
- Migrations: `0039_blog_content_fields.sql`, `0040_storefront_marketing.sql`.

### G. Testing

- **API:** route tests for `POST /public/contact`, `GET/POST` subscription endpoints,
  `GET /public/catalog/bundles`, and a blog-field round-trip. Follow existing `apps/api`
  patterns; per project memory, run new test files solo (testcontainer beforeAll under load
  shows false `server.close()` failures).
- **Customer:** no test files exist today; cover via the API layer + a manual Playwright
  pass driving juices → add to cart → checkout → quote → OPay redirect, and blog →
  post. Static audits miss render crashes — CTA driving is required.

## Data flow (order, the riskiest path)

```
customer site (server-fn loader / action)
  → GET /public/catalog/products            (render menu)
  → POST /public/cart                        (server cart, cookie-keyed)
  → POST /public/orders/quote                (live Shipbubble couriers)
  → POST /public/orders  [idempotency-key]   (reserve stock, create order)
       ← { order_number, payment.authorization_url }
  → browser redirect to OPay authorization_url
  → OPay server→server callback /v1/webhooks/opay (confirms payment)
  → browser returns to /order/:orderNumber?paid=1
  → GET /public/orders/:n?phone=…            (tracking: status, rider, ETA)
```

## Error handling

- `apiFetch` throws `ApiError`; loaders catch and render route-level empty/error states
  (menu unavailable, post not found → 404 route, order not found → same generic response
  the API returns to prevent enumeration).
- Checkout: quote failures fall back to ₦0 delivery with the API notice; order failures
  (insufficient stock 422, bot check) surface inline without losing the cart; the
  `idempotency-key` prevents duplicate orders on retry.

## Out of scope (follow-ups)

- Admin CRUD UIs for bundles / subscription plans / contact inbox (seeded now,
  owner-managed later).
- Bundles/subscriptions as truly orderable items in the order/stock pipeline (WhatsApp CTA
  for now).
- Recurring subscription billing.

## Affected files (indicative)

- New: `apps/customer/src/lib/api/{config,client,types,mappers}.ts`,
  `apps/customer/src/routes/order.$orderNumber.tsx`,
  `apps/api/src/routes/public-contact.ts`, `public-subscriptions.ts`,
  `packages/db/migrations/0039_*.sql`, `0040_*.sql`,
  new schema files for `contact_message`, `subscription_plan`, `subscription_lead`, `bundle`.
- Changed: customer `routes/{index,juices.index,juices.$id,shop,blog.index,blog.$slug,
  checkout,contact,subscription}.tsx`, `lib/cart.tsx`, `components/{Hero,ProductCard,
  ProductDetail}.tsx` (as needed), `apps/api/src/routes/{public-catalog,public-blog,blog}.ts`,
  `apps/api/src/test-app.ts` (mount new routes), `apps/worker/src/outbox.ts`,
  `packages/db/src/seed.ts` (+ `seed-data/`), `packages/db/src/schema/index.ts`,
  admin blog editor, env/compose files.
- Deleted (after cutover): `apps/customer/src/data/products.ts`, `data/blogPosts.ts`.
