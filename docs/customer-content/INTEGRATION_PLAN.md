# New customer frontend — integration & admin-CMS plan

Decisions locked (2026-06-10):
1. **Frontend stack:** keep the new repo as a **TanStack Start SSR app** (React 19 / Vite 7).
   Bring it in wholesale as `apps/customer` (replacing the old Vite SPA), convert bun→pnpm,
   run its Nitro server on the DO droplet behind the Cloudflare tunnel.
2. **Admin scope:** make **everything** admin-writeable — flavours, bundles, subscription
   plans, blog, FAQs, testimonials, site settings.
3. **Flavour visuals:** full control — palette colours, bottle image, **and** decorations
   (clusters / fruit / splashes), all uploaded & assigned in admin.

Source content already extracted to this folder (`catalog.json`, `bundles.json`,
`subscription-plans.json`, `blog-posts.json`, `faqs.json`). Catalog = canonical 20 flavours;
root `menu.json` is stale and will be retired.

---

## Guiding pattern — one vertical slice per content type

Everything is built the **same way** so it stays clean across features:

1. **Schema** — Drizzle table/columns + migration (new cols nullable).
2. **Admin write API** — CRUD under `requireCapability("content.manage")` (RBAC lives in
   `packages/shared/permissions.ts`). Images via the existing R2 presign flow.
3. **Admin editor UI** — a form in `apps/admin/src/routes/owner/...` mirroring the existing
   `product-detail.tsx` pattern (Field + mutation + flash). Shared `<ImageUpload>` and
   `<ColorField>` components factored out once and reused everywhere.
4. **Public read API** — `GET /v1/public/<thing>` (joins the same tables admin writes).
5. **Frontend binding** — delete the hardcoded `src/data/*.ts`, replace with a typed
   `@tanstack/react-query` fetch. Component markup is unchanged; only the data source moves.

Two reusable mechanics power the "visual" parts:
- **Images** (bottle, decor, blog cover, avatar): admin → `presignPut` → R2 → store object
  key; public read signs/returns a URL; frontend renders `<img src>`. (Already working in
  `lib/r2.ts` + admin product/bookkeeping.)
- **Colours**: stored as hex in a `palette` jsonb (`{surface, accent, text}`); admin uses a
  colour-picker `<ColorField>`; frontend already consumes them via inline style / CSS vars.

---

## Schema delta (full)

### Alter existing
- **`product`** add: `tagline text`, `story text`, `pairing text`, `benefits jsonb(string[])`,
  `best_for jsonb(string[])`, `ingredient_details jsonb({name,benefit}[])`,
  `palette jsonb({surface,accent,text})`, `cluster_asset_id uuid` (FK → decoration_asset),
  `fruit_asset_id uuid` (FK → decoration_asset), `note text`.
  *(Bottle image reuses the existing `image_url` column.)*
  Category mapping: Classic→`regular`, Special→`special` (enum already supports both).
- **`blog_post`** add: `author_name text`, `category text`, `read_mins integer`.

### New tables
- **`decoration_asset`** — reusable image library. `id · kind (cluster|fruit|splash|leaf) ·
  name · image_url · created_at`. Admin uploads once; flavours reference them. Avoids
  per-flavour duplicate uploads.
- **`product_bundle`** — `id · slug · name · badge · description · items_label · price_ngn ·
  image_url? · is_active · display_order · timestamps · deleted_at`.
- **`subscription_plan`** — `id · slug · name · period (week|month) · bottles_label ·
  price_ngn · description · perks jsonb(string[]) · is_popular · is_active · display_order ·
  timestamps`.
- **`faq`** — `id · question · answer · display_order · is_active`.
- **`testimonial`** — `id · author_name · quote · rating · avatar_url? · display_order ·
  is_active`.
- **`site_setting`** — key/value: `key text pk · value jsonb · updated_at`. Holds WhatsApp
  number, phone, free-delivery threshold, flat delivery fee, hero copy, social links.
- **`contact_message`** — `id · name · email · phone · subject · message · created_at ·
  handled_at`. (Admin inbox; optional `contact.received` outbox event for notification.)

---

## API surface

**Public (read, unauthenticated)** under `/v1/public/`:
- `catalog/products` (extend with content+visuals) and **new** `catalog/products/:slug` detail
- `shop/bundles`
- `subscriptions/plans`
- `blog`, `blog/:slug` (exist)
- `faqs`
- `testimonials`
- `settings`
- `POST /contact` (rate-limited + Turnstile, mirror `public-orders`)

**Admin (write, `requireCapability("content.manage")`)**:
- extend `/v1/products` + `/v1/products/:id` (content, palette, decoration refs, image)
- `/v1/bundles`, `/v1/subscription-plans`, `/v1/faqs`, `/v1/testimonials`,
  `/v1/decorations`, `/v1/site-settings`, `/v1/contact-messages` (list + mark-handled)

---

## Admin CMS layout (`apps/admin`)

New **"Storefront"** section in the owner area, one subpage per type:
`Flavours · Bundles · Subscriptions · Blog · FAQs · Testimonials · Decorations · Settings`.
Each is list + detail/edit using the existing route/form conventions. Two new shared
components: `<ImageUpload>` (wraps presign→PUT→preview) and `<ColorField>` (hex + swatch).
Add a `content.manage` capability to `packages/shared/permissions.ts` and grant it to
owner/admin (manager optional) per the existing role-defaults + overrides model.

---

## Deployment (SSR app)

The customer app now ships a Node/Nitro server (not static):
- Add a build+run target to `docker-compose.yml` / systemd alongside api + worker.
- Cloudflare tunnel `ms-prod`: route `mrssamuel.com` (and `www.`) → the customer SSR port.
- Env: customer app needs `PUBLIC_API_URL=https://api.mrssamuel.com` (server-side fetches +
  client). Keep secrets out of `VITE_`/`import.meta.env`.
- `apps/customer` joins the pnpm workspace; remove `bun.lock`/`bunfig.toml`, align ESLint/TS
  to the repo base configs, wire `@ms/shared` for shared types where useful.

---

## Phased rollout (each phase = the 5-layer slice, shippable on its own)

- **Phase 0 — Integration.** Pull repo in as `apps/customer`, delete old app, pnpm-ify,
  build green, deploy SSR. *Frontend still static* — pure plumbing, zero data risk.
- **Phase 1 — Flavours (the big slice).** product content + `palette` + bottle image +
  `decoration_asset` library + cluster/fruit refs; admin editors + `<ImageUpload>`/
  `<ColorField>`; public `catalog` + `/:slug` detail; frontend `/juices` + `/juices/$id`
  fetch live. Seed the 20 flavours from `catalog.json`; retire `menu.json`.
- **Phase 2 — Bundles + Subscriptions.** tables, admin pages, public routes, `/shop` +
  `/subscription` fetch live.
- **Phase 3 — Blog + FAQs.** extend blog cols + admin; FAQ table + admin; frontend `/blog`,
  `/blog/$slug`, FAQ sections fetch live.
- **Phase 4 — Testimonials + Site settings.** tables, admin, public, bind frontend
  testimonials + settings (WhatsApp number, delivery thresholds, hero copy).
- **Phase 5 — Checkout reconciliation.** Separate from content: wire the static checkout to
  the real order flow (branch + variant_id resolution, `/orders/quote`, idempotency-key,
  Turnstile) and decide the payment-method gap (transfer/POD vs OPay-card-only). See the
  payments/delivery notes in `STRUCTURE.md`.

Recurring **subscription billing/fulfilment** (actually charging & scheduling) stays out of
scope here — Phase 2 ships the plan *catalog* only; the frontend keeps the WhatsApp handoff
until a billing system is designed.
