# Order-ops batch — design

Date: 2026-07-28
Repo: `mrs-samuel/`
Status: approved-in-brainstorm, pending spec review

Four operational fixes/features, specced together and built as one batch (per owner
decision). Three are small, low-risk, high-value; one (item ②, editing a confirmed
order) touches the money path and carries the bulk of the work.

---

## ① "Order Now" → juice-first shop

### Problem
The primary storefront CTA, Nav "Order Now" (`apps/customer/src/components/Nav.tsx:63`),
points to `/shop`. `/shop` (`apps/customer/src/routes/shop.tsx`) currently leads with
**Bundles & gift boxes** whose only action is "Order on WhatsApp", then a truncated
8-bottle strip that links to product detail pages, then a wholesale panel. So the main
"buy" button buries the actual add-to-cart juice catalog behind WhatsApp bundles.

### Change
Keep `Order Now → /shop`, but restructure `/shop` so the **full juice catalog leads**:

1. **Section 1 — All juices.** A real add-to-cart product grid (same card/behaviour as
   `/juices` — `quickAddSize` / `ProductCard` add-to-cart, not a link-out to WhatsApp),
   showing every product, sorted with the existing stock-aware sort.
2. **Section 2 — Bundles & gift boxes.** The existing bundle cards (WhatsApp order),
   moved below the juices.
3. **Section 3 — Wholesale & events.** Unchanged, stays last.

Reuse the existing product-card + cart primitives already used on `/` and `/juices`;
do not fork a new card. `PageHero` copy updated to read as a shop landing ("everything
we press — pick your flavours"), bundles reframed as an add-on below.

### Scope / risk
Layout + one cart-grid reuse. No API, no data, no money. Low risk.

---

## ② Edit a confirmed order (admin / branch manager)

### Problem
Once a customer has confirmed/paid, staff can only edit **packaging**
(`PUT /:id/packaging`) and **delivery address** (`PATCH /:id/delivery-address`). They
cannot change **items/quantities** or the **delivery date**. Real orders need
correction (wrong flavour, wrong size, add a bottle, move the delivery day).

Statuses (`packages/db/src/schema/sale-order.ts`): `draft → confirmed → paid →
handed_over → out_for_delivery → delivered` (+ `failed`, `cancelled`,
`reconcile_needed`).

Relevant fields:
- `saleOrder`: `subtotalNgn`, `deliveryFeeNgn`, `totalNgn`, `scheduledDeliveryAt`,
  `refundOwedNgn`.
- `saleOrderItem`: `productId`, `variantId`, `quantity`, `unitPriceNgn`, `lineTotalNgn`.

### Money policy (owner decision)
Editing items recomputes the total from **current product/variant prices** (pricing is
tied to product — no free-form line price). When the order is already **paid** and the
new total differs from what was paid:

- The editor is shown the **+/− delta** (new total vs amount paid).
- The edit is **rejected unless** the request carries `reconciled: true` and a short
  `reconcileNote` — the editor is explicitly confirming they have collected the extra
  (or refunded the difference) **manually / offline**.
- The system performs **no automatic charge or refund**. It records the delta and the
  editor's confirmation in the audit trail. (Mirrors the existing offline-payment /
  warn-but-allow reconciliation patterns.)

For `draft`/`confirmed` (unpaid) orders, no reconciliation gate — the total simply
updates to the recomputed value.

### API

**`PATCH /branches/:branchId/sales/:id/items`** — gate `requireBranchScope()` +
`requireAnyCapability("orders.manage", "pos.sell")` (manager included).

Body:
```
{
  items: [{ productId, variantId, quantity }, ...],   // full desired line set
  reconciled?: boolean,
  reconcileNote?: string
}
```

Transaction:
1. Load order; reject if status ∈ {`handed_over`, `out_for_delivery`, `delivered`,
   `cancelled`, `failed`} (409 — too late to edit). Reject non-`online`/`phone`
   channels (walk-up POS sales edit through the till, not here).
2. Validate every `(productId, variantId)` is a currently sellable variant; look up
   current `unitPriceNgn` per variant.
3. Diff desired lines against current `saleOrderItem` rows:
   - recompute `lineTotalNgn = unitPriceNgn * quantity` per line,
   - upsert/delete `saleOrderItem` rows to match the desired set,
   - recompute `subtotalNgn` and `totalNgn = subtotalNgn + deliveryFeeNgn`.
4. **Stock reservations:** apply the per-`(productId, variantId)` quantity diff to
   `stockReservation` for the order (mirror the packaging diff-ledger approach: only
   changed buckets move). Do not touch `stockLedger` unless the order is `paid` and
   deducted — in that case adjust the deducted quantity by the diff into the same size
   bucket (same pattern as the cancel handler restoring `variantId`-scoped stock).
5. **Paid + total changed:** require `reconciled === true` (else 409 `reconcile_required`
   with the computed delta in the error payload so the UI can prompt). Store note.
6. Persist recomputed totals; `writeAudit` with `sale.items_edit`, before/after line
   sets and the delta.

**`PATCH /branches/:branchId/sales/:id/delivery-date`** (or fold into the existing
delivery-address handler) — gate identical. Body `{ scheduledDeliveryAt }`. Re-clamp to
the Lagos delivery-schedule window (reuse the existing schedule engine used at checkout
and by `scheduled_delivery_at` server-auth clamp). Reject on `delivered`/`cancelled`.

### Admin UI (`apps/admin/src/routes/owner/order-detail.tsx`)
- Editable **Items card**: change qty, remove line, add a line (flavour + size picker
  from sellables), live subtotal/total preview.
- On save of a **paid** order whose total changed: a confirm dialog shows the +/−
  delta and requires the editor to tick "I have collected/refunded this amount" and
  type a note → sends `reconciled: true` + note.
- **Delivery date** editor next to the existing address editor.
- Gated on `orders.manage` so `manager` (branch manager) sees it.

### Scope / risk
Largest item. Touches totals, stock reservations, and the paid-order money path — the
historically fragile area. Reuse the packaging diff-ledger and cancel stock-restore
patterns rather than inventing new stock math.

---

## ③ Transfer variance drill-in on `/owner/review`

### Problem
On `apps/admin/src/routes/owner/review.tsx`, every review section has a drill-in link
("Review →" / "Open →") **except** Transfer variances (`review.tsx:323–339`): the
transfer number is plain text and the only control is an inline **"Approve variance"**
button that calls `PATCH /transfers/:id/approve` with **no body**. That blind approve
bypasses the real per-line settlement UI that already exists at `/transfers/$transferId`
(`transfer-detail.tsx` `settleAndApprove`, per-line variance reason, factory-vs-loss
choice). So the owner is asked to approve a variance without seeing it, and the no-body
approve is a latent correctness gap vs the proper settlement path.

### Change
Replace the inline "Approve variance" button with a **"Review →"** `Link` to
`to="/transfers/$transferId"` `params={{ transferId: t.id }}` (same pattern the shift-close
and payment-attention rows already use). Optionally make the transfer number itself the
link. Drop the `approveTransfer` inline handler from `review.tsx` (approval now happens
on the detail page with full settlement). Keep the count/section header.

### Scope / risk
Small, UI-only in `review.tsx`. Removes a blind-approve path → net correctness win.

---

## ④ Branch manager can cancel; cancel ≠ refund

### Problem
`PATCH /:id/cancel` (`apps/api/src/routes/sales.ts:800`) is gated on `pos.sell`, which
per RBAC (`packages/shared/src/permissions.ts`) is **branch_staff / owner only**. The
`manager` role (the "branch manager") holds `orders.manage` but not `pos.sell`, so it
cannot cancel an order today. The cancel handler already restores stock and marks
`cancelled` with **no refund** — so "cancellation does not automatically mean a refund"
is already the behaviour; it just needs to be reachable by managers and made explicit in
the UI.

### Change
1. **Gate:** `requireCapability("pos.sell")` → `requireAnyCapability("orders.manage",
   "pos.sell")` on the cancel route. Grants `manager`/`admin` cancel; branch_staff/owner
   keep theirs.
2. **Response:** when cancelling a `paid` order, include `refundOwed: true` (and the
   paid amount) in the response so the UI can message it.
3. **Admin UI:** on cancel of a paid order, show "Stock restored — **no refund issued**.
   If a refund is due, raise it via Returns." No auto-refund; the refund path stays the
   deliberate returns/approval flow.

### Scope / risk
One gate change + a response flag + a UI note. Low risk. Confirm no other caller relies
on cancel being `pos.sell`-only.

---

## Sequencing / delivery
One combined spec (this doc). Suggested build/PR order within the batch, smallest-blast
-radius first: ③ → ④ → ① → ②. Quality gates per repo baseline (0 lint, clean typecheck,
targeted tests). Item ② warrants its own focused test pass (totals recompute, stock
reservation diff, paid-order reconcile gate).

## Out of scope
- Automatic charging/refunding on order edit (explicitly manual per owner).
- Free-form/override line pricing (price stays tied to product/variant).
- Editing walk-up POS sales through this path (they edit via the till).
- Refund automation on cancel.
