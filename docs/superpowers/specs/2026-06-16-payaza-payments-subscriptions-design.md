# Payaza Payments + Native Recurring Subscriptions — Design

**Date:** 2026-06-16
**Status:** Approved (design); pending spec review → implementation plan

## Summary

Replace the (mock-only, never-live) OPay integration with **Payaza** as the sole
payment provider, covering **both**:

- **Workstream A — one-time purchases** (the existing cart/checkout flow).
- **Workstream B — native recurring subscriptions** (a new subsystem; today's
  "subscription" is lead-capture only, with no billing).

Both workstreams share one Payaza provider module. Payaza runs on **test keys
first** (`PZ78-SKTEST-…` from `PayazaTestKeys.md`), live keys swapped in later —
same path used for the Shipbubble live cutover.

### Decisions locked

| Topic | Decision |
|---|---|
| OPay | **Fully replaced** — OPay session/webhook/refund/smoke files deleted (recoverable from git) |
| Payment confirmation | **Re-verify via Payaza API** on webhook (verify signature **and** authoritative status read) before marking paid |
| Subscription billing | **Payaza native recurring/plans** (card mandate authorized once; Payaza charges each cycle + fires lifecycle webhooks) |
| Cycle fulfilment | **Auto-create order, staff fulfil manually** — each successful charge spawns a subscription `sale_order` into the existing preorder-style staff queue (paid; stock deducted on fulfilment) |
| Lead capture | **Replaced** with self-serve Payaza checkout; old lead form + `subscription.requested` ping retired |
| Past-due grace | **7 days** in `past_due` before auto-cancel (default; adjustable) |
| Customer self-service subscription management | **Fast-follow / out of initial scope** — initial scope is subscribe + admin-side management/cancel |
| Sequencing | **A first** (small, unblocks live one-time payments), then **B** (builds on A's provider module) |

### Capability confirmation
Payaza supports recurring billing / subscription plans and payment links via API
+ dashboard (Payaza platform description; TechCabal coverage 2023-09-25). Exact
endpoints, auth-header format, recurring/plan API shape, and webhook event
names + signature scheme are **pinned as implementation open items** — confirmed
via `payaza-smoke.ts` + the Payaza dashboard, never assumed.

---

## Workstream A — One-time purchase swap (OPay → Payaza)

### A1. Provider module — `apps/api/src/payments/payaza.ts`
Self-contained, mirrors the *shape* of the current `opay.ts` so call sites barely
change. Exposes:

- `createPayazaSession({ amountNgn, email, reference, returnUrl, callbackUrl, productName, customerName?, customerPhone? })` → `{ reference, authorization_url }`.
  Initiates Payaza hosted checkout; returns the redirect URL.
  **Dev/mock shim:** if `PAYAZA_SECRET_KEY` unset → return `?mock=1` loopback URL
  so local checkout stays clickable (same pattern as today).
- `verifyPayazaTransaction(reference)` → `{ status, amountNgn, processorReference }`.
  Authoritative server-to-server re-verify. Mock shim → `SUCCESS` / `null` amount when no keys.
- `refundPayaza({ processorReference, amountNgn })` → `{ refund_reference }`.
- `verifyPayazaSignature(rawBody, signature)` — HMAC-SHA512, constant-time (`timingSafeEqual`).

### A2. Webhook — `/v1/webhooks/payaza`
Keep the **entire** current `webhooks-opay.ts` business body unchanged: stock
ledger on paid, amount-mismatch → `reconcile_needed` + `sale.amount_mismatch`
event, preorder-aware capture (no stock move until fulfilment), `delivery.request`
bypass for preorder / scheduled / outside-Lagos. Swap only the two provider bits:
1. verify the Payaza signature on the raw body,
2. call `verifyPayazaTransaction` instead of `queryOpayOrder`.

`payment.processor` = `"payaza"`. (One-time transactions are dispatched here by
event-type; see B3 for the shared dispatcher.)

### A3. Swap call sites; remove OPay
- `apps/api/src/routes/public-orders.ts` → `createPayazaSession` (callback `…/v1/webhooks/payaza`).
- `apps/api/src/test-app.ts` → register `payazaWebhookRoutes`; drop OPay route. Delivery webhooks (Shipbubble/Bolt) untouched.
- `apps/worker/src/outbox.ts` + `apps/worker/src/payments/` → `payaza-refund.ts` replaces `opay-refund.ts`; `payment.refund_request` handler + "Calling OPay" Telegram copy → Payaza.
- `packages/shared/src/env-keys.ts` → replace the 5 `OPAY_*` keys with the `PAYAZA_*` set.
- **Delete:** `apps/api/src/payments/opay.ts`, `apps/api/src/routes/webhooks-opay.ts`, `apps/worker/src/payments/opay-refund.ts`, `apps/api/scripts/opay-smoke.ts`.

### A4. Env / keys
Add to `.env` + `.env.production.example`: `PAYAZA_SECRET_KEY`, `PAYAZA_PUBLIC_KEY`,
`PAYAZA_WEBHOOK_SECRET`, `PAYAZA_API_BASE`. Wire **test** keys from
`PayazaTestKeys.md` so the flow runs end-to-end in Payaza test mode.

### A5. Customer copy
`apps/customer/src/routes/checkout.tsx`: "via OPay" → "via Payaza" (2 strings).
Redirect mechanism unchanged (generic `authorization_url`).

---

## Workstream B — Native recurring subscriptions

### B1. Data model (new migration; add to `migrations/meta/_journal.json`)
- `subscription_plan` (existing) — add `payaza_plan_code text` (Payaza-side plan id;
  null until synced). Keep existing `period`; add `bottles_per_cycle integer` if the
  fulfilment order needs an explicit quantity beyond `bottles_label`.
- **`customer_subscription`** (new) — one row per subscription instance:
  `id`, `customer_id`, `plan_id`, price/period **snapshot** (`price_ngn`, `period`),
  `payaza_subscription_code`, `payaza_customer_ref`,
  `status` (`pending | active | past_due | paused | cancelled | expired`),
  `current_period_start`, `current_period_end`, `next_charge_at`,
  `created_at`, `activated_at`, `cancelled_at`, `updated_at`.
- **`subscription_charge`** (new) — the invoice/charge ledger; one row per attempt:
  `id`, `subscription_id`, `period_start`, `period_end`, `amount_ngn`,
  `status` (`success | failed`), `processor_reference`,
  `sale_order_id` (the fulfilment order it spawned, nullable),
  `failure_reason`, `attempted_at`.

### B2. Subscribe flow (self-serve)
`apps/api/src/routes/public-subscriptions.ts` becomes a real subscribe endpoint:
customer picks a plan → create a Payaza subscription/checkout (authorize card +
set up mandate) → insert `customer_subscription` in `pending` → return
`authorization_url` → redirect (reuses the cart's generic redirect). Activation
is driven by webhook, not the redirect return. Old lead form +
`subscription.requested` outbox path removed. Turnstile + rate-limit retained on
the subscribe endpoint.

### B3. Webhook dispatcher — "all manner of subscription"
`/v1/webhooks/payaza` is **one route** that, after signature verification,
**dispatches by event type** through a normalizer (Payaza event names → internal
state machine) with an **idempotency guard** keyed on Payaza's event/transaction
id (a processed-event table or unique constraint). Coverage:

| Lifecycle event (normalized) | Action |
|---|---|
| subscription created / activated | `customer_subscription` → `active`; set `current_period_*` + `next_charge_at` |
| **recurring charge success** | insert `subscription_charge(success)`; advance period; **auto-create `sale_order` (subscription-flagged) into staff-fulfil queue** (paid; stock NOT moved yet); link `sale_order_id`; emit owner ping |
| recurring charge failed | insert `subscription_charge(failed)`; → `past_due`; notify customer (update card) + owner |
| subscription cancelled / expired | → `cancelled` / `expired`; stop billing |
| card expiring / mandate problem | notify customer to update card |
| one-time transaction success (non-subscription) | existing order-paid logic (Workstream A2) |

Money decision re-verified via status read where Payaza exposes one; signature
verified on every call.

### B4. Cycle fulfilment (auto-order, manual fulfil)
Each successful recurring charge spawns a `sale_order` flagged subscription,
landing in the **same staff queue as preorders** — paid, stock deducted only when
staff fulfil it (reuse preorder fulfilment machinery in `preorders.ts`). No new
fulfilment UI built from scratch. Delivery for the cycle is created by staff at
fulfilment time (or via the existing dispatch path if the order qualifies).

### B5. Failure / dunning
Lean on Payaza's native retry schedule. On its final-failure webhook →
`customer_subscription.status = past_due`, notify customer (update card) + owner.
A small worker cron sweeps `past_due` rows older than **7 days** → `cancelled`
(reuses the `runDueCronJobs` / `cron_run` pattern; `nowLagos()` for time).

### B6. Cancellation / pause
Authenticated **customer** + **admin** endpoint → call Payaza cancel/pause →
update local row. Admin `apps/admin/src/routes/owner/subscriptions.tsx` gains an
**active-subscriptions** view (status, next charge, charge history, cancel action)
alongside the existing plan CRUD. (Capability-gated per existing RBAC.)

### B7. Customer UI
`apps/customer/src/routes/subscription.tsx` + `components/Subscription.tsx`:
subscribe buttons → Payaza checkout. Account-page management of an active
subscription is a **fast-follow** (out of initial scope).

---

## Shared concerns

- **Provider module** centralizes Payaza auth/signing so one-time + subscription
  share it. Subscription-specific Payaza calls (create plan, create subscription,
  cancel) may live in a sibling module (e.g. `payaza-subscriptions.ts`) but reuse
  the same auth/signing primitives.
- **Idempotency:** webhook event de-dup (processed-event table or unique key) so
  replayed Payaza callbacks are no-ops — for both one-time and subscription events.
- **Env:** `PAYAZA_SECRET_KEY`, `PAYAZA_PUBLIC_KEY`, `PAYAZA_WEBHOOK_SECRET`,
  `PAYAZA_API_BASE` (+ allowlist in `env-keys.ts`). Test keys first.

## Testing
- **Unit:** provider mock-shim (all functions), signature verify (good / bad /
  tampered), event normalizer mapping.
- **Integration:**
  - One-time webhook (repointed): paid→ledger, amount-mismatch→`reconcile_needed`,
    preorder→no stock move, in-Lagos→`delivery.request` emitted, idempotent replay.
  - Subscription webhook matrix: activate→`active`; renew→`subscription_charge` +
    order-in-queue; charge-fail→`past_due`; cancel→`cancelled`; idempotent replay.
  - Past-due sweeper cron: `past_due` > 7 days → `cancelled`.
- **Smoke:** `apps/api/scripts/payaza-smoke.ts` — validates real endpoints, auth
  header, signature, one-time init+verify+refund, and the recurring/plan +
  subscription create/cancel flow against **test** keys. This is where the open
  items are confirmed.

## Quality gates
Typecheck + lint clean repo-wide; new migration added to `_journal.json` and
`@ms/db` rebuilt; existing test baseline preserved.

## Open items (confirmed during implementation, not assumed)
1. Exact Payaza base URL + endpoint paths (init, verify, refund).
2. Auth header format (Bearer vs. `Payaza <base64>` vs. other).
3. Recurring/plan API shape — does Payaza take a pre-registered `plan_code`, or
   inline amount+interval at subscription create? Card mandate/tokenization model.
4. Webhook event names + signature header/scheme for subscription lifecycle events.
5. **Fallback:** if native recurring is weaker than advertised, switch to
   self-managed tokenized charges driven by our worker cron — surfaced immediately,
   not improvised.

## Recommended sequencing
1. Workstream A (one-time swap) — unblocks live payments off the current fake-money mock.
2. Workstream B (subscriptions) — builds on A's provider module.
