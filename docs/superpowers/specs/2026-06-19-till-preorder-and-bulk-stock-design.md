# Till: preorder embargo removal, bulk stock adjust, branch preorder session

**Date:** 2026-06-19
**Branch:** `feat/till-preorder-and-bulk-stock` (off `feat/pos-edit-branch-stock`)

Three related till (POS) changes for Mrs. Samuel. Each is independent and shippable on its own, but they share the till surface so they land together.

---

## Feature 1 — Remove the 330ml preorder embargo on the till (till-only)

### Problem
Every 330ml can carries `preorder_only = true` (seed + `productVariant.preorderOnly`). On the till, any cart line with that flag forces the **whole order** into preorder mode — even when 330ml is physically in stock. The owner wants 330ml to sell like a normal can at the counter, while still falling back to preorder when out of stock. The **online storefront must keep** 330ml as preorder-only (decision: "till only").

### Design
The till sale path is `POST /v1/branches/:branchId/sales` → `apps/api/src/routes/sales.ts`. The online storefront uses a separate route (`public-orders.ts`), so changing the till route does not affect online behaviour.

**Client — `apps/admin/src/routes/branch/sell.tsx`:**
- Replace the "forced preorder" trigger. Today: `forcedPreorder = cart.some(l => l.is_preorder)` where `is_preorder` comes from `variant.preorder_only`.
- New: `forcedPreorder = cart.some(line cannot be covered)`, computed from per-variant availability (`localAvailableForVariant`). A line forces preorder when its available count is **less than the line's quantity** (i.e. the till can't hand over what's being sold). This matches the existing checkout pre-flight (`have < l.quantity`). Availability is read live (the cart already re-checks per line), so adding the 2nd of a 1-in-stock can flips the order to preorder.
- Cart lines no longer set `is_preorder` from `preorder_only`. The flag is ignored on the till.
- The manual "📅 Preorder — made to order" toggle stays for opting in on in-stock items.
- Net behaviour:
  - 330ml **in stock** → instant sale.
  - Any can **out of stock** → order **auto-switches to preorder** (this is also Feature-decision #2). Cashier picks a delivery date; nothing leaves stock until fulfilment.

**Server — `apps/api/src/routes/sales.ts` (till route only):**
- Remove the unconditional `if (preorderOnly) orderIsPreorder = true;` forcing so an in-stock 330ml from the till records as a true instant sale.
- Keep the existing out-of-stock → preorder logic (short walk-up lines with `forcePreorder` set are accepted as made-to-order; the client sets `is_preorder` for OOS lines, so the server accepts them).
- `public-orders.ts` / `public-catalog.ts` untouched → **online keeps 330ml preorder-only**.
- The `preorder_only` column and seed stay as-is (data unchanged).

### Acceptance
- Till: 330ml with stock on hand completes as an instant sale (receipt is a normal sale, stock deducts now).
- Till: any can with 0 on hand auto-flips the order to preorder, requires a delivery date, deducts no stock now.
- Online storefront: 330ml still shows/behaves as preorder-only.

---

## Feature 2 — Move stock editing to the Stock page as a true bulk adjust

### Problem
`feat/pos-edit-branch-stock` added an "Edit stock" button inside the **Size Picker on the Sell page** (`EditStockModal`). The owner wants stock editing **off the sell page** and on the **Stock page** as a **bulk** adjust (edit many flavour/size counts at once). The adjusted count must let counting/selling continue from the new number with **no break**.

### Design
**Remove from `apps/admin/src/routes/branch/sell.tsx`:**
- The "Edit stock" button in `SizePicker`, the `EditStockModal` component, and the `canEdit` / `editTarget` / `onEdit` wiring. `SizePicker` returns to pick-only.

**Add to `apps/admin/src/routes/branch/stock.tsx`:**
- An "Adjust stock" mode (toggle button, shown only to users with `stock.adjust`).
- In adjust mode each row's on-hand becomes an editable number input (defaulting to its current count). A shared **Reason** select (`REASONS` from `lib/stock-adjust.ts`) plus a note field when "Other" is chosen.
- A single **Save changes** posts ONE `POST /v1/inventory/adjust` with `location_type: "branch"`, `location_id: branchId`, the shared reason, and `items[]` = every row whose count changed (`{ product_id, variant_id, new_quantity }`). The endpoint already accepts a multi-item array.
- After save: `resyncStock(branchId)` refreshes the authoritative snapshot, then refetch the page balances. Show a success toast with the number of rows updated.

**Shared helper — `apps/admin/src/lib/stock-adjust.ts`:**
- Extend with a `adjustBranchStockBulk({ branchId, reasonCode, reasonNote, items })` (or generalise `adjustBranchStock` to accept `items[]`). Same `/inventory/adjust` POST + `resyncStock`. Keep `REASONS` exported.

### "No break" continuity (why it holds)
- `/inventory/adjust` sets an **absolute** new on-hand: server computes `delta = new_quantity − currentServerOnHand` and writes an `adjustment` ledger row.
- `resyncStock` overwrites the local `stock` snapshot wholesale from server truth.
- Till availability = snapshot + the till's own un-synced optimistic sale rows (`ledger`) − reservations.
- So after an adjust, the new count is the baseline and subsequent sales keep deducting on top of it. No reset, no double count, no break.

### Gating
- `/inventory/adjust` requires `stock.adjust` (owner, admin, manager). The adjust UI on the Stock page is shown only when the user has `stock.adjust`; everyone else sees the read-only table (unchanged).

### Acceptance
- Sell page no longer offers stock editing.
- Stock page: a manager/owner can enter new counts across multiple rows, pick one reason, save once; counts update and an audit/Telegram adjustment fires (existing endpoint behaviour).
- After adjust, selling that flavour/size deducts from the new count immediately.

---

## Feature 3 — Preorder session on the till (staff view AND fulfil)

### Problem
The only preorder queue today is the owner page `/owner/preorders` (`Shell`, gated `orders.manage`). Branch staff (caps: `pos.sell, sales.view, transfers.receive`) can't see or fulfil preorders. The owner wants a preorder session **on the till**: a searchable list of preorders awaiting fulfilment, fulfillable by the till operator, with a **nav badge showing the count** awaiting fulfilment.

### Design
**New branch-scoped API — `apps/api/src/routes/branch-preorders.ts` (or add to the branch sales router), gated `pos.sell`, branch-locked:**
- `GET /v1/branches/:branchId/preorders` — open preorders (`isPreorder = true`, `status = paid`, `fulfilledAt IS NULL`, `branchId = :branchId`) with line items (flavour name + size), customer name/phone, target day, total. Mirrors the existing `/preorders` query but locked to the path branch.
- `PATCH /v1/branches/:branchId/preorders/:id/fulfil` — same deduct-stock-and-hand-over transaction as `preorders.ts`, with an added guard that the order's `branchId` matches the path branch (404/409 otherwise). Reuse/extract the shared fulfil logic so the two routes don't drift.
- Both gated on `pos.sell` so branch staff qualify; branch-locking prevents one branch's till from touching another branch's orders.

**New till page — `apps/admin/src/routes/branch/preorders.tsx` (`BranchShell`):**
- Fetches `GET /v1/branches/:branchId/preorders`.
- **Search box** filtering client-side over **every recorded field**: order number, customer name, customer phone, item/flavour names, size, channel, target day, total. (One branch's open queue is small, so client-side is fine.)
- Table: Order #, Placed, Customer (name + phone), Items, Target day, Total, actions (reprint 🖨 + **Fulfil**).
- Fulfil calls the branch-scoped PATCH; on success refetch and the nav badge updates.
- Reuses `buildReceiptFromOrder` + `printAndToast` like the owner page.

**Nav badge — `apps/admin/src/components/BranchShell.tsx`:**
- Add `{ to: "/branch/preorders", label: "Preorders", icon: "📅", cap: "pos.sell" }` to `NAV`.
- Render a count badge on that link = number of open preorders at this branch. Fetched once in `BranchShell` (and refreshed periodically / after fulfil). Hidden when zero.

**Router — `apps/admin/src/router.tsx`:** register the `/branch/preorders` route.

### Acceptance
- A till operator (branch staff) sees a "Preorders" nav item with a badge count of preorders awaiting fulfilment at their branch.
- The page lists those preorders and is searchable by order number, name, phone, and flavour.
- The operator can fulfil a preorder from the till; it deducts stock and disappears from the queue; the badge decrements.
- The operator cannot view/fulfil another branch's preorders.
- The owner `/owner/preorders` page is unchanged.

---

## Out of scope / non-goals
- No change to the online storefront preorder behaviour (330ml stays preorder-only there).
- No new capability added; reuse `pos.sell` (Feature 3) and `stock.adjust` (Feature 2).
- No change to the `preorder_only` data/column or seed.
- No migration required.

## Testing
- API: integration tests for the branch-scoped preorder GET/fulfil (branch isolation: a different branch's order returns 404/forbidden), and a `sales.ts` test that an in-stock 330ml from the till is NOT forced to preorder while an OOS line is.
- API: `/inventory/adjust` already covered; add/confirm a branch multi-item adjust test if missing.
- Admin: no unit test framework for routes; verify by typecheck/lint + manual till walkthrough (existing pattern). Existing tills need a PWA hard-refresh to pick up the new bundle.
