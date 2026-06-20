# Straws as a first-class packaging material — design

**Date:** 2026-06-20
**Status:** Approved (pending spec review)

## Goal

Add **straws** to the packaging system so they receive the same treatment bags
and bottles already get — catalog, purchase, transfer, adjust, POS consumption,
receipts, financials, and stock visibility — **without** affecting production
runs. Also introduce a new till rule: the cashier must explicitly set both a
**bag** and a **straw** quantity before a sale can complete (0 is allowed but
must be a deliberate choice).

## What a straw is

A new packaging `kind`: `straw`.

- **Unsized**, like a bag (`size_ml` stays null).
- **Tracked-only / warn-but-allow**: branch straw stock may go negative; a sale
  is never blocked because straw *stock* is short. (Factory stock keeps its
  non-negative guard — the existing `packaging_ledger_check_balance` trigger
  already only guards `location_type = 'factory'`.)
- **POS-consumed only**, exactly like bags. Production runs never debit straws.
- Seeded as a single "Straw" material (`kind = 'straw'`, `is_active = true`).

Straws flow through the **generic** packaging paths bags already use (everything
keyed by `packaging_material_id`, not by kind), so most of the backend needs no
logic change — only permission for the new kind to exist plus a few `kind=bag`
filters widened to include straws.

## The treatments and what each requires

| Treatment | Change |
|---|---|
| **Catalog / kind enum** | Add `'straw'` to the `packaging_material_kind` Postgres enum (**migration `0054`**) and to the Drizzle enum in `packages/db/src/schema/packaging-material.ts`. Seed a "Straw" material in `seed.ts`. |
| **API validation** | Add `"straw"` to the two `z.enum(["bottle","bag","other"])` declarations in `apps/api/src/routes/packaging.ts` (create + update). |
| **Purchases** | No change — generic by material id. Works once the material exists. |
| **Adjust** (owner count correction) | No change — generic. |
| **Transfers (factory→branch)** | Server is already generic by `packaging_material_id`. Only the admin transfer picker (`apps/admin/src/routes/transfers.tsx`) fetches `/packaging/materials?kind=bag` — widen it to also list straws (fetch bags + straws, or a combined consumables fetch). |
| **POS consumption** | The server endpoint `GET /branches/:id/sales/bags` (in `apps/api/src/routes/sales.ts`) filters `kind = 'bag'`. Generalize it to return both `bag` and `straw` materials, each carrying its `kind`. The sale write path is already generic (`packaging[]` → `sale_order_packaging` + ledger debit), so straws record and decrement with no change. |
| **Receipts** | Render off the generic packaging lines, so straws appear automatically. Verify in `apps/admin/src/lib/receipt-data.ts` / `receipt-html.ts` / `receipt-escpos.ts` during implementation. |
| **Admin packaging page** | In `apps/admin/src/routes/owner/packaging.tsx`: add `straw` to the `MaterialKind` type, add a kind badge style, add `straw` to the create-form dropdown, and add a "Straws on hand" stat next to "Bags on hand". |
| **Stock visibility** | Appears automatically in `GET /packaging/stock` and the admin packaging stock table once the kind exists and has a badge. No separate plumbing. |
| **Financials (P&L)** | Straw **purchases** already feed the FIFO packaging cost (generic). Straw **POS consumption** is already captured by the per-unit packaging query in `apps/api/src/routes/reports.ts` (it reads *all* `sale_order_packaging` rows). **Fix required:** `packagingBreakdown` hardcodes `kind: "bag"` for every POS-consumed line — change it to read each material's real `kind` (select `kind` in the `packaging_material` name query) so straws appear as their own `straw` line instead of being mislabeled. The `bagsCost` aggregate now represents all POS-consumed packaging (bags + straws); keep the variable or rename to `consumablesCost`, label appropriately in the breakdown. |
| **Production runs** | **No change.** Production debits only bottles via `product_variant.bottle_material_id`; straws are never consumed at production. |

## New behaviour — mandatory bag + straw selection at the till

This is the only genuinely new logic, in `apps/admin/src/routes/branch/sell.tsx`.

Today bags are an optional add-on. New rule:

1. The till renders a **Bags** section and a **Straws** section (driven by the
   generalized `/sales/bags` endpoint, grouped by `kind`).
2. The **Charge / complete-sale button is blocked** until the cashier has
   **explicitly set both a bag count and a straw count**.
3. **0 is allowed but must be deliberate.** Each section starts in an *unset*
   state. The cashier marks it set by either changing the stepper or tapping an
   explicit **"None (0)"** button. Both sections must be set to proceed.
4. While either section is unset, the button stays disabled with an inline hint:
   *"Set bag & straw counts to continue."*
5. **Stock never blocks the sale** — insufficient straw/bag stock is tracked
   warn-but-allow (ledger may go negative at the branch). Only the *unset
   selection* blocks.
6. The gate applies to **preorders** entered at the till as well.

### State model (sell.tsx)

- Mirror the existing `bagCart` / `setBagQty` with `strawCart` / `setStrawQty`.
- Add a per-group "set" flag (e.g. `bagsSet`, `strawsSet`) — true once the
  cashier interacts with the stepper or taps "None (0)".
- Charge handler / button `disabled` gains `!(bagsSet && strawsSet)`.
- On successful sale, reset both carts and both "set" flags (matching the
  current `setBagCart({})` reset).

## Scope notes

- Migration **`0054`** is the next free number on `master`. ⚠️ The
  `feat/size-aware-shift-counts` WIP branch also targets `0054` — whichever
  lands second renumbers to `0055` and updates `migrations/meta/_journal.json`.
- No change to bottles (still sized, production-consumed).
- The mandatory-selection gate is POS-only UI; it does not touch online orders.

## Out of scope

- Auto-deriving straw count from cans (explicitly rejected: cashier selects
  manually).
- Charging the customer for straws/bags (they remain tracked-only, not priced).
- Multiple straw types/sizes (one "Straw" material; the schema supports more
  later with no further changes).

## Testing

- DB: migration applies; enum has `straw`; seed creates the Straw material.
- API: `packaging.ts` accepts `kind: "straw"` on create/update; `/sales/bags`
  returns straws with `kind`; a sale with straw `packaging[]` lines records a
  `sale_order_packaging` row and debits the branch ledger (may go negative).
- Reports: a day with straw consumption produces a `straw`-kinded line in
  `packagingBreakdown` with correct FIFO cost; production-run P&L (bottles)
  unaffected.
- Transfers: a factory→branch transfer can include straw lines and credits the
  branch packaging ledger on receipt.
- Admin UI (manual/Playwright): packaging page shows Straws badge + "Straws on
  hand"; transfer picker lists straws; till blocks Charge until both bag and
  straw counts are set, allows 0 when deliberately set.
