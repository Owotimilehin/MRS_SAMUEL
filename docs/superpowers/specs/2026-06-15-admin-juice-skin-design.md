# Admin "Juice Skin" — water-drop visual redesign

**Date:** 2026-06-15
**Status:** Approved (design); ready for implementation plan
**Scope:** `apps/admin` only. No API, DB, or customer-app changes.

## Problem

The admin is functional but visually flat — plain cream cards and text tables on
every page. Products are shown as text rows even though every flavour already
carries rich visual data (`bottleAssetId`, `clusterAssetId`, `fruitAssetId`,
`palette`) that the customer storefront uses but the admin never renders. The
owner wants an "ecstatic, jaw-dropping" admin where the brand's water-drop /
juice identity is felt on every page and **every product is represented by its
assigned bottle and flavour theming**, not a line of text.

## Goals

1. A cohesive water-drop / juice visual language across **every** admin page.
2. Every product surface shows the product's **assigned bottle on its own
   palette**, with a graceful themed fallback when no asset is set.
3. "Lively but professional" — visible motion and theming, but data stays
   readable for daily operational work.
4. POS stays fast and second-session-safe (see Constraints).

## Non-goals

- No changes to data models, APIs, or the customer storefront.
- No new bottle/fruit artwork; reuse existing media assets and the customer's
  decoration set. (A trimmed copy of the fallback map is acceptable.)
- Not a re-layout of information architecture — same pages, same data, new skin.

## Existing material (already in the codebase)

- **Global chrome:** `apps/admin/src/components/Shell.tsx` wraps every route
  (sidebar + header + `.app-body`). Theming the Shell themes all ~30 pages.
- **Primitives:** `apps/admin/src/index.css` already defines design tokens and
  `card`, `page-head`, `table`, `pill`, `btn`, `stat`, `app-shell`, etc.
- **Animations to port:** customer `styles.css` has `float-y` and `splash`
  keyframes.
- **Product visual data:** `ProductContent` (palette + bottle/cluster/fruit
  asset ids) on every product; images reachable from admin via the `/media`
  nginx proxy to the customer app.
- **Fallback mapping:** customer `lib/visuals.ts` maps slug → cluster/fruit and
  holds bottle imports — source for a trimmed admin fallback map.
- **POS:** `routes/branch/sell.tsx` renders a **flavour grid** from the **local
  offline catalog** (`local.products` via Dexie/`useLiveQuery`), grouped one
  card per flavour, alongside a cart/checkout panel.

## Architecture (Approach A — design layer + reusable media component)

Two reusable foundations, then a page-by-page adoption sweep.

### 1. Design foundation — `index.css`

- **Keyframes:** port `float-y`, `splash`; add `drip` (vertical droplet fall) and
  `ripple` (expanding ring). All gated behind `@media (prefers-reduced-motion:
  no-preference)`; static fallback otherwise.
- **Ambient layer:** a behind-content water-drop backdrop on `.app-body`
  (floating SVG droplets + soft juice-tint radial glows). Pure CSS/SVG,
  `pointer-events: none`, GPU-cheap (`transform`/`opacity` only), low opacity so
  it never competes with data.
- **Themed primitives:**
  - `glass-card` — frosted translucent card for hero/feature areas.
  - `theme-head` — juice-gradient page header with floating droplets (a richer
    variant of the existing `page-head`).
  - `drip-divider` — section divider with a droplet motif.
  - `bottle-chip` — compact bottle + name token for table rows / line items.
- **Per-flavour theming:** components set `--fl-surface` / `--fl-accent` inline
  from a product's `palette`; primitives read those vars so a card/chip tints to
  the flavour. Text colour auto-derives for contrast (reuse
  `deriveTextColour` logic).

### 2. `FlavourMedia` component — `apps/admin/src/components/FlavourMedia.tsx`

- **Input:** a product-like object (`slug`, `palette`, assigned bottle URL /
  `bottleAssetId` / `image_url`, optional fruit/cluster).
- **Output:** the assigned bottle image on its palette tint with a gentle float
  animation and a droplet + fruit accent.
- **Sizes (variant prop):** `hero` (detail pages), `card` (grids), `thumb`/`chip`
  (tables, POS buttons, line items).
- **Fallback:** when no bottle asset exists, render a palette-coloured CSS bottle
  silhouette, using a **trimmed slug → palette/fruit map** ported from customer
  `visuals.ts`. Nothing ever renders empty or off-brand.
- **Single source of truth:** every product surface in the admin renders product
  imagery through this component — no ad-hoc `<img>`s.

### 3. Global chrome — `Shell.tsx` + `index.css`

- Themed sidebar (juice gradient + subtle droplet texture, refined brand mark)
  and a top header with a drip accent. Inherited by every page automatically.
  Markup changes kept minimal; most work is CSS.

### 4. Page-adoption sweep

Grouped so related pages share patterns:

- **Product surfaces** (highest impact):
  - `owner/products` list → flavour **cards with bottles** (replaces text table).
  - `owner/product-detail` → **bottle hero** + full palette theming.
  - `owner/inventory`, `owner/adjustments`, `owner/packaging` → `bottle-chip`
    per row.
  - `owner/preorders`, `owner/bundles`, `owner/subscriptions` → `FlavourMedia`.
- **Dashboard** (`owner/dashboard`) → themed stat cards with droplet motifs and
  a juice hero band.
- **POS** (`branch/sell`) → flavour buttons gain a **bottle `thumb` + palette
  tint** for fast recognition. Sourced from the **local offline catalog only**
  (no new network calls during selling); imagery confined to the button so it
  **never overlaps the cart/checkout panel**.
- **Remaining management/utility pages** (orders, customers, returns, closes,
  bookkeeping, vendors, zones, users, audit-log, devices, settings, blog, leads,
  branches, factories, transfers, production-runs, etc.) → themed `theme-head`
  headers, `glass-card`/`card` surfaces, and the ambient drop layer. No bottle
  imagery where there is no product.

### 5. Polish & guardrails

- `prefers-reduced-motion` respected everywhere.
- Performance budget for POS: bottle thumbs small and served from the existing
  local/cached catalog; selling interactions must not regress.
- Bump the admin PWA service-worker cache so the new skin actually ships (admin
  caches aggressively; old UI persists until SW updates).
- Playwright visual spot-checks on Products, Product detail, Dashboard, and POS.

## Constraints / decisions

- **POS "second session" interpretation (confirmed direction):** POS theming
  draws from the offline local session without slowing selling, and bottle
  imagery stays inside the product button and never overlaps the cart panel.
- Data stays readable: ambience is low-opacity and behind content; tables remain
  legible.
- Reuse existing tokens/palette (deep-green primary, orange secondary) — the
  water-drop layer is additive, not a re-palette.

## Risks

- **Image availability in admin:** some products may lack an assigned bottle —
  mitigated by the CSS-silhouette fallback.
- **POS performance:** mitigated by small cached thumbs and local-only sourcing.
- **PWA caching:** mitigated by the SW cache bump; verify via hard refresh /
  incognito.
- **Motion sensitivity / readability:** mitigated by `prefers-reduced-motion`
  and low-opacity ambience.

## Success criteria

- Every admin page shows the water-drop visual language.
- Every product surface shows the assigned bottle (or themed fallback) on its
  palette.
- POS remains fast; bottle imagery never overlaps the cart and needs no extra
  network calls.
- Typecheck + lint clean; existing admin behaviour unchanged.
