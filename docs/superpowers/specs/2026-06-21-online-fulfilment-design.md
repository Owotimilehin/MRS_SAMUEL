# Online-fulfilment polish — design spec

**Date:** 2026-06-21
**Branch:** `feat/online-fulfilment` (off `origin/master` @ 64ee006)
**Context:** A production audit of online-order fulfilment + delivery found that the
big items (admin delivery workstation, WhatsApp arrangement, owner-order actions)
already shipped. Three genuine gaps remain. This spec covers those three only.

## Goals

1. Remove dead customer-storefront CTAs (Nav Search + Account icons).
2. Give staff a real "awaiting fulfilment" worklist instead of relying on Telegram.
3. Stop routing every online order to the first branch; let the owner choose the
   branch that fulfils online orders.

## Non-goals

- Geographic / zone-based auto-routing (no state→branch model exists; out of scope).
- A customer-facing account/auth system or storefront search.
- Any change to the existing delivery workstation or Shipbubble flow.

---

## Gap 1 — Dead Nav icons (customer)

`apps/customer/src/components/Nav.tsx` renders a Search button and an Account
button, both desktop-only `<button>`s with no `onClick`. The storefront has no
search and no customer account system, so wiring them is YAGNI.

**Fix:** delete both buttons (and now-unused `Search` / `User` lucide imports).
The cart button and "Order Now" CTA stay.

**Verification:** the two `aria-label="Search"` / `aria-label="Account"` buttons no
longer render; cart + Order Now unaffected; no unused-import lint errors.

---

## Gap 2 — "Awaiting fulfilment" worklist (admin)

Online orders that are paid but not yet handed over / delivered have no dedicated
view. `branch/queue` is the offline **sync outbox**, not an order worklist.

**Fix (no new route, no migration):**
- **Owner Orders** (`apps/admin/src/routes/owner/orders.tsx`): add an "Awaiting
  fulfilment" StatHero chip (count) and a one-click quick-filter that narrows the
  table to orders matching the predicate below. Reuses the existing filter state.
- **Branch Sales** (`apps/admin/src/routes/branch/sales.tsx`): same chip + filter,
  scoped to that branch.

**Predicate (an order "awaits fulfilment"):**
`channel === "online"` AND `status === "paid"` AND not (`handed_over` | `delivered` | `cancelled` | `failed`).
(`paid` is the terminal-payment state; once a delivery is booked/handed the status
advances past `paid`, so the predicate is simply `online` + `paid`.)

**Verification:** seeding an online `paid` order makes the chip count = 1 and the
quick-filter shows it; a `delivered` online order is excluded; a `walkup`/`paid`
till sale is excluded.

---

## Gap 3 — Owner-selected online-fulfilment branch

`apps/customer/src/routes/checkout.tsx` hardcodes `branches[0]`. The server
(`public-orders.ts`) trusts the client `branch_id`. With >1 branch, every online
order silently lands on whichever branch sorts first.

**Fix:**
- **DB (migration `0054_branch_online_default`, `when` 1782980000000):** add
  `is_online_default boolean NOT NULL DEFAULT false` to `branch`. Add the journal
  entry. Rebuild `@ms/db`.
- **Schema:** add `isOnlineDefault` to `packages/db/src/schema/branch.ts`.
- **API catalog (`public-catalog.ts`):** include `is_online_default` in each branch
  in the `/v1/public/catalog/branches` payload.
- **Customer checkout:** pick `branches.find(b => b.is_online_default) ?? branches[0]`.
  Mapper/type updated to carry the flag. No UX change for the customer.
- **Admin (owner Branches list `apps/admin/src/routes/owner/branches.tsx`):** a
  radio/"Set as online default" control per branch that calls the existing branch
  update endpoint with `is_online_default`. Setting one clears the others
  (single default). Owner-only; reuses existing branch-edit capability.
- **API branch update:** accept `is_online_default`; when set true, unset it on all
  other branches in the same transaction so exactly one branch is the default.

**Invariant:** at most one branch has `is_online_default = true`. If none is set,
checkout falls back to `branches[0]` (current behaviour) — safe default.

**Verification (integration):** PATCH branch B `is_online_default=true` then PATCH
branch C true → B is now false, C true (only one default). Catalog payload exposes
the flag. Checkout selection picks the flagged branch in a unit test.

---

## Rollout

- TDD per gap; full quality gates (lint 0 / typecheck clean / affected tests green,
  `TZ=UTC`) before push.
- FF-push `feat/online-fulfilment` → `master`; prod auto-deploys via `deploy.yml`.
- Post-deploy: owner must open Branches and pick the online-default branch (until
  then, behaviour is unchanged = branches[0]). PWA hard-refresh for the new bundle.

## Risk notes

- Migration number `0054` is free on `origin/master` (latest = `0053`). The stashed
  perf WIP also uses `0054`; whichever lands second renumbers — they are not on
  master, so no live collision now.
- `branches[0]` fallback means the feature is inert until the owner sets a default,
  so deploy carries no behavioural surprise.
