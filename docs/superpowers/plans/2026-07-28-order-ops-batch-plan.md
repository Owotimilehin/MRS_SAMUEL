# Order-ops batch — implementation plan

Executes `docs/superpowers/specs/2026-07-28-order-ops-batch-design.md`.
Branch: `feat/order-ops-batch` (off `c9cd354`).

## Global Constraints (bind every task)

- **Monorepo:** pnpm workspace. `apps/{api,admin,customer,worker}`, `packages/{db,domain,shared}`.
- **Quality gates:** `pnpm lint` → 0 errors; `pnpm typecheck` (`tsc -b`) → clean. Both must
  pass before a task is DONE.
- **Tests:** run **targeted** test files, never the whole API suite — the full API suite hits
  testcontainer timeouts. Run the specific vitest file(s) for the code you changed.
- **TDD:** write the failing test first, then the implementation.
- **Pricing is tied to product/variant.** Never introduce free-form/override line pricing. Line
  price always comes from the variant's current `unitPriceNgn`.
- **No automatic money movement.** Edits/cancels never auto-charge or auto-refund. Any +/− is
  reconciled manually by the editor and recorded via `writeAudit`.
- **Follow existing patterns** already in the codebase — do not invent new ones:
  - capability gates via `requireCapability` / `requireAnyCapability` from
    `apps/api/src/middleware/auth.js`; branch scope via `requireBranchScope()`.
  - stock/packaging edits use the **diff-ledger** approach (see `PUT /:id/packaging` in
    `apps/api/src/routes/sales.ts` — only changed buckets move).
  - every mutating admin action calls `writeAudit(db, c, { action, entityType, entityId, ... })`.
  - admin data fetch via `api()` + `humanizeError` from `apps/admin/src/lib/api.js`; money via
    `ngn()` from `apps/admin/src/lib/format.js`.
- **RBAC roles:** `owner`, `admin`, `manager`, `branch_staff` (`packages/shared/src/permissions.ts`).
  "Branch manager" = the `manager` role. `manager` holds `orders.manage` but NOT `pos.sell`.
- No DB schema changes are expected in this batch. If one becomes necessary, add the migration
  file AND its `migrations/meta/_journal.json` entry, and rebuild `@ms/db`.

---

## Task 1: Transfer-variance drill-in on the review page

**Goal:** On `/owner/review`, make each Transfer-variances row link into the existing transfer
detail page (which has proper per-line variance settlement) instead of exposing a blind inline
"Approve variance" button that POSTs with no settlement body.

**File:** `apps/admin/src/routes/owner/review.tsx`

**Current state:** the Transfer-variances `<tbody>` (around lines 322–340) renders each row with
`t.transferNumber` as plain text and an inline `<button>` calling `approveTransfer(t.id)` →
`PATCH /transfers/${id}/approve` with **no body**. Other sections on the page (Shift closes,
Payment attention) use a `<Link className="pill pill--ink">…→</Link>` to a detail route.

**Change:**
1. Replace the inline "Approve variance" button in the Transfer-variances row with a
   `<Link to="/transfers/$transferId" params={{ transferId: t.id }} className="pill pill--ink">Review →</Link>`
   (same visual pattern as the "Review →" / "Open →" links already in this file). The transfer
   detail page (`apps/admin/src/routes/transfer-detail.tsx`, route `/transfers/$transferId`) already
   provides the full sent-vs-received breakdown and `settleAndApprove` (factory-vs-loss) flow.
2. Remove the now-unused `approveTransfer` function and its `acting` usage **only if** it is not
   used elsewhere in the file (the return-approval buttons also use `acting` — keep `acting` and
   the return handlers; only remove `approveTransfer`).
3. Leave the section header, count pill, loading and empty states unchanged.

**Tests / verification:** this file is presentational and the repo has no component test harness
for admin routes. Verify by: `pnpm lint` clean, `pnpm typecheck` clean, and confirm the route
`/transfers/$transferId` exists in `apps/admin/src/routes/transfer-detail.tsx` (it does — used by
`transfers.tsx`). No behavioural test file required; state this explicitly in the report.

**Acceptance:**
- Transfer-variances rows navigate to `/transfers/$transferId`; no inline approve button remains.
- No dead code, no unused imports/vars; lint + typecheck clean.

---

## Task 2: Managers cancel orders; cancel asks whether a refund is owed (no auto-refund)

**Corrected scope note:** the admin order-detail "Cancel" for ONLINE orders calls
`payments-admin.ts /online-orders/:id/cancel-refund`, NOT `sales.ts /:id/cancel` (that's the
POS/till path). The real item-④ fix lives in the online-order path. Sub-part (A) below is **already
committed** (`ec4aef7`) and kept per owner decision; sub-parts (B)(C)(D) are the remaining work.

**Owner decisions baked in:**
- On a PAID-order cancel, the operator is ASKED "is a refund owed?" (yes/no + amount). Only then is
  `refundOwedNgn` set. Refund itself stays a separate manual/Returns action; owner-only
  `mark-refunded` unchanged.
- Managers (and branch_staff — both hold `orders.manage`) can cancel paid orders from the BRANCH
  view too; owner view keeps it.

### (A) POS sales cancel gate — DONE (`ec4aef7`), do not redo
`sales.ts PATCH /:id/cancel` gate widened to `requireAnyCapability("orders.manage","pos.sell")`;
paid cancels return `refundOwed`/`paidAmountNgn`; integration test `sale-cancel-capability.test.ts`.

### (B) API — `payments-admin.ts` `POST /:id/cancel-refund` (~line 250, gate stays `orders.manage`)
1. Extend `CancelRefundBody` (line 26) with `refundOwed: boolean` and optional
   `refundAmountNgn: number` (positive int).
2. In the handler: keep the stock restore for `paid` orders and the `cancelled` status write. But
   set `refundOwedNgn` **only when `refundOwed === true`** — amount = `refundAmountNgn ?? fresh.totalNgn`,
   clamped to `≤ fresh.totalNgn`; when `false`, leave `refundOwedNgn` null and do NOT emit the
   `sale.refund_owed` outbox event. This also fixes the latent bug where `refundOwedNgn` was set
   unconditionally even for unpaid cancels.
3. Audit `after` reflects the actual `refundOwedNgn` written.

### (C) Admin owner view — `owner/order-detail.tsx` cancel modal
The `cancelAndRefund` toast copy is already updated. Update the cancel MODAL to also ask "Is a
refund owed?" (yes/no) and, when yes, an amount (default = order total, for paid orders). Pass
`refundOwed` + `refundAmountNgn` in the `cancel-refund` body. Toast reflects the choice.

### (D) Admin branch view — `branch/online-order-detail.tsx` expose paid-cancel to managers
1. `actionAllowed` (line ~265) currently returns `false` for `cancel_refund`. Allow it when
   `can("orders.manage")` (both branch_staff and manager have it); keep `accept_paid`/
   `mark_refunded`/`recheck_payment` owner-only.
2. Wire a cancel flow for paid orders in the branch view mirroring the owner modal (reason +
   "refund owed?" + amount) → `POST /online-orders/:id/cancel-refund`. Reuse existing modal/toast
   patterns already in this file (it already has a `cancelUnpaid` flow + `confirmCancelUnpaid`).

**Tests (targeted):** extend the integration suite for `cancel-refund`:
- paid order + `refundOwed:true` → `refundOwedNgn = amount` (clamped), emits `sale.refund_owed`;
- paid order + `refundOwed:false` → cancelled, `refundOwedNgn` stays null, NO refund event;
- unpaid (`confirmed`) order + `refundOwed:false` → cancelled cleanly, no refund flag (regression
  for the old unconditional-set bug).
Run only that test file.

**Acceptance:** cancel-refund honours the refund-owed choice (no auto-flag); managers can cancel
paid orders from branch + owner views; owner-only mark-refunded unchanged; tests pass; lint +
typecheck clean.

---

## Task 3: `/shop` restructured — full juice catalog first

**Goal:** The Nav "Order Now" CTA (already → `/shop`) should land on a shop page whose **full
add-to-cart juice catalog leads**, then bundles, then wholesale.

**Files:**
- `apps/customer/src/routes/shop.tsx` (restructure).
- Reuse existing primitives: `ProductCard` / add-to-cart from `apps/customer/src/lib/cart.ts`
  (`quickAddSize`, `formatNaira`) and the product grid pattern used in
  `apps/customer/src/routes/juices.index.tsx` and `routes/index.tsx`. Do NOT fork a new card.

**Change:** reorder/rebuild `/shop` sections to:
1. **All juices** — a real add-to-cart product grid over the full `products` list (same card +
   add-to-cart behaviour as `/juices`; apply the existing stock-aware sort if one is used on
   `/juices`). This is the lead section, directly under the page hero.
2. **Bundles & gift boxes** — the existing bundle cards (WhatsApp order), moved below the juices.
3. **Wholesale & events** — unchanged, stays last.
- Update `PageHero` copy so it reads as the shop landing (juices-first), with bundles framed as an
  add-on below. Keep SEO head as-is (or update title/description to match if trivially adjacent).
- Keep "Order Now" pointing at `/shop` (no Nav change needed).

**Tests / verification:** presentational; no component test harness. Verify `pnpm lint` +
`pnpm typecheck` clean, and (if the customer app builds standalone quickly) `pnpm --filter
@ms/customer build` succeeds. State verification approach in the report.

**Acceptance:**
- `/shop` shows the full juice catalog with working add-to-cart first, bundles second, wholesale
  last; reuses existing card/cart primitives; lint + typecheck clean.

---

## Task 4: API — edit items + edit delivery date on a confirmed order

**Goal:** Add API endpoints letting `manager`/admin edit an order's items/quantities and delivery
date after confirmation, recomputing totals from current variant prices, with a manual-reconcile
gate on paid orders.

**File:** `apps/api/src/routes/sales.ts` (new handlers, following the existing `PUT /:id/packaging`
and `PATCH /:id/delivery-address` handlers as templates). Test file: the sales route test file.

**Schema facts (no changes):**
- `saleOrder`: `subtotalNgn`, `deliveryFeeNgn`, `totalNgn`, `scheduledDeliveryAt`, `refundOwedNgn`,
  `status` (`draft|confirmed|paid|handed_over|out_for_delivery|delivered|failed|cancelled|reconcile_needed`).
- `saleOrderItem`: `productId`, `variantId`, `quantity`, `unitPriceNgn`, `lineTotalNgn`.
- Stock via `stockReservation` (per order) and `stockLedger` (variant-scoped; see cancel handler's
  restore pattern at ~line 820 using `variantId` bucket).

**Endpoint A — `PATCH /branches/:branchId/sales/:id/items`**
- Gate: `requireBranchScope()` + `requireAnyCapability("orders.manage", "pos.sell")`.
- Body (zod): `{ items: [{ productId: uuid, variantId: uuid, quantity: int>0 }], reconciled?: bool, reconcileNote?: string }`
  — `items` is the FULL desired line set.
- In a transaction:
  1. Load order; 404 if not found / wrong branch. 409 if `channel` not in `online`/`phone`.
     409 if status ∈ {`handed_over`,`out_for_delivery`,`delivered`,`failed`,`cancelled`}.
  2. Validate every `(productId, variantId)` is a currently sellable variant and fetch its current
     `unitPriceNgn` (use the same sellable/variant source the POS/catalog uses; e.g. product_variant
     price). 422 on an unknown/inactive variant.
  3. Compute desired `lineTotalNgn = unitPriceNgn * quantity` per line; `newSubtotal = Σ lineTotal`;
     `newTotal = newSubtotal + deliveryFeeNgn`.
  4. **Paid + newTotal ≠ amount paid:** require `reconciled === true`; else throw
     `BusinessError("reconcile_required", <msg>, 409)` with the delta included so the UI can prompt.
  5. Diff desired lines vs current `saleOrderItem` rows; upsert changed lines, delete removed lines,
     insert new lines (mirror the packaging diff approach — only touch changed rows).
  6. **Stock:** apply the per-`(productId,variantId)` quantity delta to `stockReservation` for this
     order. If the order is `paid` (stock already deducted), also post a `stockLedger` adjustment for
     the delta into the SAME `variantId` bucket (positive when reducing qty, negative when increasing),
     `sourceType` consistent with existing edit/adjust sources, note referencing the order number —
     exactly mirroring how the cancel handler restores stock.
  7. Persist recomputed `subtotalNgn`/`totalNgn`; `writeAudit` `sale.items_edit` with before/after
     line sets, the delta, and `reconcileNote` when present.
- Return updated order (with items) in `data`.

**Endpoint B — delivery date**
- `PATCH /branches/:branchId/sales/:id/delivery-date` (or extend the existing delivery-address
  handler if cleaner). Gate identical. Body `{ scheduledDeliveryAt: ISO string }`. Re-clamp to the
  Lagos delivery-schedule window using the SAME schedule engine used at checkout / for server-auth
  `scheduled_delivery_at` (find it — likely in `packages/domain` or a schedule lib; do not
  reimplement). 409 on `delivered`/`cancelled`. `writeAudit` `sale.delivery_date_edit`.

**Tests (targeted, TDD):**
- editing items on an unpaid (`confirmed`) order recomputes subtotal/total and adjusts reservations;
- editing items on a `paid` order WITHOUT `reconciled` → 409 `reconcile_required` with the delta;
- WITH `reconciled: true` → succeeds, posts the stock-ledger delta into the right variant bucket,
  writes audit, and does NOT create any refund/charge record;
- 409 when editing a `delivered`/`handed_over` order;
- delivery-date edit clamps to the schedule window and rejects past/too-far dates.
Run only that test file.

**Acceptance:** endpoints behave per above; manual-reconcile gate enforced; stock reservation +
ledger correct; audits written; no auto money movement; targeted tests pass; lint + typecheck clean.

---

## Task 5: Admin UI — edit items + delivery date on order detail

**Goal:** Give managers a UI on the order-detail page to edit items/quantities and delivery date,
with a paid-order confirmation dialog that shows the +/− delta and captures the manual-reconcile
acknowledgement.

**Files:** `apps/admin/src/routes/owner/order-detail.tsx` (and the branch order-detail view
`apps/admin/src/routes/branch/online-order-detail.tsx` if it should also expose editing — check
which view managers actually use; wire the same editing there if so). Reuse the sellable/size
picker used elsewhere (e.g. `lib/sellables.ts`) for adding a line.

**Change:**
1. **Editable Items card:** change line quantity, remove a line, add a line (flavour + size from
   sellables). Show a live subtotal/total preview as edits are made. Gate the card's visibility on
   the order being editable (status not in handed_over/out_for_delivery/delivered/cancelled/failed)
   and on the `orders.manage` capability so `manager` sees it.
2. **Save:** call `PATCH …/sales/:id/items` (Task 4 Endpoint A). If the order is `paid` and the new
   total differs, first open a confirm dialog showing the +/− delta and requiring the editor to (a)
   tick "I have collected / refunded this amount manually" and (b) enter a note; then resend with
   `reconciled: true` + `reconcileNote`. Handle the API's `reconcile_required` 409 by opening that
   same dialog (belt-and-suspenders).
3. **Delivery date editor** next to the existing address editor → `PATCH …/delivery-date`.
4. Use existing primitives (`api`, `humanizeError`, `ngn`, toast, existing modal/confirm component —
   e.g. `ConfirmModal` if present). Match the surrounding page's styling.

**Tests / verification:** presentational; verify lint + typecheck clean and describe a manual
click-through of the edit + paid-delta-confirm flow in the report (the reviewer will sanity-check
against Task 4's contract).

**Acceptance:** managers can edit items and delivery date from order detail; paid edits force the
delta-confirm + manual-reconcile acknowledgement; wired to Task 4 endpoints; lint + typecheck clean.

---

## Suggested execution order
1 → 2 → 3 → 4 → 5 (smallest blast radius first; Task 5 depends on Task 4's endpoints).
