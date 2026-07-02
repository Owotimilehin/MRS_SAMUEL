# Add a size to an existing flavour

**Date:** 2026-07-02
**Status:** Approved

## Problem

Variants (sizes) can only be created when a flavour is first created via
`POST /products`. Afterward the admin can retire/restore an existing size or
change its price, but there is **no way to add a new size** (e.g. 650ml) to a
flavour that already exists. Lemon Sip was created without a 650ml and the
owner now wants to sell one.

## Goal

1. A reusable "Add a size" capability: endpoint + admin UI, so any flavour can
   gain a new size + price at any time.
2. Use it to add **650ml Lemon Sip @ ₦4,500** on production.

## Design

### API — `POST /products/:id/variants`

- Gated on `products.manage` (same capability as retire/restore).
- Body (reuses existing `VariantInput`): `{ size_ml: number, price_ngn: number, sku?: string }`.
- One transaction, mirroring the variant-creation loop already in `POST /products`:
  1. Load product → **404** if missing or soft-deleted.
  2. If a `product_variant` row already exists for `(product, size_ml)` —
     including a soft-deleted/retired one — return **422** with a clear
     message ("this flavour already has that size; use Restore if it's
     retired"). This turns the `uq_product_variant_product_size` unique
     constraint (which ignores `deleted_at`) into a friendly error instead of a
     raw 23505/500.
  3. Insert `product_variant`: `sku` defaults to `${slug}-${size}ml`,
     `bottleMaterialId` resolved via existing `bottleMaterialIdForSize`.
  4. Insert the initial `product_price` row (`createdByUserId = auth.userId`).
  5. `writeAudit` — `product_variant.create`.
- Returns `{ data: { id, size_ml, price_ngn, is_active } }` (201).

### Admin UI — `apps/admin/src/routes/owner/product-detail.tsx`

- Under the existing "Cans & prices" list, an "Add a size" form:
  - **Size** dropdown restricted to sizes that have a bottle material
    (330 / 650), minus sizes the flavour already has — prevents orphan
    variants with no packaging and duplicate-size errors.
  - **Price** (₦) input.
  - **Add** button → `POST /products/:id/variants` → refetch → the new size
    appears in the list, where it can be retired/repriced like any other.
- If every known size already exists, hide/disable the form.

### Stock

A brand-new size starts at 0 stock, so it shows out-of-stock / preorder on the
storefront until produced/stocked. No special handling needed — the existing
per-(flavour,size) stock and preorder logic covers it.

## Testing

Integration tests for the endpoint:
- happy path (new size created + price published),
- duplicate size → 422,
- product not found → 404,
- capability enforcement (non-`products.manage` → 403).

## Rollout

1. Ship feature (build + deploy).
2. Add 650ml Lemon Sip @ ₦4,500 via the new endpoint/UI on prod.

## Out of scope (YAGNI)

- Restoring a soft-deleted variant through this endpoint (rare; whole-flavour
  deletes are the only path that soft-deletes variants). The 422 points the
  user to the existing Restore action for retired sizes.
- Arbitrary/custom ml sizes with no bottle material.
