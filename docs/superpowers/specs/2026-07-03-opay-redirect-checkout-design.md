# OPay redirect checkout (primary) with Payaza fallback — Design

_Date: 2026-07-03_

## Problem

The production checkout log shows the dominant online-payment failure is Payaza's
client-side popup SDK failing to open ("the payment window didn't open / is taking
longer than usual"). Across the last ~3 days of logged data, ~7 of 10 payment
failures were this class, and 6 of 8 affected customers never completed any
payment — genuinely lost sales (including a ~₦92.5k order). Payaza has **no**
hosted-redirect option; it can only render the in-page modal, so there is no
robust fallback when the modal is slow, blocked, or hidden on Nigerian mobile
browsers.

## Goal

Introduce **OPay's Cashier / Express Checkout** — a server-created, full-page
**redirect** flow — as the primary online payment path, which structurally
eliminates the "popup never opened" failure mode. Keep the existing Payaza
integration fully intact as a fallback the owner can switch back to without a
redeploy.

## Decisions (locked in during brainstorming)

- **Cutover strategy:** OPay primary, Payaza kept as fallback (not removed).
- **Fallback control:** owner toggle stored in `app_settings` (no redeploy),
  default `opay`.
- **Payment methods:** OPay's hosted Cashier page presents all methods
  (card / bank transfer / OPay wallet / USSD) and the customer picks — no
  custom method picker on our side.
- **Credentials:** owner has an OPay merchant account with Merchant ID, Public
  Key, and Secret (private) Key.

## OPay API shape (from OPay docs, to be re-verified against sandbox)

Amounts are in kobo (naira × 100), same convention as Payaza.

### Create cashier payment (redirect)
- `POST {OPAY_API_BASE}/api/v1/international/cashier/create`
  - Production base: `https://api.opaycheckout.com`
  - Sandbox base: `https://sandboxapi.opaycheckout.com`
- Headers: `Authorization: Bearer {PublicKey}`, `MerchantId: {merchantId}`,
  `Content-Type: application/json`
- Body: `{ country:"NG", reference:<our order number>, amount:{ total:<kobo>,
  currency:"NGN" }, returnUrl, callbackUrl, expireAt, userInfo:{ userName,
  userEmail, userMobile } }`
- Response: `{ code:"00000", message:"SUCCESSFUL", data:{ cashierUrl, orderNo,
  status:"INITIAL", amount } }` → redirect customer to `data.cashierUrl`.

### Query payment status (authoritative, server-to-server)
- `POST {OPAY_API_BASE}/api/v1/international/cashier/status`
- Headers: `Authorization: Bearer {HMAC-SHA512(body, PrivateKey)}`,
  `MerchantId`, `Content-Type: application/json`
- Body: `{ reference:<our order number>, country:"NG" }`
- Response: `data.status ∈ INITIAL|PENDING|SUCCESS|FAIL|CLOSE`, `data.amount.total`
  (kobo). No per-transaction fee/settlement field is documented — OPay's fee is
  taken at settlement, so per-order fee is not visible via this API.

### Callback webhook
- OPay POSTs to `callbackUrl` on terminal state (SUCCESS/FAIL/CLOSE), HMAC-signed
  with the secret key, and retries. Treated only as a **wake-up**: the money
  decision is always gated on the server-to-server status query above (identical
  safety posture to the Payaza webhook).

## Architecture

This mirrors the existing Payaza model — callback is a wake-up, the money
decision is a server-authoritative verify — so `reconcile.ts` is reused almost
unchanged.

### 1. Provider seam (server)
A thin abstraction so OPay and Payaza coexist behind one interface:

- `createCheckout(order)` → `{ kind:"redirect", url }` (OPay) **or**
  `{ kind:"popup", config }` (Payaza; existing `buildPayazaCheckoutConfig`).
- `verifyTransaction(reference)` → **normalized status**
  `{ status: "paid" | "pending" | "failed", amountNgn, feeNgn, netNgn,
  processorReference, raw }`. OPay's status maps into this; Payaza's existing
  `verifyPayazaTransaction` already produces this shape.

`applyPayazaConfirmation` is generalized to
`applyPaymentConfirmation(tx, order, normalizedStatus, processor, opts)`; the
`payment.processor` column gains a new `'opay'` value. For OPay, `feeNgn` is
`null` and `netNgn = gross`, so the existing net-vs-total reconcile check passes
and fee analytics degrade gracefully (same path as when Payaza reports no fee).

### 2. Active-provider selection
New `app_settings` key `payment_provider` ∈ `opay` | `payaza`, default `opay`,
read exactly like the existing `site_banner` key. Admin **Settings** card gains a
provider toggle (guarded by `settings.manage`, PATCH). Flipping it makes new
orders use the other provider immediately, no deploy.

### 3. Per-order provider stamp
New column `sale_order.payment_provider text` records which provider created the
order. Required so the **worker sweep**, **webhooks**, and **on-view re-verify**
verify an in-flight order against the correct API even if the owner flips the
toggle mid-flight. We query OPay status by our own `reference` (= order number),
so OPay's `orderNo` need not be persisted.

### 4. Order creation (`public-orders.ts`)
After creating the `sale_order` (which sits in `confirmed` = awaiting payment),
branch on the active provider:
- **OPay:** call cashier/create, stamp `payment_provider='opay'`, return
  `{ provider:"opay", redirectUrl: cashierUrl }`.
- **Payaza:** existing behavior — return `{ provider:"payaza", payazaConfig }`,
  stamp `payment_provider='payaza'`.

### 5. Customer side (`checkout.tsx`)
If the create response has `redirectUrl` → `window.location.href = redirectUrl`
(full-page redirect; the entire `payaza.ts` popup/watchdog is bypassed). If it
returns a Payaza config → existing popup launcher. `returnUrl` returns the
customer to `/order/:orderNumber` (tracking), whose on-view re-verify routes
through the provider seam.

### 6. Confirmation paths (all provider-aware)
- **`POST /v1/webhooks/opay`** (new): verify HMAC signature, then
  `verifyAndReconcile(reference)` via the OPay status query. Idempotent; shares
  `applyPaymentConfirmation`.
- **Worker sweep:** existing periodic re-verify of stuck `confirmed` orders,
  now dispatching to the provider named on each order.
- **On-view re-verify:** tracking-page verify routed through the seam.

## New / changed files

**New**
- `apps/api/src/payments/opay.ts` — create, status, HMAC-SHA512 signer (Node
  `crypto`), normalized-status parser.
- `apps/api/src/payments/provider.ts` — active-provider selector + `createCheckout`
  / `verifyTransaction` dispatch.
- `apps/api/src/routes/webhooks-opay.ts` — signed callback → reconcile.
- Migration — `sale_order.payment_provider` column; `'opay'` value for
  `payment.processor`.
- Admin Settings provider toggle UI.

**Changed**
- `apps/api/src/routes/public-orders.ts` — branch on provider at order creation.
- `apps/api/src/payments/reconcile.ts` — generalize `applyPayazaConfirmation` →
  `applyPaymentConfirmation`; keep Payaza call sites working.
- Worker sweep + on-view re-verify — provider-aware verify.
- `apps/customer/src/routes/checkout.tsx` — redirect vs popup on create response.

**Untouched (fallback)** — `apps/api/src/payments/payaza.ts`,
`apps/customer/src/lib/payaza.ts`, `apps/api/src/routes/webhooks-payaza.ts`
remain intact.

## Environment variables

- `OPAY_MERCHANT_ID`
- `OPAY_PUBLIC_KEY`
- `OPAY_SECRET_KEY` (private key used to sign the status query + verify callbacks)
- `OPAY_API_BASE` (default `https://api.opaycheckout.com`)
- `returnUrl` / `callbackUrl` derived from existing `PUBLIC_*_URL` env.

## Verify-during-build (flagged, not assumed)

1. **Callback signature algorithm** — docs cite HMAC-SHA512 in one place and
   "HMAC-SHA3-512" for callbacks in another. Confirm against a real sandbox
   callback. Regardless, `paid` is gated on the server-to-server status query,
   so a signature-parsing mistake can never fabricate a payment.
2. **Live field names / status casing / fee fields** — confirm against one real
   sandbox transaction (as was done for Payaza's fee field). Adjust the parser if
   OPay exposes a settlement/fee field for NGN.
3. **Amount unit for NGN** — confirmed kobo by convention; verify with the first
   sandbox transaction that `amount.total` round-trips at ×100.

## Testing

- **Unit:** HMAC-SHA512 signer (known-vector), OPay status → normalized-status
  parser (SUCCESS/FAIL/CLOSE/PENDING/INITIAL + amount), provider selector.
- **Integration:** create-with-`opay` returns a `redirectUrl` and stamps the
  order; OPay webhook → `applyPaymentConfirmation` → `paid` (+ stock move for a
  non-preorder, preorder-paid path for a preorder); per-order stamp routes the
  sweep to the right API; toggle switches which provider a new order uses.
- **Reuse:** existing reconcile/webhook integration tests cover the shared
  money path and idempotency/CAS behavior.

## Out of scope (YAGNI)

- No customer-facing payment-method picker (OPay's hosted page handles it).
- No automatic per-order fallback between providers (would reintroduce the
  fragile popup and double the tested surface).
- No removal of Payaza.
- No migration of historical Payaza orders.

## Rollout

1. Ship with `payment_provider` default `opay`, keys set on api + worker.
2. Live-test one real OPay order end-to-end (create → redirect → pay → callback →
   reconcile → tracking shows paid) before announcing.
3. If OPay misbehaves, owner flips the Settings toggle to `payaza` — instant, no
   deploy.
