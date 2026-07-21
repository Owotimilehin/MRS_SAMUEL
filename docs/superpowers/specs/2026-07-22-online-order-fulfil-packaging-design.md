# Fulfiller-added packaging (straw + bag) for online orders

**Date:** 2026-07-22
**Status:** Approved design, ready for implementation plan

## Problem

When staff fulfil an **online** order, there is currently no way to record the
straw(s) and bag used to pack it. Packaging is only captured on the walk-up POS
(`sell.tsx` → `saleOrderPackaging`, decremented at `/pay`). The online fulfil
paths (`fulfilPreorderTx` for preorders, `/advance` for in-stock orders) never
touch packaging, so:

- Straw/bag stock drifts (online consumption is invisible to the branch ledger).
- Reporting under-counts real packaging usage.

**Goal:** leave room for whoever is fulfilling an online order to add packaging —
straws and bags in particular — with sensible, editable defaults.

## Key domain context

Two online order flows reach fulfilment differently:

| Order type | Juice stock deducted | First physical fulfilment action | CTA (`order-actions.ts`) |
|---|---|---|---|
| **Preorder** (`isPreorder`) | at fulfil (`fulfilPreorderTx`) | `produce` | "Fulfil & produce" |
| **In-stock** | at payment (`reconcile.ts`) | `advance` from `paid` / `book_rider` | "Mark ready for pickup" / "Book rider" |

Because the "packing moment" is a different button per type, packaging is
**decoupled** from the fulfilment state machine into its own record/edit action
that works identically for both.

Existing reusable pieces:
- `sale_order_packaging` table (`sale-order-packaging.ts`) — per-order packaging rows.
- `packaging_stock_ledger` — append-only branch balance ledger.
- `packaging_material` with `kind` enum including `bag` and `straw`.
- `GET /v1/branches/:branchId/sales/bags` — returns active bag+straw materials with
  branch balance (already used by `sell.tsx`).

No schema change and no migration are required.

## Design (Approach B: dedicated packaging panel + one endpoint)

### 1. New endpoint — `PUT /v1/branches/:branchId/sales/:id/packaging`

- **Gate:** `requireBranchScope()` + `requireAnyCapability("pos.sell", "orders.manage")`
  (same operators who fulfil online orders).
- **Body:** `{ packaging: Array<{ packaging_material_id: string; quantity: number }> }`,
  `quantity` an integer ≥ 0. Zod-validated. Missing materials are treated as 0.
- **Preconditions (409 otherwise):**
  - order exists in this branch (else 404),
  - `channel ∈ {online, phone}`,
  - status is **not terminal** (`delivered`/`cancelled`) — edits allowed through the
    whole fulfilment window so a fulfiller can correct packaging until dispatch.
  - Each `packaging_material_id` must be an active `bag`/`straw` material.

**Replace-with-diff semantics (makes it editable/correctable):**
1. Load current `sale_order_packaging` rows for the order → `prevQty` per material.
2. For each material in (previous ∪ new): `delta = newQty − prevQty`.
3. For every non-zero `delta`, insert ONE `packaging_stock_ledger` row:
   `locationType: "branch"`, `locationId: order.branchId`, `delta: -delta`
   (consuming +delta more decrements stock; reducing count posts stock back),
   `sourceType: "consumption"`, `sourceId: orderId`,
   `note: "Online packaging <orderNumber>"`, `recordedByUserId: auth.userId`.
4. Reconcile `sale_order_packaging` rows to the new desired state: delete rows whose
   new qty is 0, upsert the rest to `newQty`.
5. All in one transaction. **Warn-but-allow:** branch ledger may go negative; never
   blocks. Never touches juice/finished-goods stock.
6. `writeAudit(action: "sale.packaging_set", entityType: "sale_order", entityId, after)`
   — gives the Telegram/audit trail of who packed what.

Idempotent: re-saving the same quantities yields all-zero deltas and no ledger rows.

### 2. Frontend — Packaging card on `branch/online-order-detail.tsx`

- On load: `GET .../sales/bags` (materials + branch balances). The order's
  already-saved packaging is read from the existing order-detail payload — extend
  that response with a `packaging: [{ packaging_material_id, quantity }]` array
  (no extra round-trip, no new GET endpoint).
- **Smart prefill (all editable):**
  - Straws = total bottle quantity across line items (sum of `saleOrderItem.quantity`).
  - Bag = quantity 1, size by bottle count: `≤2 → Small`, `3–5 → Medium`, `6+ → Large`,
    matched to the bag material whose name contains the size word (fallback: first
    active bag).
  - If the order already has saved packaging, show **that** instead of the default.
- **Controls:** a number stepper per straw material and per bag material (or a bag-size
  dropdown + count). "Save packaging" button, disabled when unchanged from last save.
- Shows current branch balance per material with a subtle low/negative hint
  (informational only — never blocks).
- Hidden/absent for terminal orders (read-only summary of what was packed instead).

### 3. Flush-on-CTA (one-tap happy path)

The existing primary fulfilment handlers — `produce()` (preorder) and `advance()` /
book-rider (in-stock, from `paid`) — first call the packaging `PUT` **iff the picker
has unsaved changes**, then run their existing transition. Result: the fulfiller
normally just taps "Fulfil & produce" / "Mark ready for pickup" and packaging is saved
in the same gesture; they can also Save independently to correct later. The flush is
best-effort-ordered: if the packaging save fails, surface the error and do NOT advance.

### 4. Reporting & notifications

- `sale_order_packaging` already feeds reporting (e.g. `reports-daily`); online packaging
  now appears there automatically. No report code change.
- `sale.packaging_set` audit → existing humanizer/Telegram trail.

## Testing

**API integration (`packaging` on an online order):**
- Save creates `sale_order_packaging` rows + correct `packaging_stock_ledger` deltas.
- Re-save diffs correctly: 3→2 straws posts `+1` to the branch ledger; unchanged save
  writes no ledger rows.
- qty 0 removes the row and restores its stock.
- Terminal order (`delivered`/`cancelled`) → 409.
- Non-online channel → 409; wrong branch → 404; inactive/non-consumable material → 422.
- Negative resulting balance is allowed (warn-but-allow).
- Audit row written.

**Unit:**
- Client-side default calculator: bottle-count → straw count and bag size selection
  (boundaries 2/3, 5/6).

## Out of scope (YAGNI)

- Charging the customer for packaging (packaging stays a cost/stock concern, not a line item).
- Auto-consuming packaging without a human (defaults are a prefill, not an automatic deduction).
- Packaging on walk-up POS (already handled) or on the storefront checkout.
