# Workstream D: Preorders (prepaid, fulfil-later) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A customer (online) or staff (in-store) can place a **prepaid** order for an item that isn't made yet; payment is captured but **no stock is deducted** until staff **fulfil** it on production day — at which point stock deducts and the order proceeds to hand-over/delivery.

**Architecture:** Reuse the existing order pipeline. A line is a *preorder line* when its variant is flagged `preorder_only` OR the branch is currently out of stock for it. An order with any preorder line is marked `is_preorder=true`, **skips the availability check + skips the stock reservation** at creation, but still requires payment. Payment confirmation (OPay webhook online; admin `/pay` in-store) reaches `paid` **without** posting the negative stock ledger and **without** requesting dispatch. A new admin **Preorders queue** lists `paid + is_preorder + fulfilled_at IS NULL`; a **Fulfil** action posts the stock deduction *then*, sets `fulfilled_at`, and transitions the order onward (hand-over for walk-up, out-for-delivery/delivery for online). If stock is still insufficient at fulfil time, it blocks.

**Status model (approved):** flag `is_preorder` + `fulfilled_at` + `fulfilled_by_user_id`; reuse existing `paid` status (no new enum value). Queue = `status='paid' AND is_preorder AND fulfilled_at IS NULL`.
**Trigger (approved):** `product_variant.preorder_only` OR currently out-of-stock.

**Tech Stack:** TS, Hono, Drizzle, Postgres (hand-written migrations), React + TanStack (admin), TanStack Start SSR (customer), Zod, Vitest.

**Branch:** `master`, worktree `C:\Users\owoti\Desktop\MRS SAMUEL FRUIT JUICE\mrs-samuel`. Local DB `postgres://ms:ms@localhost:5432/ms_dev`. Latest migration `0045` → this is `0046`.

---

## Background facts (verified on master)

- **Customer "preorder" today is UI-only**: `apps/customer/src/lib/cart.tsx` hardcodes `PREORDER_SIZE="330ml"`, `isPreorderSize`, `hasPreorder`; it just forces scheduled delivery. No backend modeling.
- **Order creation blocks on stock**: `apps/api/src/routes/public-orders.ts:380-391` calls `availableAtBranch(tx,{branchId,productId})` and throws `422 insufficient stock`; `:441` inserts a `stockReservation`. The admin POS path `apps/api/src/routes/sales.ts:173-184,231-238` does the same.
- **Payment deducts stock**: OPay webhook `apps/api/src/routes/webhooks-opay.ts:81-92` posts negative `stockLedger` + deletes reservation on SUCCESS, sets `paid`, then (if not scheduled/outside-Lagos) emits `delivery.request`. Admin POS `/pay` `sales.ts:268-293` does the same synchronously.
- **`availableAtBranch`** (`packages/domain/src/availability.ts:14`) is product-level; returns `balance - active reservations`. Good enough for the out-of-stock trigger.
- **`saleStatus` enum** already has `paid, handed_over, out_for_delivery, delivered, ...`. **`saleOrder`** already has `scheduledDeliveryAt`. We ADD `isPreorder`, `fulfilledAt`, `fulfilledByUserId`.
- **Customer catalog** `apps/api/src/routes/public-catalog.ts` `variantsByProduct` builds the variant array the storefront consumes (`{id,size_ml,sku,price_ngn}`); we add `preorder_only`.
- **Capabilities** in `packages/shared/src/permissions.ts`; orders managed under `orders.manage` / `pos.sell`. Fulfilment uses `orders.manage`.
- Run heavy API integration test files INDIVIDUALLY (known testcontainer-under-load artifact).

---

## File Structure

| File | Change |
|---|---|
| `packages/db/migrations/0046_preorders.sql` + journal | Create: `product_variant.preorder_only`; `sale_order.is_preorder/fulfilled_at/fulfilled_by_user_id`; seed all 330ml variants `preorder_only=true` |
| `packages/db/src/schema/product-variant.ts`, `sale-order.ts` | Add columns |
| `packages/db/src/seed.ts` | Flag 330ml variants preorder_only on seed |
| `apps/api/src/routes/public-orders.ts` | Preorder-aware create (skip stock check + reservation; mark is_preorder) |
| `apps/api/src/routes/sales.ts` | Same for admin POS create; `/pay` skips deduct for preorder |
| `apps/api/src/routes/webhooks-opay.ts` | Online payment: skip deduct + skip dispatch for preorder |
| `apps/api/src/routes/preorders.ts` | New: GET queue + PATCH `:id/fulfil` |
| `apps/api/src/app-routes` (wherever routes mount) | Mount `/v1/preorders` |
| `apps/api/test/integration/preorders.test.ts` | New tests |
| `apps/customer/src/lib/api/*` (types/mappers), `cart.tsx`, `ProductDetail.tsx`, `checkout.tsx` | Thread `preorder_only`; replace 330ml hardcode; complete preorder checkout |
| `apps/admin/src/routes/.../preorders.tsx` + nav | New queue page + Fulfil |

---

## Task 1: Migration 0046 + schema + seed

- [ ] **Step 1:** Read `packages/db/migrations/meta/_journal.json` (last = `0045_transfer_item_variant`). New entry: next idx, tag `0046_preorders`.
- [ ] **Step 2:** Create `packages/db/migrations/0046_preorders.sql`:

```sql
-- Preorders: prepaid orders for not-yet-made items. A variant can be marked
-- preorder_only (always made-to-order); any sold-out item is also preorderable.
-- The order carries is_preorder + fulfilment metadata; stock is deducted at
-- fulfilment, not at payment.

ALTER TABLE "product_variant"
  ADD COLUMN "preorder_only" boolean NOT NULL DEFAULT false;

-- Preserve today's UX: all 330ml cans were treated as preorder.
UPDATE "product_variant" SET preorder_only = true WHERE size_ml = 330;

ALTER TABLE "sale_order"
  ADD COLUMN "is_preorder"           boolean NOT NULL DEFAULT false,
  ADD COLUMN "fulfilled_at"          timestamptz,
  ADD COLUMN "fulfilled_by_user_id"  uuid REFERENCES "admin_user"("id");

CREATE INDEX "idx_sale_order_preorder_queue"
  ON "sale_order" ("is_preorder", "status", "fulfilled_at");
```

- [ ] **Step 3:** Add the journal entry (valid JSON, correct idx/tag).
- [ ] **Step 4:** Schema — `packages/db/src/schema/product-variant.ts`: add `preorderOnly: boolean("preorder_only").notNull().default(false)`. `packages/db/src/schema/sale-order.ts`: add `isPreorder: boolean("is_preorder").notNull().default(false)`, `fulfilledAt: timestamp("fulfilled_at",{withTimezone:true})`, `fulfilledByUserId: uuid("fulfilled_by_user_id").references(()=>adminUser.id)`. (Add `boolean` to imports where missing.)
- [ ] **Step 5:** Seed — in `packages/db/src/seed.ts`, after variants are seeded/linked, set `preorderOnly=true` for 330ml variants (mirror the existing `linkVariantBottles` pattern; `UPDATE product_variant SET preorder_only=true WHERE size_ml=330` via drizzle `.update().set({preorderOnly:true}).where(eq(sizeMl,330))`).
- [ ] **Step 6:** Apply + verify against local DB: `DATABASE_URL=...ms_dev pnpm --filter @ms/db migrate`; `SELECT COUNT(*) FROM product_variant WHERE preorder_only;` ≥1; columns exist on sale_order. Build `@ms/db`.
- [ ] **Step 7:** Commit `feat(db): preorder schema + flag 330ml (0046)`.

---

## Task 2: Preorder-aware order creation (customer + admin POS)

Make both create paths treat a line as preorder when `variant.preorder_only` OR out-of-stock; mark the order `is_preorder`, skip reservation for the order, still require payment. The existing "insufficient stock" throw becomes a preorder instead.

- [ ] **Step 1 (test first):** In `apps/api/test/integration/preorders.test.ts` (new), copy auth/setup helpers from `online-order.test.ts`. Test A: POST `/v1/public/orders` for a `preorder_only` 330ml variant with **0 stock** → expect **201** (not 422), response has an order, and `is_preorder=true` (verify via DB or the order-track endpoint), and **no stock_reservation** row was created for it. Run → it FAILS today (422 insufficient stock).
- [ ] **Step 2:** In `public-orders.ts`, in the line loop, replace the hard throw. After resolving `variantId`/`productId` and price, load the variant's `preorderOnly`, compute `available = availableAtBranch(...)`, and:

```ts
        const isPreorderLine = variant.preorderOnly === true || available < it.quantity;
        // ... push line as before, and:
        if (isPreorderLine) orderIsPreorder = true;
```

Track `let orderIsPreorder = false;` before the loop. Do NOT throw on `available < quantity` anymore — instead it becomes a preorder line. Set `isPreorder: orderIsPreorder` on the `saleOrder` insert. **Only create a `stockReservation` for the order when `orderIsPreorder === false`** (skip reservations entirely for a preorder — there's nothing to reserve).

- [ ] **Step 3:** Mirror the same in `apps/api/src/routes/sales.ts` confirm handler (admin POS): preorder line detection, `isPreorder` on insert, skip reservations when preorder.
- [ ] **Step 4:** Run the test → PASS. Run `online-order.test.ts` + `sales-flow.test.ts` individually → still PASS (in-stock orders behave exactly as before; only the out-of-stock/flagged path changed). If an existing test asserted "out of stock → 422" for a now-preorderable item, update it to the new behavior and note why.
- [ ] **Step 5:** Typecheck API. Commit `feat(api): preorder-aware order creation (skip stock check + reservation)`.

---

## Task 3: Payment without stock deduction for preorders

- [ ] **Step 1 (test):** Add to `preorders.test.ts`: place an online preorder (Task 2), simulate OPay SUCCESS by POSTing the webhook (mock mode confirms SUCCESS — see how `online-order.test.ts` drives payment), then assert: order `status='paid'`, `is_preorder=true`, **no negative stock_ledger row** for it, and **no `delivery.request` outbox event**. Run → FAILS today (webhook deducts stock).
- [ ] **Step 2:** In `webhooks-opay.ts`, inside the SUCCESS transaction, wrap the stock-deduction loop + reservation delete + the `delivery.request` emit so they are **skipped when `o.isPreorder`**:

```ts
      if (!o.isPreorder) {
        for (const it of items) { /* existing negative stockLedger insert */ }
        await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, o.id));
      }
      // payment insert + status→paid stay unchanged (preorder still becomes paid)
      // ... later, dispatch bypass:
      const bypass = o.isPreorder || o.scheduledDeliveryAt != null || outsideLagos;
```

Emit a distinct `sale.preorder_paid` outbox event when `o.isPreorder` (so the owner is notified a preorder is awaiting fulfilment); keep `sale.paid_online` for normal orders.

- [ ] **Step 3:** Mirror in the admin POS `/pay` handler (`sales.ts`): when the order `isPreorder`, set it to `paid` + record payment but **skip the negative stockLedger loop + reservation delete**.
- [ ] **Step 4:** Run the test → PASS; re-run `online-order.test.ts` individually → PASS. Typecheck. Commit `feat(api): preorders reach paid without deducting stock or dispatching`.

---

## Task 4: Preorders queue + fulfil API

- [ ] **Step 1 (test):** Add to `preorders.test.ts`: after a paid preorder exists (Tasks 2-3), `GET /v1/preorders` (as owner) lists it. Then give the branch stock for the item (record a transfer-receive or directly post a positive stock_ledger via a production/adjustment helper the other tests use), and `PATCH /v1/preorders/:id/fulfil` → expect 200, order `fulfilled_at` set, a negative `stockLedger` row now posted (stock deducted), status moved on (`handed_over` for walk-up channel, or `out_for_delivery`/`delivered` left to existing flow for online — for the test assert `fulfilled_at` set + stock deducted). Also: fulfilling when stock is still 0 → **422** "not enough stock to fulfil". Run → FAILS (route doesn't exist).
- [ ] **Step 2:** Create `apps/api/src/routes/preorders.ts`:
  - `GET /` (cap `orders.manage`): list `sale_order` where `is_preorder AND status='paid' AND fulfilled_at IS NULL`, newest first, with items + customer; optional `?branch_id=`.
  - `PATCH /:id/fulfil` (cap `orders.manage`): in a tx — load order (404 if missing; 409 if not a paid unfulfilled preorder); for each item, check `availableAtBranch >= quantity` (gather shortfalls → 422 `preorder_unfulfillable` with shortfalls if any); post negative `stockLedger` (sourceType `sale`, the deduction deferred from payment); set `fulfilledAt=now`, `fulfilledByUserId=auth.userId`; for a walk-up/whatsapp/chowdeck channel set `status='handed_over'`, for online/phone leave `paid` and emit `delivery.request` (reuse existing dispatch path) so the normal delivery flow runs; write audit + outbox `sale.preorder_fulfilled`.
- [ ] **Step 3:** Mount it where other routes mount (find the mount file — same place `/v1/public/orders` and `/v1/transfers` are wired; for the real app, mirror `test-app.ts`). Add `orders.manage` is already a capability.
- [ ] **Step 4:** Run tests → PASS (run file alone). Typecheck. Commit `feat(api): preorders queue + fulfil (deduct stock on fulfilment)`.

---

## Task 5: Customer frontend — real preorder, completable checkout

- [ ] **Step 1:** API: in `public-catalog.ts` `variantsByProduct`, add `pv.preorder_only` to the SELECT and to each pushed variant object (`preorder_only: v.preorder_only`). Update `CatalogProductOut["variants"]` + `CatalogVariantRow` types.
- [ ] **Step 2:** Customer types/mappers (`apps/customer/src/lib/api/types.ts` + `mappers.ts`): thread `preorder_only` onto the variant/Product model. READ these files to match the existing mapping shape; expose a per-size preorder flag the UI can read.
- [ ] **Step 3:** `apps/customer/src/lib/cart.tsx`: replace the hardcoded `PREORDER_SIZE="330ml"` / `isPreorderSize(size)` with a flag-driven check — a size is preorder when the product's variant for that size has `preorder_only` true. Keep `hasPreorder` (now derived from the real flag). The cart item's `preorder` field is set from the real flag at add-time. (Keep the `quickAddSize` "default to deliverable big can" behavior, but base "deliverable" on `!preorder_only` rather than size.)
- [ ] **Step 4:** `ProductDetail.tsx`: the "Preorder" badge + "made to order" copy now read the flag (already call `isPreorderSize` — point them at the flag). `checkout.tsx`: the existing `hasPreorder` → forces scheduled delivery (keep). The order POST already works once the backend accepts it (Task 2); ensure the confirmation copy says a preorder was placed.
- [ ] **Step 5:** Typecheck customer (`pnpm --filter @ms/customer exec tsc -b` or repo `pnpm typecheck`). Commit `feat(customer): flag-driven preorder + completable preorder checkout`.

---

## Task 6: Admin frontend — Preorders queue + Fulfil

- [ ] **Step 1:** Read an existing admin list page (e.g. `apps/admin/src/routes/owner/orders.tsx`) for the data-loading + table pattern and the nav/route registration.
- [ ] **Step 2:** Create `apps/admin/src/routes/owner/preorders.tsx`: load `GET /v1/preorders`, render a table (order #, customer, items, scheduled day, total). Each row has a **Fulfil** button → `PATCH /v1/preorders/:id/fulfil`; on success refresh; on 422 `preorder_unfulfillable` show the shortfall toast (the app has toasts now). Register the route + a nav entry next to Orders, gated on `orders.manage`.
- [ ] **Step 3:** Typecheck + lint. Commit `feat(admin): preorders queue + fulfil action`.

---

## Task 7: End-to-end verification (folded-in, on the running app)

- [ ] **Step 1:** Boot API on a fresh port + customer SSR + admin against `ms_dev`. (If full browser drive is impractical, drive the API surface the frontends call — the same way the preorder gap was proven — and capture responses.)
- [ ] **Step 2:** Customer path: place a **Lemon Sip 330ml preorder** (0 stock) → now **201** + OPay/mock URL; simulate payment SUCCESS → order `paid`, `is_preorder`, no stock moved. Capture.
- [ ] **Step 3:** Admin path: order appears in **Preorders queue**; give the branch stock; **Fulfil** → stock deducts, `fulfilled_at` set, order proceeds. Capture. Also confirm fulfil with 0 stock → blocked 422.
- [ ] **Step 4:** Regression smoke: a normal in-stock online order still reserves + deducts on payment exactly as before (not a preorder).
- [ ] **Step 5:** Report PASS/FAIL with captures.

---

## Self-Review Notes

- **Spec D coverage:** prepaid + no-stock-deduct-until-fulfil → T2/T3/T4; `preorder_only` flag + out-of-stock trigger → T1/T2; fulfilment queue + reconcile-on-production-day → T4/T6; online + in-store channels → T2/T3 (both create+pay paths); customer + admin UI → T5/T6.
- **Reuse:** no new availability function; existing `availableAtBranch` + the existing dispatch/outbox paths are reused.
- **Type consistency:** `isPreorder`/`fulfilledAt`/`fulfilledByUserId` (schema) and `preorderOnly` used identically across T1-T6. Queue predicate `is_preorder AND status='paid' AND fulfilled_at IS NULL` used in T4 + T6.
- **No new status enum value** (approved): preorder lives as `paid` + flags.
