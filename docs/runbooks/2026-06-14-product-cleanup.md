# Runbook: junk "atrocity" product cleanup (2026-06-14)

## 1. Diagnose (read-only)
Run against prod with a read-only DB role:

    psql "$READONLY_DATABASE_URL" -f scripts/diagnose-products.sql

Rows whose `name` is an 8-char hex string (sorted to the top) are junk. Compare
each to the canonical 20-flavour menu (13 regular @330/650ml, 7 specials @650ml;
Lemon Sip #12 is 330ml-only, preorder-required).

## 2. Decide per row
For each junk row, pick ONE:

- **Rename** (it's a real flavour with a broken name):
  `PATCH /v1/products/:id  { "name": "Crimson Elixir" }`
  (The API now rejects names that look like a bare id, so the replacement must be
  a real flavour name.)
- **Merge** (duplicate of an existing real flavour): record its `on_hand` as a
  positive stock adjustment on the REAL product (admin Adjustments screen), then
  retire the junk row (next bullet). This moves the stock without losing it.
- **Write-off + retire** (pure test junk): zero its stock with a negative stock
  adjustment, then `DELETE /v1/products/:id` (soft-delete; history preserved).

## 3. Verify
Re-run the diagnostic. No 8-char-hex names should remain with `deleted_at IS NULL`.
The admin Products + Inventory lists should show only the 20 menu flavours.

## 4. Prevent recurrence (already shipped on this branch)
- The API rejects bare-id product names on create/update
  (`looksLikeBareId` in `@ms/shared`, wired into `apps/api/src/routes/products.ts`).
- The seed entrypoint and the API integration-test bootstrap refuse a prod
  `DATABASE_URL` (`assertNonProdDb` in `@ms/db`). The known prod host
  (`138.68.165.230`) is baked into the default denylist, so the guard is **armed
  out-of-the-box** — no env setup required. To protect additional prod hosts,
  extend (don't replace) the denylist via `PROD_DB_HOSTS` (comma-separated), or
  set `MS_DB_IS_PROD=1` on the prod host itself.
