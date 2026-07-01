# Retire a single product size (variant) + drop the "starting from" price write-up

**Date:** 2026-07-01
**Status:** Approved (brainstorming) — ready for implementation plan

## Problem

Admin can already retire a whole **flavour** (product) via "Delete flavour" (soft-delete) and
Deactivate/Reactivate. But there is **no way to retire a single size** — e.g. stop selling the
330ml of a flavour while keeping its 650ml. The "Cans & prices" section on the product-detail page
only lets you publish a new price per size; it has no hide/remove control.

Separately, the customer juice grid shows a **"From ₦X"** teaser (the minimum price across sizes).
The owner wants that "starting from" write-up removed.

## Decisions (from brainstorming)

1. **Unit of retirement:** a single **size** (variant) of a flavour — not the whole flavour.
2. **Reversible:** Retire / Restore toggle using the existing `product_variant.is_active` column.
   A retired size stays visible in the admin "Cans & prices" list, marked "Retired", with a Restore
   button. No migration needed.
3. **Scope:** customer website **only**. A retired size disappears from the online storefront but
   remains sellable at the till/POS. (The POS sync filters only `deleted_at`, not `is_active`, so no
   sync change is required — this is the desired behaviour, not a bug to fix here.)
4. **Price write-up:** replace the juice grid's `From ₦{min}` with the same plain representative
   price the homepage and shop grids already show (`₦{prices[quickAddSize(p)]}`), dropping the
   "From" framing. Show a plain price (not an empty card).

## Why this is small

- `product_variant` already has `is_active boolean not null default true`.
- The public catalog already filters variants on `pv.deleted_at IS NULL AND pv.is_active = TRUE`
  (`apps/api/src/routes/public-catalog.ts:108`). Setting `is_active = false` hides the size from the
  storefront immediately — no catalog code change.
- The admin product-detail endpoint already returns `is_active` per variant
  (`loadVariantsForProduct` in `apps/api/src/routes/products.ts`), and the admin page's `Variant`
  interface already carries `is_active`. The UI just doesn't render/use it yet.

## Design

### A. Backend — one new endpoint

`PATCH /v1/products/:id/variants/:variantId` in `apps/api/src/routes/products.ts`.

- **Auth:** `requireCapability("products.manage")` (same as product PATCH/DELETE).
- **Body:** `{ is_active: boolean }` (zod-validated).
- **Validation:**
  - Product exists and not soft-deleted → else 404.
  - Variant exists, belongs to `:id`, and is not soft-deleted → else 422
    (mirrors the belongs-to check in the `/prices` endpoint).
  - **Last-active-size guard:** when setting `is_active = false`, if this is the only remaining
    active (`is_active = true AND deleted_at IS NULL`) variant of the product, reject with 422:
    "This is the only active size; retiring it would remove the whole flavour from the storefront.
    Use Deactivate flavour instead." Restoring (`is_active = true`) has no guard.
- **Effect:** set `is_active` + `updated_at = now()`; write an audit row
  (`product_variant.retire` / `product_variant.restore`, with before/after `is_active`); return the
  updated variant in the same shape the detail endpoint uses.

### B. Admin UI — `apps/admin/src/routes/owner/product-detail.tsx`

In the "Cans & prices" section, per size row:

- **Active size:** show a small **Retire** button. Clicking asks for a lightweight confirmation
  (the size vanishes from the website), then calls the endpoint and reloads.
- **Retired size:** dim the row, show a **"Retired"** pill, hide the price-publish form, and show a
  **Restore** button (one click, no confirm).
- Reuse the existing `flash` / `error` patterns already in the file. No new API-read code — the
  detail response already includes `is_active`.

### C. Storefront — remove the "starting from" write-up

`apps/customer/src/routes/juices.index.tsx:140`:

- Replace `From ₦{Math.min(...Object.values(p.prices)).toLocaleString("en-NG")}` with
  `₦{p.prices[quickAddSize(p)].toLocaleString("en-NG")}` (drop the word "From").
- This matches `ProductCard.tsx:88` (homepage) and `shop.tsx:90` (shop grid), which already show the
  plain `quickAddSize` price. Confirm `quickAddSize` is already imported/available in this file; add
  the import if missing.

No other storefront change is needed for retire: a retired size is simply absent from the catalog
payload, so `p.prices` / `variants` recompute from the sizes that remain.

## Data flow (retire)

1. Owner clicks **Retire** on the 330ml row → `PATCH /v1/products/:id/variants/:variantId
   {is_active:false}`.
2. API guards + sets `is_active=false`, writes audit, returns updated variant.
3. Admin page reloads → 330ml row shows "Retired" + Restore.
4. Next customer catalog fetch (`GET /v1/public/catalog/products`) omits the 330ml variant; the
   juice card's representative price recomputes from the remaining sizes.

## Testing

New integration test under `apps/api/test/integration/` (follow `public-catalog-stock.test.ts`
patterns):

- Retiring a size removes it from `GET /v1/public/catalog/products` (variant absent from payload).
- Restoring brings it back.
- Retiring the only active size returns 422 (last-active-size guard); the flavour is unchanged.
- A variant id that belongs to a different product returns 422.
- The endpoint requires `products.manage` (unauthorized/insufficient role rejected).

Admin/customer changes are render-only and covered by existing build/tsc; no new UI test framework
is introduced.

## Out of scope / non-goals

- No change to till/POS sellability of a retired size (explicit decision — customer-only).
- No change to whole-flavour Delete/Deactivate.
- No stock, reservation, or price-history changes. Historical `sale_order_item` rows keep their
  variant reference and price snapshot regardless.
- No migration.

## Known caveat

The customer site is a PWA; a retired size reflects on the next live catalog fetch, but a cached tab
may need a hard refresh — same as every prior deploy.
